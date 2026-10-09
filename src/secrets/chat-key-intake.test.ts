/**
 * 2.89.4: Schlüssel aus dem Chat — Einheitstests der Erkennung und Übernahme.
 * Fake-Wert `'x'.repeat(32)`; der Wert darf in keiner Antwort auftauchen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    MASK,
    detectChatSecret,
    mapSecretService,
    isTakeoverIntent,
    isPurposeQuestion,
    isLlmService,
    intakeOwnerChatSecret,
    resetChatKeyIntake,
    pendingChatSecret,
    formatIntakeReply,
    toolKeyId,
} from './chat-key-intake.js'

const FAKE = 'x'.repeat(32)

beforeEach(() => {
    resetChatKeyIntake()
    vi.restoreAllMocks()
})

describe('detectChatSecret', () => {
    it('finds a pasted key next to a purpose word', () => {
        const found = detectChatSecret(`Hier der Tavily API Key: ${FAKE} — nimm den und trag ihn ein`)
        expect(found?.value).toBe(FAKE)
        expect(found?.context).toContain(MASK)
        expect(found?.context).not.toContain(FAKE)
    })

    it('finds a quoted key with takeover intent', () => {
        const found = detectChatSecret(`Schlüssel "${FAKE}" bitte speichern`)
        expect(found?.value).toBe(FAKE)
    })

    it('finds a known-prefix key even without extra words', () => {
        expect(detectChatSecret(`tvly-dev-${'y'.repeat(28)}`)?.value).toContain('tvly-')
        expect(detectChatSecret(`sk-${'z'.repeat(40)}`)?.kind).toBe('token')
    })

    it('ignores URLs, paths and long ordinary words', () => {
        expect(detectChatSecret(`https://example.com/${FAKE}`)).toBeNull()
        expect(detectChatSecret(`C:\\Users\\test\\${FAKE}.txt`)).toBeNull()
        expect(detectChatSecret(`Zusammenarbeitmitvielenwörternundkeinemschlüssel`)).toBeNull()
        expect(detectChatSecret('Kurzes Passwort: abc')).toBeNull()
    })
})

describe('mapSecretService / intent', () => {
    it.each([
        ['tavily', 'tavily'],
        ['Brave Search', 'brave'],
        ['Home Assistant', 'home-assistant'],
        ['Proxmox', 'proxmox'],
        ['DHL', 'dhl'],
        ['OpenAI', 'openai'],
    ])('maps %s', (word, id) => {
        expect(mapSecretService(`der ${word} key`)).toMatchObject({ id })
    })
    it('is unclear without a service word', () => {
        expect(mapSecretService(`API Key: ${FAKE}`)).toBeNull()
    })
    it('classifies takeover and purpose questions', () => {
        expect(isTakeoverIntent('nimm den und trag ihn dir ein')).toBe(true)
        expect(isPurposeQuestion('Wofür ist der Schlüssel?')).toBe(true)
        expect(isLlmService('openai')).toBe(true)
        expect(isLlmService('tavily')).toBe(false)
    })
    it('builds stable tool ids', () => {
        expect(toolKeyId('tavily')).toBe('chat-tavily')
        expect(toolKeyId('home-assistant')).toBe('chat-home-assistant')
    })
})

describe('intakeOwnerChatSecret', () => {
    const meta = { channel: 'telegram', from: 'owner-1', chatId: '111', messageId: 42 }
    const ownerDeps = () => ({
        isOwner: () => true,
        isGroup: false,
        deleteMessage: vi.fn(async () => undefined),
        storeToolKey: vi.fn(async (id: string) => ({ ok: true, message: `im Tresor als „${id}“` })),
        storeLlmKey: vi.fn(async (id: string) => ({ ok: true, message: `verbunden als „${id}“` })),
        testKey: vi.fn(async () => ({ ok: true, message: 'Live-Test ok' })),
    })

    it('stores a clear-purpose key in one step, deletes the message and never echoes the value', async () => {
        const deps = ownerDeps()
        const reply = await intakeOwnerChatSecret(
            `Hier der Tavily API Key: ${FAKE} — nimm den und trag ihn ein`,
            meta,
            deps,
        )
        expect(reply).toBeTruthy()
        expect(reply).not.toContain(FAKE)
        expect(reply).toContain('Tavily')
        expect(reply).toContain('gelöscht')
        expect(reply).toContain('Ohne Neustart aktiv')
        expect(deps.deleteMessage).toHaveBeenCalledWith('111', 42)
        expect(deps.storeToolKey).toHaveBeenCalled()
        expect(deps.storeToolKey.mock.calls[0][2]).toBe(FAKE)
        expect(deps.testKey).toHaveBeenCalled()
    })

    it('asks exactly one purpose question and finishes on the answer', async () => {
        const deps = ownerDeps()
        const first = await intakeOwnerChatSecret(`API Key: ${FAKE} — trag ihn ein`, meta, deps)
        expect(first).toMatch(/^Wofür ist der Schlüssel\?/)
        expect(first).not.toContain(FAKE)
        expect(pendingChatSecret('telegram:owner-1')?.value).toBe(FAKE)
        expect(deps.storeToolKey).not.toHaveBeenCalled()

        const second = await intakeOwnerChatSecret('Tavily', meta, deps)
        expect(second).toContain('Tavily')
        expect(second).not.toContain(FAKE)
        expect(deps.storeToolKey).toHaveBeenCalled()
        expect(pendingChatSecret('telegram:owner-1')).toBeNull()
    })

    it('routes LLM services to the LLM store and activates them', async () => {
        const deps = ownerDeps()
        const reply = await intakeOwnerChatSecret(
            `OpenAI API Key: ${FAKE} — nimm den und trag ihn ein`,
            meta,
            deps,
        )
        expect(reply).toContain('OpenAI')
        expect(reply).not.toContain(FAKE)
        expect(deps.storeLlmKey).toHaveBeenCalled()
        expect(deps.storeToolKey).not.toHaveBeenCalled()
    })

    it('refuses non-owners and groups without storing', async () => {
        const outsider = ownerDeps()
        outsider.isOwner = () => false
        const reply = await intakeOwnerChatSecret(`Tavily API Key: ${FAKE}`, meta, outsider)
        expect(reply).toMatch(/nur im Direktchat des Owners/)
        expect(reply).not.toContain(FAKE)
        expect(outsider.storeToolKey).not.toHaveBeenCalled()

        const group = ownerDeps()
        group.isGroup = true
        const groupReply = await intakeOwnerChatSecret(`Tavily API Key: ${FAKE}`, meta, group)
        expect(groupReply).toMatch(/nur im Direktchat des Owners/)
        expect(group.storeToolKey).not.toHaveBeenCalled()
    })

    it('leaves ordinary messages to the pipeline', async () => {
        const deps = ownerDeps()
        expect(await intakeOwnerChatSecret('Wie spät ist es?', meta, deps)).toBeNull()
        expect(deps.storeToolKey).not.toHaveBeenCalled()
    })
})

describe('formatIntakeReply', () => {
    it('never contains a value and reports store failure honestly', () => {
        const ok = formatIntakeReply({
            serviceLabel: 'Tavily', storeNote: 'im Tresor als „chat-tavily“',
            testNote: 'Live-Test ok', deleted: true, activated: true,
        })
        expect(ok).not.toContain(FAKE)
        expect(ok).toContain('Ohne Neustart aktiv')
        expect(ok).toContain('gelöscht')

        const fail = formatIntakeReply({
            serviceLabel: 'Tavily', storeNote: 'FEHLER — kaputt',
            testNote: 'FEHLER — nicht geprüft', deleted: false, activated: false,
        })
        expect(fail).toMatch(/^❌ Nicht übernommen/)
        expect(fail).not.toContain('Referenz steht')
    })
})
