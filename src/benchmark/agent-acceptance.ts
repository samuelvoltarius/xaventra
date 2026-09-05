import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export interface AcceptanceObservation {
    id: string; passed: boolean; durationMs: number; modelCalls: number
    verifiedTools: number; stages: string[]; checks: Record<string, boolean>; error?: string
}

export function judgeAcceptance(result: any, expected: { contains: string[]; excludes?: string[]; minReads?: number; noTools?: boolean }): Record<string, boolean> {
    const output = String(result.output || '').toLowerCase()
    const reads = (result.tools || []).filter((tool: any) => tool.toolName === 'read_file' && tool.success === true)
    return {
        kernelValidated: result.validation?.success === true && result.status === 'completed' && !result.error,
        expectedAnswer: expected.contains.every(value => output.includes(value.toLowerCase())),
        noStaleAnswer: (expected.excludes || []).every(value => !output.includes(value.toLowerCase())),
        realToolEvidence: new Set(reads.map((tool: any) => tool.params?.path)).size >= (expected.minReads || 0),
        noUnnecessaryTools: !expected.noTools || (result.tools || []).length === 0,
        noInternalReasoning: !/<think>|<\/think>|here.s (?:a|my) thinking process|the user wants/i.test(output),
    }
}

/** Unlike subsystem probes, the model must choose tools and use their results.
 * Every turn starts a fresh worker process, so continuity tests include restart.
 * No production configuration, transcript, credentials or memory is imported. */
export async function runAgentAcceptance(baseUrl: string, model: string) {
    const projectRoot = process.cwd()
    const root = mkdtempSync(join(tmpdir(), 'xaventra-acceptance-'))
    const fixtures = join(root, 'fixtures')
    mkdirSync(fixtures)
    writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify({ name: 'Xaventra', provider: 'local', model, nodes: [], channels: {}, codex: { enabled: false } }))
    const nonce = `ORBIT-${randomUUID().slice(0, 8)}`
    writeFileSync(join(fixtures, 'project.txt'), `Project codename: ${nonce}\n`)
    writeFileSync(join(fixtures, 'stock.txt'), 'Storage A: 17 items\n')
    writeFileSync(join(fixtures, 'delivery.txt'), 'Incoming delivery: 26 items\n')
    const files = ['fixtures/project.txt', 'fixtures/stock.txt', 'fixtures/delivery.txt']
    const steps = [
        { id: 'greeting', prompt: 'Guten Abend', contains: ['abend'], noTools: true },
        { id: 'read-file', prompt: `Lies die Datei ${join(fixtures, 'project.txt')} und nenne den Projekt-Codenamen.`, contains: [nonce], requiresTool: true, minReads: 1 },
        { id: 'rest-file-request', useRest: true, prompt: `Lies die Datei ${join(fixtures, 'project.txt')} und nenne den Projekt-Codenamen.`, contains: [nonce], requiresTool: true, minReads: 1 },
        { id: 'two-tool-reasoning', prompt: `Lies beide Dateien ${join(fixtures, 'stock.txt')} und ${join(fixtures, 'delivery.txt')}. Wie viele Artikel sind es zusammen?`, contains: ['43'], requiresTool: true, minReads: 2 },
        { id: 'remember', room: 'memory', prompt: 'Für unser Projekt ist die Kennung LUMEN-OLD. Merke dir die Kennung für unser Gespräch und bestätige sie kurz.', contains: ['LUMEN-OLD'], noTools: true },
        { id: 'correct', room: 'memory', prompt: 'Korrektur: Die Projektkennung lautet jetzt LUMEN-NEW. Die vorherige Kennung ist ungültig. Bestätige nur die neue Kennung.', contains: ['LUMEN-NEW'], excludes: ['LUMEN-OLD'], noTools: true },
        { id: 'recall-after-restart', room: 'memory', prompt: 'Wie lautet unsere aktuelle Projektkennung? Antworte nur mit der Kennung aus unserem Gespräch.', contains: ['LUMEN-NEW'], excludes: ['LUMEN-OLD'], noTools: true },
        { id: 'other-user-isolation', userId: 'acceptance-other', room: 'memory', prompt: 'Wie lautet meine Projektkennung? Wenn ich dir noch keine genannt habe, sage nur: Unbekannt.', contains: ['unbekannt'], excludes: ['LUMEN-NEW', 'LUMEN-OLD'], noTools: true },
    ]
    const observations: AcceptanceObservation[] = []
    const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './agent-acceptance-worker.ts' : './agent-acceptance-worker.js', import.meta.url))
    for (const step of steps) {
        console.log(`[Acceptance] ${step.id} started (fresh process)`)
        const resultPath = join(root, `${step.id}.result.json`)
        const jobPath = join(root, `${step.id}.job.json`)
        writeFileSync(jobPath, JSON.stringify({ ...step, userId: step.userId || 'acceptance-user', root, files, baseUrl, model, resultPath }), { mode: 0o600 })
        const child = spawnSync(process.execPath, [...(worker.endsWith('.ts') ? ['--import', 'tsx'] : []), worker, jobPath], {
            cwd: projectRoot, timeout: 60_000, windowsHide: true, encoding: 'utf8', maxBuffer: 2_000_000,
        })
        const result = child.status === 0 && existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : { error: 'Isolated worker failed or timed out' }
        const checks = judgeAcceptance(result, step)
        const observation = { id: step.id, passed: Object.values(checks).every(Boolean), durationMs: result.durationMs || 0,
            modelCalls: result.modelCalls || 0, verifiedTools: (result.tools || []).filter((tool: any) => tool.success === true).length,
            stages: result.stages || [], checks, error: result.error ? String(result.error).replaceAll(baseUrl, '[configured endpoint]').replaceAll(root, '[isolated runtime]') : undefined }
        observations.push(observation)
        console.log(`[Acceptance] ${step.id} ${observation.passed ? 'PASS' : 'FAIL'}; ${JSON.stringify(checks)}`)
        // Raw debugging output remains only in the disposable local runtime.
        writeFileSync(join(root, `${step.id}.worker.log`), child.stdout + child.stderr, { mode: 0o600 })
    }
    return { version: 1, evaluationKind: 'agent-workflow', model, createdAt: new Date().toISOString(),
        scope: 'Native runner and authenticated REST adapter, real local model and real read-only tools; fresh process per turn. Not a live Telegram, complete daemon or distributed failover test.',
        passed: observations.every(item => item.passed), scenarios: observations.length,
        passedScenarios: observations.filter(item => item.passed).length, observations }
}
