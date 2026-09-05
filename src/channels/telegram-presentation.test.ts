import { describe, expect, it, vi } from 'vitest'
import { formatTelegramMessage, isTelegramProgress, TelegramPresentationSession } from './telegram-presentation.js'

describe('Telegram presentation', () => {
    it('renders Markdown tables as mobile cards', () => {
        const result = formatTelegramMessage(`| Node | Status | Modell |\n|---|---|---|\n| Spark | online | qwen |\n| NAS | standby | — |`)
        expect(result).toContain('*Node: Spark*')
        expect(result).toContain('• Status: online')
        expect(result).toContain('*Node: NAS*')
        expect(result).not.toContain('|---|')
    })

    it('does not rewrite table-shaped code examples', () => {
        const code = '```md\n| A | B |\n|---|---|\n| 1 | 2 |\n```'
        expect(formatTelegramMessage(code)).toBe(code)
    })

    it('recognizes only lifecycle updates as progress', () => {
        expect(isTelegramProgress('⏳ Ich arbeite noch (25s)')).toBe(true)
        expect(isTelegramProgress('⚙️ Schritt 2/3: test')).toBe(true)
        expect(isTelegramProgress('✅ Fertig und verifiziert')).toBe(false)
    })

    it('edits one progress bubble and removes it before the final answer', async () => {
        const adapter = {
            send: vi.fn(async () => undefined),
            sendProgress: vi.fn(async () => 42),
            editMessage: vi.fn(async () => undefined),
            deleteMessage: vi.fn(async () => undefined),
        }
        const session = new TelegramPresentationSession(adapter, 'chat')
        await session.deliver('⏳ Analyse läuft')
        await session.deliver('⚙️ Schritt 2/2: Tests')
        await session.deliver('✅ Fertig')
        expect(adapter.sendProgress).toHaveBeenCalledTimes(1)
        expect(adapter.editMessage).toHaveBeenCalledWith('chat', 42, '⚙️ Schritt 2/2: Tests')
        expect(adapter.deleteMessage).toHaveBeenCalledWith('chat', 42)
        expect(adapter.send).toHaveBeenCalledTimes(1)
    })
})
