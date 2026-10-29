/**
 * 2.91.0 Kanal-Gleichheit: Bericht, nicht blockierend (Koordinator 29.10.).
 *
 * Grundsatz ab 2.91.x: EIN Weg — Kanäle sind nur Ein-/Ausgabe, der gleiche
 * Satz ergibt auf Telegram, Desktop, HUD und CLI den gleichen Inhalt. Heute
 * weicht er an bekannten Stellen ab (PLAN_THEMEN_FAEDEN.md, Nachtrag „EIN Weg“).
 *
 * Jede Prüfung unten beschreibt das ZIEL und ist als `it.fails` markiert: Sie
 * ist grün, solange die Abweichung besteht (der Abstand wird gemessen, die CI
 * blockiert nicht), und wird rot, sobald die Abweichung behoben ist — dann
 * wird aus `it.fails` ein normales `it`.
 *
 * Desktop/Dashboard hängen alle Teilantworten an (core/daemon-channels.ts:714–716);
 * das ist der Vergleichswert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TelegramPresentationSession } from '../channels/telegram-presentation.js'
import { runAuthorizedScreenshotFallback } from './message-pipeline.js'

const PARTS = ['Erster Teil: Die Steckdose ist an.', 'Zweiter Teil: Der Drucker meldet Bereitschaft.']

describe('2.91.0 Kanal-Gleichheit (Bericht: bekannte Abweichungen, nicht blockierend)', () => {
    beforeEach(() => { vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1') })
    afterEach(() => { vi.unstubAllEnvs() })

    // Abweichung 1: channels/even-g2-runtime.ts:50–52 `reply = message` — the HUD keeps only the last part.
    it.fails('Ziel 1: das HUD zeigt alle Teilantworten wie Desktop (heute nur die letzte)', async () => {
        const { createEvenG2RuntimeDeps } = await import('../channels/even-g2-runtime.js')
        const deps = createEvenG2RuntimeDeps('x'.repeat(40), {
            handleMessage: async (_channel, _from, _content, reply) => { for (const part of PARTS) await reply(part) },
            ownerIds: () => [],
            sendTelegram: async () => undefined,
        })
        const answer = await (deps as any).ask('Mach die Steckdose an und prüf den Drucker')
        for (const part of PARTS) expect(answer).toContain(part)
    }, 60_000)

    // Abweichung 2: channels/telegram-presentation.ts:90–97 — a real answer that starts like progress is swallowed into the card.
    it.fails('Ziel 2: Telegram schickt eine echte Antwort immer als Nachricht (heute schluckt die Statuskarte „Ich arbeite noch …“)', async () => {
        const sent: string[] = []
        const adapter = {
            send: async (message: { content: string }) => { sent.push(message.content) },
            sendProgress: async () => 1,
            editMessage: async () => undefined,
            deleteMessage: async () => undefined,
        }
        const session = new TelegramPresentationSession(adapter as any, '1', { statusCard: true, minEditIntervalMs: 0 })
        const answer = 'Ich arbeite noch nicht mit Docker auf dieser VM, der Zugriff ist nicht eingerichtet.'
        await session.deliver(answer)
        expect(sent).toContain(answer)
    })

    // Abweichung 6: core/message-pipeline.ts:422 — the screenshot fallback only runs for Telegram.
    it.fails('Ziel 6: der Screenshot-Rückweg gilt für jeden Kanal (heute nur Telegram)', async () => {
        const execute = vi.fn(async () => ({ success: false }))
        await runAuthorizedScreenshotFallback({
            channel: 'desktop', from: 'desktop:1', principalId: 'owner', content: 'Mach einen Screenshot vom Desktop',
            tools: { execute }, telegram: { sendPhoto: async () => undefined },
        })
        expect(execute).toHaveBeenCalled()
    })
})
