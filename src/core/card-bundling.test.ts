import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledCards, cardDeliveryFor, createApprovalCard, isCardDue, listApprovalCards } from './approval-cards.js'
import { deliverPendingCards } from './approval-card-sources.js'
import type { DeliveryPort, PlannerOutgoing } from '../planner/delivery-port.js'
import { startPlannerRuntime, stopPlannerRuntime } from '../planner/runtime.js'

// P8 „weniger Einzelfragen“: non-time-critical L2 cards wait for the next
// morning/evening report; security/outage/physical/outward go out at once.

let dir: string
let t: number
const HOUR = 60 * 60_000
const card = (over: Record<string, unknown> = {}) => createApprovalCard({
    art: 'install', titel: 'ffmpeg auf spark installieren?', beleg: 'Katalog ffmpeg, Rückweg vorhanden', vorschlag: 'Katalog ffmpeg',
    aktion: { kind: 'install', ref: `iq-${Math.random().toString(16).slice(2, 14)}` }, ...over,
} as any, { dataDir: dir, now: () => t, ledger: null })
const sender = (sent: string[]) => ({
    canSend: async () => true,
    ownerChatIds: () => ['111'],
    send: async (_chat: string, text: string) => { sent.push(text); return sent.length },
})

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'card-bundle-'))
    t = Date.parse('2026-10-01T10:00:00.000Z') // 12:00 Vienna
})
afterEach(() => {
    stopPlannerRuntime()
    rmSync(dir, { recursive: true, force: true })
})

describe('Zustellung: gebündelt oder sofort', () => {
    it('nicht zeitkritisch (intern, ≥ 2 h gültig) → Bericht; sonst sofort', () => {
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 24 * HOUR, text: 'ffmpeg installieren' })).toBe('bericht')
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 1.5 * HOUR, text: 'ffmpeg installieren' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 24 * HOUR, wichtigkeit: 'hoch', text: 'x' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 24 * HOUR, text: 'REST-API Ausfall auf main-a' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'intern', ttlMs: 24 * HOUR, text: 'Sicherheit: fremder Login' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'physisch', ttlMs: 24 * HOUR, text: 'drucken' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'extern', ttlMs: 24 * HOUR, text: 'mail senden' })).toBe('sofort')
        expect(cardDeliveryFor({ wirkung: 'infra', ttlMs: 24 * HOUR, text: 'VM starten' })).toBe('sofort')

        const bundled = card()
        const outward = card({ art: 'nachricht', titel: 'Antwort an example.com senden?', aktion: { kind: 'nachricht-senden', ref: 'm-1' } })
        const short = card({ ablaufMs: HOUR })
        expect([bundled, outward, short].map(item => item.ok && item.card.zustellung)).toEqual(['bericht', 'sofort', 'sofort'])
    })

    it('nicht zeitkritische Karte landet im Bericht statt sofort; danach kommen die Knöpfe', async () => {
        const sent: PlannerOutgoing[] = []
        const port: DeliveryPort = { name: 'test-port', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }
        const runtime = await startPlannerRuntime({}, { dataDir: dir, now: () => t, authority: () => true, startTimer: false, port })
        expect(runtime).not.toBeNull()
        expect(runtime!.settings.briefing.enabled).toBe(true)

        const later = card()
        const urgent = card({ titel: 'Dienst REST-API nicht erreichbar: neu starten?' })
        expect(later.ok && later.card.zustellung).toBe('bericht')

        const texts: string[] = []
        expect(await deliverPendingCards(sender(texts), { dataDir: dir, now: () => t, bundleIntoReport: true })).toBe(1)
        expect(texts[0]).toContain('nicht erreichbar')
        expect(bundledCards({ dataDir: dir, now: () => t }).map(item => item.titel)).toEqual(['ffmpeg auf spark installieren?'])

        // Abendbericht 20:00 Wien: listet die gesammelte Frage …
        t = Date.parse('2026-10-01T18:00:30.000Z')
        await runtime!.planner.tick()
        await runtime!.planner.tick()
        const report = sent.find(item => item.kind === 'briefing')!
        expect(report.title).toMatch(/^Abendbericht/)
        expect(report.text).toContain('Fragen gesammelt')
        expect(report.text).toContain('ffmpeg auf spark installieren?')
        expect(report.text).not.toContain('nicht erreichbar')
        // … und gibt sie frei: jetzt kommt die Karte mit Knöpfen.
        expect(bundledCards({ dataDir: dir, now: () => t })).toEqual([])
        expect(await deliverPendingCards(sender(texts), { dataDir: dir, now: () => t, bundleIntoReport: true })).toBe(1)
        expect(texts[1]).toContain('ffmpeg auf spark installieren?')
        expect(listApprovalCards({ dataDir: dir }).every(item => item.deliveredAt)).toBe(true)
        if (urgent.ok) expect(urgent.card.zustellung).toBe('sofort')
    })

    it('ohne Bericht (briefing aus) oder kurz vor Ablauf wird nicht zurückgehalten', async () => {
        const later = card()
        expect(later.ok).toBe(true)
        const texts: string[] = []
        expect(await deliverPendingCards(sender(texts), { dataDir: dir, now: () => t, bundleIntoReport: false })).toBe(1)

        const waiting = card({ titel: 'Modell wechseln?' })
        if (!waiting.ok) throw new Error('card')
        expect(isCardDue(waiting.card, { bundleIntoReport: true, now: t })).toBe(false)
        expect(isCardDue(waiting.card, { bundleIntoReport: true, now: t + 23 * HOUR })).toBe(true)
    })
})
