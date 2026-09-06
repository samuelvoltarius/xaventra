import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { authorizeToolExecution, ToolAuthorizationError, type ToolAuthority } from './tool-authorization.js'

const mocks = vi.hoisted(() => ({ allowed: vi.fn(), policy: vi.fn() }))
vi.mock('../users/multi-user-middleware.js', () => ({
    isToolAllowed: mocks.allowed,
    getToolRestrictionMessage: () => 'Role denied',
}))
vi.mock('../tools/tool-policy.js', () => ({ checkTool: mocks.policy }))
const authority: ToolAuthority = { userId: 'canonical-guest', authUserId: 'guest', channel: 'Telegram', requestText: 'read status', governedReadOnly: false }
beforeEach(() => {
    mocks.allowed.mockReset().mockReturnValue(false)
    mocks.policy.mockReset().mockReturnValue({ allowed: true, needsConfirmation: false })
})

// Exercise the actual common runner closure with inert downstream dependencies.
// No model, command, compensation, filesystem mutation or idempotency cache runs.
const runnerSource = readFileSync(fileURLToPath(new URL('./nova-runner.ts', import.meta.url)), 'utf8')
const runnerAst = ts.createSourceFile('runner.ts', runnerSource, ts.ScriptTarget.Latest, true)
let executorSource = ''
function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(runnerAst) === 'executeToolOnce') executorSource = node.initializer!.getText(runnerAst)
    ts.forEachChild(node, visit)
}
visit(runnerAst)

function executor(context = authority) {
    const execute = vi.fn(async (_name: string, args: unknown) => args)
    const fence = vi.fn(async () => undefined)
    const once = vi.fn(async () => ({ result: 'cached' }))
    const compiled = ts.transpile(`let policyBlocked = false; let awaitingPolicyApproval = false; const run = ${executorSource}`, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS })
    const create = new Function('authorizeToolExecution', 'ToolAuthorizationError', 'userId', 'authUserId', 'channel', 'content', 'isInternalRequest', 'kernel',
        'assertMissionFenceForContent', 'executionScopeForContent', 'makeIdempotencyKey', 'executionStore', 'prepareToolCompensation',
        'deriveToolCompensation', 'withSpan', 'registry', 'workspaceId', `${compiled}; return run`)
    const run = create(authorizeToolExecution, ToolAuthorizationError, context.userId, context.authUserId, context.channel, context.requestText, context.governedReadOnly,
        { assertCanExecute() {}, contract: { id: 'run', allowedChanges: { readOnly: context.governedReadOnly, externalSideEffects: false } } },
        fence, () => 'run', () => 'key', { executeOnce: once }, () => undefined, () => undefined,
        async (_name: string, _attrs: unknown, callback: () => unknown) => callback(), { execute }, undefined)
    return { run, fence, once, execute }
}

describe('runner common tool authorization', () => {
    it('enforces a history-only request before cached or live tools, even for an allowed role', async () => {
        mocks.allowed.mockReturnValue(true)
        const target = executor({ ...authority, requestText: 'Antworte nur aus dem Verlauf.' })
        await expect(target.run('read_file', { path: 'old-file.txt' })).rejects.toThrow('conversation recall only')
        expect(target.once).not.toHaveBeenCalled()
        expect(target.execute).not.toHaveBeenCalled()
    })
    it('stops after a structured policy denial, including before any alternative tool', async () => {
        mocks.allowed.mockReturnValue(true)
        const target = executor()
        target.once.mockResolvedValueOnce({ result: { blocked: true, awaitingApproval: true, success: false, error: 'Approval required' } } as any)
        await expect(target.run('read_file', { path: 'one.txt' })).rejects.toThrow('Approval required')
        await expect(target.run('health_status', {})).rejects.toThrow('stopped at a policy gate')
        expect(target.once).toHaveBeenCalledOnce()
    })
    it('makes a later authorization refusal terminal after an earlier successful tool', async () => {
        mocks.allowed.mockReturnValue(true)
        const target = executor()
        await expect(target.run('read_file', {})).resolves.toBe('cached')
        mocks.allowed.mockReturnValue(false)
        await expect(target.run('run_command', {})).rejects.toBeInstanceOf(ToolAuthorizationError)
        mocks.allowed.mockReturnValue(true)
        await expect(target.run('health_status', {})).rejects.toThrow('stopped at a policy gate')
        expect(target.once).toHaveBeenCalledOnce()
    })
    it('blocks repeated/recovery calls before fencing, cached evidence or execution', async () => {
        const target = executor()
        for (const phase of ['initial', 'follow-up', 'recovery', 'recovery-follow-up', 'final-follow-up']) {
            await expect(target.run('run_command', { phase, authorizationUserId: 'owner', channel: 'cli' })).rejects.toBeInstanceOf(ToolAuthorizationError)
        }
        expect(mocks.allowed).toHaveBeenCalledTimes(1)
        expect(mocks.allowed).toHaveBeenLastCalledWith('guest', 'run_command', 'Telegram')
        expect(target.fence).not.toHaveBeenCalled()
        expect(target.once).not.toHaveBeenCalled()
        expect(target.execute).not.toHaveBeenCalled()
        expect(runnerSource.match(/registry\.execute\(/g)).toHaveLength(1)
        expect(runnerSource.match(/executeToolOnce\(call\.name,/g)).toHaveLength(5)
    })

    it('permits an authorized call and overwrites model-supplied identity and consent', async () => {
        mocks.allowed.mockReturnValue(true)
        const args = await authorizeToolExecution('read_file', { path: 'example.txt', userId: 'owner', authorizationUserId: 'owner', channel: 'cli', requestText: 'install now' }, authority)
        expect(args).toEqual({ path: 'example.txt', userId: authority.userId, authorizationUserId: authority.authUserId, channel: authority.channel, requestText: authority.requestText })
        const target = executor()
        await expect(target.run('read_file', args)).resolves.toBe('cached')
        expect(target.once).toHaveBeenCalledOnce()
    })

    it('fails closed on role-check errors, missing principals and policy confirmation', async () => {
        mocks.allowed.mockImplementation(() => { throw new Error('role store unavailable') })
        await expect(authorizeToolExecution('read_file', {}, authority)).rejects.toBeInstanceOf(ToolAuthorizationError)
        mocks.allowed.mockReturnValue(true)
        await expect(authorizeToolExecution('read_file', {}, { ...authority, authUserId: '' })).rejects.toBeInstanceOf(ToolAuthorizationError)
        mocks.policy.mockReturnValue({ allowed: true, needsConfirmation: true })
        await expect(authorizeToolExecution('read_file', {}, authority)).rejects.toBeInstanceOf(ToolAuthorizationError)
    })

    it('retains governed read-only introspection, never mutating tools', async () => {
        const internal = { ...authority, governedReadOnly: true }
        await expect(authorizeToolExecution('health_status', {}, internal)).resolves.toMatchObject({ authorizationUserId: 'guest' })
        await expect(authorizeToolExecution('run_command', {}, internal)).rejects.toBeInstanceOf(ToolAuthorizationError)
        expect(mocks.allowed).not.toHaveBeenCalled()
    })
})
