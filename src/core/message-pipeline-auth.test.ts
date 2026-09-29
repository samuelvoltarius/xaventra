import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mu = vi.hoisted(() => ({
    initMultiUser: vi.fn(),
    checkAuth: vi.fn(),
    isGroupChat: vi.fn(() => false),
    trackGroupMessage: vi.fn(),
    shouldCoalesce: vi.fn(() => false),
    coalesceMessage: vi.fn(async (_chat: string, _from: string, content: string) => content),
    getOnboardingMessage: vi.fn(() => null),
    getUserContextString: vi.fn(() => ''),
    getGroupContext: vi.fn(() => ''),
    addUserTopic: vi.fn(),
}))

vi.mock('../users/multi-user-middleware.js', () => mu)
vi.mock('../layers/subconscious-reflector.js', () => ({ recordActivity: () => undefined }))
vi.mock('../layers/L9-idle-learning.js', () => ({ getIdleLearningManager: () => null }))
vi.mock('../intelligence/roi-dashboard.js', () => ({ startTask: () => undefined, detectCategory: () => 'test' }))
vi.mock('../layers/L15-self-check.js', () => ({ userMessageReceived: () => undefined }))
vi.mock('../channels/telegram.js', () => ({ getTelegramAdapter: () => null }))
vi.mock('./soul.js', () => ({
    soulExists: () => true,
    getOnboardingMessage: () => 'onboarding',
    isOnboardingResponse: () => false,
    parseOnboardingResponse: () => ({}),
    saveSoul: () => undefined,
    getOnboardingConfirmation: () => '',
    loadSoul: () => ({}),
    buildSystemPromptFromSoul: () => '',
}))

// logSession writes below process.cwd(); keep the fixture out of the worktree data.
const sandbox = join(process.cwd(), '.nova-test-tmp', `pipeline-auth-${randomUUID()}`)
mkdirSync(sandbox, { recursive: true })
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { handleMessage } = await import('./message-pipeline.js')

function run(content: string, channel = 'Telegram', from = 'guest-1') {
    const replies: string[] = []
    const handleCommand = vi.fn(async () => 'command-ran')
    const state: any = { config: {}, llm: { complete: vi.fn() }, tools: {} }
    return {
        replies, handleCommand, state,
        done: handleMessage(channel, from, content, async message => { replies.push(message) }, state, handleCommand),
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mu.initMultiUser.mockImplementation(() => undefined)
    mu.checkAuth.mockImplementation(() => ({ allowed: true, permission: 'user', isNewUser: false, user: {} }))
    ;(globalThis as any).__novaLastMsg = {}
})

describe('multi-user middleware failure is fail-closed', () => {
    it('denies the message when the middleware cannot be initialized', async () => {
        mu.initMultiUser.mockImplementation(() => { throw new Error('users.json corrupt') })
        const call = run('/deploy all nodes now please')
        await call.done
        expect(call.handleCommand).not.toHaveBeenCalled()
        expect(call.replies).toEqual(['🔒 Zugriff verweigert.'])
    })

    it('denies the message when the auth check itself throws (blocked check cannot be skipped)', async () => {
        mu.checkAuth.mockImplementation(() => { throw new Error('lookup failed') })
        const call = run('/deploy all nodes now please')
        await call.done
        expect(call.handleCommand).not.toHaveBeenCalled()
        expect(call.state.llm.complete).not.toHaveBeenCalled()
        expect(call.replies).toEqual(['🔒 Zugriff verweigert.'])
    })

    it('still rejects a blocked sender', async () => {
        mu.checkAuth.mockImplementation(() => ({ allowed: false, reason: 'Du bist blockiert.', permission: 'blocked', isNewUser: false, user: {} }))
        const call = run('/deploy all nodes now please')
        await call.done
        expect(call.handleCommand).not.toHaveBeenCalled()
        expect(call.replies).toEqual(['Du bist blockiert.'])
    })

    it('keeps the decided permission when a later, non-authorizing middleware step fails', async () => {
        mu.shouldCoalesce.mockImplementation(() => { throw new Error('coalescing broke') })
        const call = run('/status please right now')
        await call.done
        expect(call.handleCommand).toHaveBeenCalledTimes(1)
        expect(call.handleCommand.mock.calls[0][3]).toMatchObject({ permission: 'user', rawUserId: 'guest-1' })
        expect(call.replies).toEqual(['command-ran'])
    })
})
