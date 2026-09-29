import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocalInstanceId, MAIN_SERVICE, shouldStartExclusiveService, stopLeaseRenewal } from './leader-election.js'
import {
    assertFenced, FenceError, fenceSignal, getFenceStatus, isFenceError, resetFenceStateForTests,
    runFencedTool, toolRequiresFence,
} from './fence.js'
import { getLocalNodeId } from './mesh-registry.js'
import { createGovernedToolExecutor } from '../agents/governed-tool-executor.js'
import { IdempotencyStore } from '../core/execution-control.js'
import { ProactiveMessenger } from '../core/proactive.js'

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }))
vi.mock('../agents/tool-authorization.js', async importOriginal => ({
    ...await importOriginal<typeof import('../agents/tool-authorization.js')>(),
    authorizeToolExecution: mocks.authorize,
}))

const ENV_KEYS = ['NOVA_DISABLE_LEADER_ELECTION', 'NOVA_TELEGRAM_MODE', 'NOVA_NODE_ONLY', 'NOVA_MAIN_ELIGIBLE',
    'NOVA_MESH_SUPABASE_URL', 'NOVA_MESH_SUPABASE_KEY', 'NOVA_FENCING_MODE', 'NOVA_API_TOKEN'] as const
const savedEnv: Record<string, string | undefined> = {}
const SUPABASE = { supabase: { meshUrl: 'https://coord.test/rest/v1', meshKey: 'test-key' }, mesh: { mode: 'ha' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function useConfig(config: unknown): void {
    const dir = mkdtempSync(join(tmpdir(), 'nova-fence-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify(config))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

/** Coordinator stub: `takeover()` simulates a standby that took the lease. */
function stubCoordinator() {
    const state = { holder: getLocalNodeId(), instance: getLocalInstanceId() as string, epoch: 50 }
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (!String(url).startsWith('https://coord.test/')) return realFetch(url as any, init)
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        const expires = new Date(Date.now() + 90_000).toISOString()
        if (url.includes('/rpc/nova_acquire_service_lease_v2')) {
            const mine = state.holder === body.p_holder_node_id && state.instance === body.p_holder_instance_id
            return json({ leader: mine, holder_node_id: state.holder, holder_instance_id: state.instance, epoch: state.epoch, expires_at: expires, server_now: new Date().toISOString() })
        }
        if (url.includes('/rpc/nova_check_fence')) {
            return json({ valid: state.holder === body.p_holder_node_id && state.epoch === body.p_epoch, epoch: state.epoch })
        }
        return json([{ holder_node_id: state.holder, holder_instance_id: state.instance, epoch: state.epoch, expires_at: expires }])
    }))
    return {
        takeover() { state.holder = 'standby-node'; state.instance = 'standby-instance'; state.epoch = 51 },
    }
}

function governedExecutor(execute: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
    const store = new IdempotencyStore(join(mkdtempSync(join(tmpdir(), 'nova-fence-governed-')), 'records.json'))
    return createGovernedToolExecutor({
        kernel: { assertCanExecute() {}, contract: { id: `c-${Math.random()}`, allowedChanges: { readOnly: false, externalSideEffects: true } } } as any,
        store, userId: 'u', authUserId: '1', channel: 'telegram', content: 'licht aus', internal: false,
        isBlocked: () => false, block: () => {}, execute, record: vi.fn(),
    })
}

beforeEach(() => {
    for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
    mocks.authorize.mockReset().mockImplementation(async (_name: string, args: Record<string, unknown>) => args)
    resetFenceStateForTests()
})
afterEach(() => {
    stopLeaseRenewal(MAIN_SERVICE)
    for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
    resetFenceStateForTests()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('CL-07 fence guard at effects', () => {
    it('(a) enforce: the old Main may not execute a tool with side effects after a takeover', async () => {
        useConfig(SUPABASE)
        process.env.NOVA_FENCING_MODE = 'enforce'
        const coordinator = stubCoordinator()
        expect(await shouldStartExclusiveService(MAIN_SERVICE)).toBe(true)
        const execute = vi.fn(async () => ({ success: true }))
        const run = governedExecutor(execute)
        expect(await run('ha_call_service', { service: 'light.turn_off' })).toEqual({ success: true })
        expect(execute).toHaveBeenCalledTimes(1)

        coordinator.takeover()
        await expect(run('printer_start', { file: 'x.gcode' })).rejects.toBeInstanceOf(FenceError)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(getFenceStatus().blocked).toBeGreaterThan(0)
    })

    it('(a) enforce: a node without the Main fence refuses REST /v1/message', async () => {
        useConfig(SUPABASE)
        process.env.NOVA_FENCING_MODE = 'enforce'
        stubCoordinator()
        const { startRestApi } = await import('../server/rest-api.js')
        const handler = vi.fn(async () => undefined)
        const server = await startRestApi({ enabled: true, port: 0, host: '127.0.0.1' }, handler as any, () => ({}))
        try {
            const address = server.address() as { port: number }
            const response = await fetch(`http://127.0.0.1:${address.port}/v1/message`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Licht aus' }),
            })
            expect(response.status).toBe(503)
            expect(handler).not.toHaveBeenCalled()
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })

    it('(b) observe: the same violation is recorded but not blocked', async () => {
        useConfig(SUPABASE)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const coordinator = stubCoordinator()
        expect(await shouldStartExclusiveService(MAIN_SERVICE)).toBe(true)
        coordinator.takeover()
        const execute = vi.fn(async () => ({ success: true }))
        const run = governedExecutor(execute)
        expect(await run('printer_start', { file: 'x.gcode' })).toEqual({ success: true })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(getFenceStatus()).toMatchObject({ mode: 'observe', blocked: 0 })
        expect(getFenceStatus().violations).toBeGreaterThan(0)
        expect(warn.mock.calls.some(call => String(call[0]).includes('observe: would block tool:printer_start'))).toBe(true)
        expect(fenceSignal(MAIN_SERVICE).aborted).toBe(false)
    })

    it('exempts read-only tools and fences unknown tools by default', async () => {
        expect(toolRequiresFence('read_file')).toBe(false)
        expect(toolRequiresFence('run_command')).toBe(true)
        expect(toolRequiresFence('some_future_tool')).toBe(true)
        process.env.NOVA_FENCING_MODE = 'enforce'
        expect(await runFencedTool('read_file', async () => 'content')).toBe('content')
        await expect(runFencedTool('write_file', async () => 'written')).rejects.toBeInstanceOf(FenceError)
    })

    it('(g) lease loss aborts a running tool call and kills its child process (enforce)', async () => {
        useConfig(SUPABASE)
        process.env.NOVA_FENCING_MODE = 'enforce'
        const coordinator = stubCoordinator()
        expect(await shouldStartExclusiveService(MAIN_SERVICE)).toBe(true)
        let childError: NodeJS.ErrnoException | null = null
        let toolError: unknown
        let childExited!: () => void
        const exited = new Promise<void>(resolve => { childExited = resolve })
        const started = new Promise<void>(resolve => {
            void runFencedTool('run_command', () => new Promise((resolveTool, rejectTool) => {
                const child = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: fenceSignal(MAIN_SERVICE) }, error => {
                    childError = error
                    childExited()
                    if (error) rejectTool(error); else resolveTool('done')
                })
                child.once('spawn', () => resolve())
            })).then(() => undefined, error => { toolError = error })
        })
        await started
        coordinator.takeover()
        // Local self-fencing (the renewal-tick path is covered in
        // lease-fencing.test.ts); in-flight work must stop immediately.
        stopLeaseRenewal(MAIN_SERVICE)
        await exited
        await new Promise(resolve => setImmediate(resolve))
        expect(isFenceError(toolError)).toBe(true)
        expect(childError).not.toBeNull()
        expect(childError!.name).toBe('AbortError')
        await expect(assertFenced(MAIN_SERVICE, { effect: 'after-loss' })).rejects.toBeInstanceOf(FenceError)
    }, 20_000)

    it('keeps a fenced proactive message buffered instead of dropping it', async () => {
        const messenger = new ProactiveMessenger()
        let authoritative = false
        const send = vi.fn(async () => {
            if (!authoritative) throw new FenceError('telegram', 'no live authority', 'proactive:telegram')
            return true
        })
        messenger.registerChannel({ name: 'telegram', isConnected: () => true, send })
        const assessment = { source: 'test', summary: 'x', severity: 'error', confidence: 1, actionAvailable: true } as any
        const { assessmentFromEvent } = await import('../core/proactive-policy.js')
        const delivered = await messenger.send({ userId: '1', channel: 'telegram', content: 'Alarm', priority: 'urgent', type: 'error', assessment: assessmentFromEvent(assessment) })
        expect(delivered).toBe(false)
        authoritative = true
        expect(await messenger.processQueue()).toBe(1)
        expect(send).toHaveBeenCalledTimes(2)
    })
})
