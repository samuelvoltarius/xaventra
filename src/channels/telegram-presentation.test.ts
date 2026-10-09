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

    // 2.89.4 (live): /mesh scan answered "🔍 *Mesh AI Scan* …" and the line was
    // swallowed as progress — the card then closed as "❌ Abgebrochen" with no reason.
    it('a titled or multi-line report is an answer, never progress', () => {
        expect(isTelegramProgress('🔍 *Mesh AI Scan* (12ms)\n\n🟢 *Laufend (1):*')).toBe(false)
        expect(isTelegramProgress('🔍 *Mesh AI Scan* (0ms)')).toBe(false)
        expect(isTelegramProgress('⚙️ *Auftrags-Konfiguration*\n\nSchritte: 3')).toBe(false)
        expect(isTelegramProgress('🔍 *Xaventra Self-Check*')).toBe(false)
        expect(isTelegramProgress('suche im Web …')).toBe(true)
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

    it('/mesh scan: the scan report is delivered as the answer, not swallowed as progress (2.89.4)', async () => {
        const adapter = {
            send: vi.fn(async () => undefined),
            sendProgress: vi.fn(async () => 42),
            editMessage: vi.fn(async () => undefined),
            deleteMessage: vi.fn(async () => undefined),
        }
        const session = new TelegramPresentationSession(adapter, 'chat', { statusCard: true, minEditIntervalMs: 0 })
        await session.deliver('🔍 *Mesh AI Scan* (80ms)\n\nKeine AI Services gefunden.')
        await session.clearProgress()
        expect(adapter.send).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.stringContaining('Mesh AI Scan'),
        }))
        expect(adapter.sendProgress).not.toHaveBeenCalled()
        // No bare "Abgebrochen" — the report was the answer.
        expect(adapter.editMessage.mock.calls.map(call => String(call[2])).join('\n')).not.toMatch(/Abgebrochen/)
    })
})
