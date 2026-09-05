import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'

interface IdentifiedRecord {
    id?: string
    wasCorrect?: boolean
}

function valueAfter(flag: string): string {
    const index = process.argv.indexOf(flag)
    return index >= 0 ? String(process.argv[index + 1] || '') : ''
}

function readRecords(path: string): IdentifiedRecord[] {
    if (!existsSync(path)) return []
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(value)) throw new Error(`${path} does not contain an array`)
    return value
}

function atomicJson(path: string, value: unknown): void {
    const temporary = `${path}.maintenance.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2))
    renameSync(temporary, path)
}

async function main(): Promise<void> {
    const exampleId = valueAfter('--example-id')
    const correctionId = valueAfter('--correction-id')
    const apply = process.argv.includes('--apply')
    if (!exampleId || !correctionId) {
        throw new Error('Usage: cleanup:correction-misattribution --example-id <id> --correction-id <id> [--apply]')
    }

    const dataRoot = getNovaDataDir()
    const projectRoot = process.cwd()
    const examplesPath = join(dataRoot, 'tool-examples.json')
    const correctionsPath = join(projectRoot, '.nova-learning', 'corrections.json')
    const examples = readRecords(examplesPath)
    const corrections = readRecords(correctionsPath)
    const example = examples.find(record => record.id === exampleId)
    const correction = corrections.find(record => record.id === correctionId)

    if (example && example.wasCorrect !== false) {
        throw new Error(`Refusing to remove ${exampleId}: tool example is not marked incorrect`)
    }

    const summary = {
        mode: apply ? 'apply' : 'dry-run',
        exampleId,
        correctionId,
        foundToolExample: Boolean(example),
        foundCorrection: Boolean(correction),
        preservesRawMessages: true,
        touchesToolHealth: false,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (!apply || (!example && !correction)) return

    const stamp = Date.now()
    const backupDir = join(dataRoot, 'maintenance-backups', `correction-misattribution-${stamp}`)
    mkdirSync(backupDir, { recursive: true })
    if (existsSync(examplesPath)) copyFileSync(examplesPath, join(backupDir, basename(examplesPath)))
    if (existsSync(correctionsPath)) copyFileSync(correctionsPath, join(backupDir, basename(correctionsPath)))

    atomicJson(examplesPath, examples.filter(record => record.id !== exampleId))
    atomicJson(correctionsPath, corrections.filter(record => record.id !== correctionId))

    const auditDir = join(dataRoot, 'maintenance')
    mkdirSync(auditDir, { recursive: true })
    const auditPath = join(auditDir, `correction-misattribution-${stamp}.json`)
    atomicJson(auditPath, {
        ...summary,
        completedAt: new Date().toISOString(),
        backupDir,
        auditFile: basename(auditPath),
    })
    console.log(`Cleanup complete; audit: ${auditPath}`)
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
