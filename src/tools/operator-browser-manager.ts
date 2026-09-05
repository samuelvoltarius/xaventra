import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BrowserAdapter } from './browser.js'
import { getLifecyclePolicy, type LifecyclePayload } from '../core/lifecycle-policy.js'

interface ManagedSession {
    key: string
    browser: BrowserAdapter
    lastUsedAt: number
    handoff: boolean
    timer?: ReturnType<typeof setTimeout>
}

export interface BrowserReplayEntry {
    at: string
    userKey: string
    tool: string
    input: Record<string, unknown>
    success: boolean
    output?: unknown
}

function keyFor(userId: string): string {
    return createHash('sha256').update(userId || 'system').digest('hex').slice(0, 24)
}

function redact(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [
        key,
        /password|secret|token|authorization|cookie/i.test(key) ? '[redacted]' : value,
    ]))
}

export class OperatorBrowserManager {
    private readonly sessions = new Map<string, ManagedSession>()
    private hookInstalled = false

    constructor(
        private readonly root = join(process.cwd(), '.nova-data', 'browser-operator'),
        private readonly idleMs = Number(process.env.NOVA_BROWSER_IDLE_MS || 30 * 60_000),
    ) {
        this.installAuditHook()
    }

    async getSession(userId = 'system'): Promise<BrowserAdapter> {
        const key = keyFor(userId)
        let session = this.sessions.get(key)
        if (!session) {
            const profile = join(this.root, 'profiles', key)
            const browser = new BrowserAdapter({
                headless: process.env.NOVA_BROWSER_HEADFUL !== '1',
                timeout: 30_000,
                viewport: { width: 1440, height: 900 },
                screenshotDir: join(this.root, 'screenshots', key),
                storageStatePath: join(profile, 'storage-state.json'),
                downloadDir: join(this.root, 'downloads', key),
            })
            await browser.launch()
            session = { key, browser, lastUsedAt: Date.now(), handoff: false }
            this.sessions.set(key, session)
        }
        session.lastUsedAt = Date.now()
        this.resetTimer(session)
        return session.browser
    }

    status(userId = 'system') {
        const session = this.sessions.get(keyFor(userId))
        return session ? { running: session.browser.isRunning(), handoff: session.handoff, lastUsedAt: session.lastUsedAt, userKey: session.key } : { running: false, handoff: false }
    }

    setHandoff(userId: string, enabled: boolean): void {
        const session = this.sessions.get(keyFor(userId))
        if (!session) throw new Error('No browser session exists for this user')
        session.handoff = enabled
    }

    async close(userId = 'system'): Promise<void> {
        const key = keyFor(userId)
        const session = this.sessions.get(key)
        if (!session) return
        if (session.timer) clearTimeout(session.timer)
        await session.browser.close()
        this.sessions.delete(key)
    }

    replay(userId: string, limit = 100): BrowserReplayEntry[] {
        const file = this.replayFile(keyFor(userId))
        if (!existsSync(file)) return []
        return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(1_000, limit))).flatMap(line => {
            try { return [JSON.parse(line) as BrowserReplayEntry] } catch { return [] }
        })
    }

    private resetTimer(session: ManagedSession): void {
        if (session.timer) clearTimeout(session.timer)
        session.timer = setTimeout(() => { void this.closeByKey(session.key) }, this.idleMs)
        if (session.timer.unref) session.timer.unref()
    }

    private async closeByKey(key: string): Promise<void> {
        const session = this.sessions.get(key)
        if (!session || session.handoff) return
        await session.browser.close().catch(() => undefined)
        this.sessions.delete(key)
    }

    private installAuditHook(): void {
        if (this.hookInstalled) return
        const hookScope = createHash('sha256').update(this.root).digest('hex').slice(0, 10)
        getLifecyclePolicy().register({
            id: `browser-human-handoff:${hookScope}`,
            event: 'tool.before',
            priority: 20,
            failClosed: true,
            handler: payload => {
                if (!payload.toolName?.startsWith('browser_')) return
                if (['browser_handoff', 'browser_replay', 'browser_status', 'browser_close'].includes(payload.toolName)) return
                const session = this.sessions.get(keyFor(payload.context.userId || 'system'))
                if (session?.handoff) return { decision: 'deny', reason: 'Browser is in human-handoff mode for this user' }
            },
        })
        const handler = (success: boolean) => (payload: Readonly<LifecyclePayload>) => {
            if (!payload.toolName?.startsWith('browser_')) return
            const userKey = keyFor(payload.context.userId || 'system')
            const entry: BrowserReplayEntry = {
                at: new Date().toISOString(),
                userKey,
                tool: payload.toolName,
                input: redact(payload.input || {}),
                success,
                output: success ? payload.output : undefined,
            }
            const file = this.replayFile(userKey)
            if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
            appendFileSync(file, `${JSON.stringify(entry)}\n`)
        }
        getLifecyclePolicy().register({ id: `browser-replay-success:${hookScope}`, event: 'tool.after', priority: 900, failClosed: false, handler: handler(true) })
        getLifecyclePolicy().register({ id: `browser-replay-failure:${hookScope}`, event: 'tool.failure', priority: 900, failClosed: false, handler: handler(false) })
        this.hookInstalled = true
    }

    private replayFile(userKey: string): string { return join(this.root, 'replay', `${userKey}.jsonl`) }
}

let manager: OperatorBrowserManager | null = null
export function getOperatorBrowserManager(): OperatorBrowserManager { return manager ||= new OperatorBrowserManager() }
