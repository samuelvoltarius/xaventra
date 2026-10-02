import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 2.86 Punkt 6: Ein Leerlauf-Lerner (L9). Der zweite (proactive-learning) hing
// „Soll ich lernen …?“ an Werkzeugergebnisse und schickte SSH-Fehler mit Host
// und Benutzer als Suchanfrage an Tavily. Regel: Privates nie in die Cloud —
// Suchanfragen nur aus Werkzeugnamen, redigiert, bevorzugt über SearXNG.

const HOST = 'build.example.com'
const USER = 'alice'

const tavilyHandler = vi.fn(async (_params: any) => ({ results: [] }))
vi.mock('../tools/tavily-search.js', () => ({ tavilySearchTool: { name: 'tavily_search', handler: tavilyHandler } }))

const registryExecute = vi.fn(async (_name: string, _params: any) => ({ results: [{ title: 'Treffer', url: 'https://docs.example.com/a', snippet: 'Ein hilfreicher Ausschnitt über Fehler und Lösungen.' }] }))
vi.mock('../tools/complete-registry.js', () => ({
    getToolRegistry: () => ({ get: (name: string) => (['browser_search', 'web_search'].includes(name) ? { name } : undefined), execute: registryExecute }),
}))

// SSH ohne echtes Netz: jeder Verbindungsversuch läuft in den Timeout.
vi.mock('node:child_process', async (importOriginal) => {
    const original: any = await importOriginal()
    return {
        ...original,
        execFileSync: vi.fn(() => {
            const error: any = new Error(`ssh: connect to host ${HOST} port 22: Connection timed out (ETIMEDOUT)`)
            error.status = 255
            throw error
        }),
    }
})
vi.mock('../core/environment.js', () => ({
    detectEnvironment: () => ({ os: 'linux', hasSSH: true, hasPlink: false, hasSshpass: false, hasSSHKey: false }),
    autoInstall: vi.fn(),
}))
vi.mock('../tools/ssh-tool-hosts.js', () => ({ loadHosts: () => ({ hosts: [] }), saveHosts: vi.fn(), resolveHostPassword: () => undefined }))

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'ein-leerlauf-lerner-'))
let fetchSpy: ReturnType<typeof vi.fn>

function outbound(): string {
    return JSON.stringify([tavilyHandler.mock.calls, registryExecute.mock.calls, fetchSpy.mock.calls])
}

beforeAll(() => { vi.stubEnv('NOVA_RUNTIME_ROOT', root) })
afterAll(() => { vi.unstubAllEnvs() })
beforeEach(() => {
    tavilyHandler.mockClear(); registryExecute.mockClear()
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => { vi.unstubAllGlobals(); vi.stubEnv('NOVA_SEARXNG_URL', '') })

async function idleManager(): Promise<any> {
    const { getIdleLearningManager } = await import('./L9-idle-learning.js')
    const manager: any = getIdleLearningManager()
    manager.lastActivity = Date.now() - 60 * 60 * 1000
    manager.isLearning = false
    return manager
}

describe('ein Leerlauf-Lerner', () => {
    it('der Runner hängt keine „Soll ich lernen …?“-Frage an Werkzeugergebnisse, der zweite Lerner ist weg', () => {
        const runner = readFileSync(src('../agents/nova-runner.ts'), 'utf8')
        expect(runner).not.toMatch(/proactive-learning|generatePostToolLearningPrompt/)
        expect(existsSync(src('../intelligence/proactive-learning.ts'))).toBe(false)
        for (const file of ['../tools/ssh-tool.ts', '../intelligence/autonomy-engine.ts', '../core/autonomy-loop.ts', './L9-idle-learning.ts']) {
            expect(readFileSync(src(file), 'utf8'), file).not.toMatch(/proactive-learning/)
        }
    })

    it('ein SSH-Fehler mit Host und Benutzer landet in keiner Suchanfrage', async () => {
        const { executeSSH } = await import('../tools/ssh-tool.js')
        const result = await executeSSH({ host: HOST, user: USER, command: 'uptime' })
        expect(result.success).not.toBe(true)
        const manager = await idleManager()
        manager.patterns = new Map()
        await manager.checkAndLearn()
        expect(outbound()).not.toContain(HOST)
        expect(outbound()).not.toContain(USER)
        expect(tavilyHandler).not.toHaveBeenCalled()
    })

    it('Leerlauf ohne Themen: keine Rückfrage an Alfred', async () => {
        const manager = await idleManager()
        manager.patterns = new Map()
        const notify = vi.fn(async () => {})
        manager.notifyCallback = notify
        if (typeof manager.setNotifyCallback === 'function') manager.setNotifyCallback(notify)
        await manager.checkAndLearn()
        expect(notify).not.toHaveBeenCalled()
        expect(outbound()).toBe('[[],[],[]]')
    })

    it('Thema nur aus dem Werkzeugnamen, über die gesteuerte Suchkette statt Tavily direkt', async () => {
        const manager = await idleManager()
        manager.knowledge = []
        manager.patterns = new Map([['ssh_command', { tool: 'ssh_command', count: 3, lastUsed: Date.now(), errors: 1 }]])
        await manager.checkAndLearn()
        expect(tavilyHandler).not.toHaveBeenCalled()
        expect(registryExecute).toHaveBeenCalled()
        expect(registryExecute.mock.calls[0][1]).toMatchObject({ query: 'ssh_command common errors solutions' })
        expect(manager.getStats().knowledgeCount).toBe(1)
    })

    it('mit SearXNG geht die Anfrage an die lokale Suche, nicht in die Cloud-Kette', async () => {
        vi.stubEnv('NOVA_SEARXNG_URL', 'http://searx.example.com')
        fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ results: [{ title: 'Lokal', url: 'https://docs.example.com/b', content: 'Lokaler Treffer über Docker-Fehler und Lösungen.' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
        const manager = await idleManager()
        manager.knowledge = []
        manager.patterns = new Map([['docker_ps', { tool: 'docker_ps', count: 2, lastUsed: Date.now(), errors: 0 }]])
        await manager.checkAndLearn()
        expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/^http:\/\/searx\.example\.com\/search\?/)
        expect(registryExecute).not.toHaveBeenCalled()
        expect(tavilyHandler).not.toHaveBeenCalled()
    })

    it('Suchanfragen werden redigiert: keine Hosts, IPs, Benutzer, Pfade, Tokens', async () => {
        const { redactIdleSearchQuery } = await import('./L9-idle-learning.js')
        const token = ['tvly-', 'dev-', 'abcdefghijklmnopqrstuvwxyz'].join('')
        const raw = `ssh ${USER}@${HOST} 10.0.0.5:22 fe80::1 /home/${USER}/.ssh/id_ed25519 C:\\Users\\${USER}\\x.txt https://intra.example.com/x token=${token} timeout`
        const query = redactIdleSearchQuery(raw)
        for (const leak of [USER, HOST, '10.0.0.5', 'fe80::1', '/home', 'C:\\', 'intra.example.com', token]) expect(query).not.toContain(leak)
        expect(query).toContain('timeout')
    })

    it('local-knowledge.json (nie gelesen) wird beim Start beiseitegelegt, nicht gelöscht', async () => {
        mkdirSync(join(root, '.nova-data'), { recursive: true })
        writeFileSync(join(root, '.nova-data', 'local-knowledge.json'), '{"error: SSH Host build.example.com":["x"]}')
        const manager = await idleManager()
        manager.start(); manager.stop()
        expect(existsSync(join(root, '.nova-data', 'local-knowledge.json'))).toBe(false)
        expect(existsSync(join(root, '.nova-data', 'local-knowledge.json.migriert'))).toBe(true)
    })
})
