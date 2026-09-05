import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import { MemoryGovernanceCoordinator } from '../memory/memory-governance.js'

interface WindowedRecord {
    id?: string
    timestamp?: number | string
    createdAt?: number
    userRequest?: string
    source?: string
    provenance?: Array<{ source?: string }>
    status?: string
}

function parseArgs(): { from: number; to: number; apply: boolean } {
    const values = new Map<string, string>()
    for (let i = 2; i < process.argv.length; i += 2) values.set(process.argv[i], process.argv[i + 1])
    const from = Number(values.get('--from'))
    const to = Number(values.get('--to'))
    const apply = process.argv.includes('--apply')
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new Error('Usage: cleanup:benchmark-memory --from <epoch-ms> --to <epoch-ms> [--apply]')
    }
    return { from, to, apply }
}

function timestamp(record: WindowedRecord): number {
    if (typeof record.createdAt === 'number') return record.createdAt
    if (typeof record.timestamp === 'number') return record.timestamp
    return Date.parse(String(record.timestamp || ''))
}

function inWindow(record: WindowedRecord, from: number, to: number): boolean {
    const value = timestamp(record)
    return Number.isFinite(value) && value >= from && value <= to
}

function atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.cleanup.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2))
    renameSync(temporary, path)
}

async function main(): Promise<void> {
    const { from, to, apply } = parseArgs()
    const dataRoot = getNovaDataDir()
    const examplesPath = join(dataRoot, 'tool-examples.json')
    const sharedPath = join(dataRoot, 'mesh-memory', 'shared.json')
    const governanceDir = join(dataRoot, 'memory', 'governance')
    const governance = new MemoryGovernanceCoordinator(governanceDir)

    const examples = existsSync(examplesPath)
        ? JSON.parse(readFileSync(examplesPath, 'utf8')) as WindowedRecord[] : []
    const shared = existsSync(sharedPath)
        ? JSON.parse(readFileSync(sharedPath, 'utf8')) as WindowedRecord[] : []
    const governed = governance.getReplicationSnapshot().filter(record =>
        inWindow(record, from, to)
        && record.status !== 'rejected'
        && record.provenance.some(item => item.source.startsWith('tool:'))
        && record.kind === 'operational')
    const exampleMatches = examples.filter(record => inWindow(record, from, to))
    const sharedMatches = shared.filter(record =>
        inWindow(record, from, to) && String(record.source || '').startsWith('governance:tool:'))

    const summary = {
        mode: apply ? 'apply' : 'dry-run', from, to,
        governance: governed.map(record => record.id),
        toolExamples: exampleMatches.map(record => record.id),
        meshCopies: sharedMatches.map(record => record.id),
    }
    console.log(JSON.stringify(summary, null, 2))
    if (!apply) return

    for (const record of governed) {
        await governance.rejectAndRetract(record.id, 'benchmark-contamination-cleanup')
    }
    atomicJson(examplesPath, examples.filter(record => !exampleMatches.includes(record)))
    atomicJson(sharedPath, shared.filter(record => !sharedMatches.includes(record)))

    const auditPath = join(dataRoot, `benchmark-cleanup-${Date.now()}.json`)
    atomicJson(auditPath, { ...summary, completedAt: new Date().toISOString(), auditFile: basename(auditPath) })
    console.log(`Cleanup complete; audit: ${auditPath}`)
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
