/**
 * 2.82.0 Aufräumen Punkt 1: ein Meldeweg. Was früher über Weg A
 * (sendGovernedProactive → ProactiveMessenger) UND Weg B (Gedanken → Planer)
 * kam, ist jetzt ein Gedanke: eine Entdopplung, eine Ruhezeit, eine Zustellung.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEventBus } from './operational-event-bus.js'
import { noticeToThought, notifyOwner, splitNotice, thoughtSource, type OwnerNotice, type OwnerNotifyDeps } from './owner-notify.js'
import { createThoughtStore, deliverPendingThoughts, type ThoughtStore } from '../planner/thoughts.js'
import type { PlannerOutgoing } from '../planner/delivery-port.js'

let dir: string
let store: ThoughtStore
let bus: OperationalEventBus
// 10:00 Vienna (day) and 23:30 Vienna (quiet, 22-7)
const DAY = Date.parse('2026-10-01T08:00:00.000Z')
const NIGHT = Date.parse('2026-10-01T21:30:00.000Z')
let t = DAY

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owner-notify-'))
    t = DAY
    store = createThoughtStore({ dataDir: dir, now: () => t, settings: { quietStart: 22, quietEnd: 7 } })
    bus = new OperationalEventBus(join(dir, 'operational-events.json'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function deps(overrides: Partial<OwnerNotifyDeps> = {}): OwnerNotifyDeps & { transport: ReturnType<typeof vi.fn> } {
    const transport = vi.fn(async () => true)
    return {
        ingest: (notice: OwnerNotice) => bus.ingest({ source: notice.source, summary: notice.content, severity: notice.severity, confidence: notice.confidence, dedupeKey: notice.dedupeKey, evidenceRefs: notice.evidenceRefs }),
        authority: async () => true,
        plannerActive: () => true,
        addThought: (input: any) => store.add(input),
        transport,
        ...overrides,
    } as any
}

async function deliver(): Promise<PlannerOutgoing[]> {
    const sent: PlannerOutgoing[] = []
    await deliverPendingThoughts(store, { name: 'test', deliver: async msg => { sent.push(msg); return { status: 'zugestellt' } } }, { briefingEnabled: true })
    return sent
}

const disk: OwnerNotice = { content: '🏥 **System Health Warning:**\n⚠️ Disk Space kritisch: 3GB frei, 96% belegt', source: 'health-monitor', severity: 'warning', confidence: 0.99, dedupeKey: 'health:disk' }

describe('ein Sachverhalt = eine Meldung (Weg A und Weg B zusammen)', () => {
    it('Weg A zweimal plus derselbe Sachverhalt über Weg B: ein Gedanke, eine Zustellung, kein Direktversand', async () => {
        const d = deps()
        expect((await notifyOwner(disk, d)).route).toBe('gedanke')
        expect((await notifyOwner({ ...disk, content: disk.content.replace('96', '97') }, d)).route).toBe('gedanke')
        // the same fact arriving as a thought (former Weg B), same signature
        const viaB = store.add(noticeToThought(disk, true))
        expect(viaB.deduped).toBe(true)
        expect(store.list()).toHaveLength(1)
        expect(store.list()[0].seen).toBe(3)
        const sent = await deliver()
        expect(sent).toHaveLength(1)
        expect(sent[0].text).toMatch(/System Health Warning: ⚠️ Disk Space kritisch/)
        expect(await deliver()).toHaveLength(0)
        expect(d.transport).not.toHaveBeenCalled()
    })

    it('eine Ruhezeit: warning wartet nachts, critical geht sofort', async () => {
        t = NIGHT
        const d = deps()
        await notifyOwner(disk, d)
        await notifyOwner({ content: 'Spark nicht erreichbar', source: 'node-health', severity: 'critical', confidence: 0.98, dedupeKey: 'node:spark' }, d)
        const sent = await deliver()
        expect(sent.map(item => item.title)).toEqual(['Spark nicht erreichbar'])
    })
})

describe('früher stumm verworfene Quellen', () => {
    it('unbestätigt = Idee (nur Bericht), vertrauenswürdig = Meldung', async () => {
        const d = deps()
        expect((await notifyOwner({ content: 'Ich habe nachgedacht', source: 'self-thinking', severity: 'info', confidence: 0.85 }, d)).route).toBe('idee')
        expect((await notifyOwner({ content: 'Traum-Reflexion: 2 Vorschläge', source: 'dream-digest', severity: 'info', confidence: 0.8, dedupeKey: 'traum-tagesbericht:2026-10-01' }, d)).route).toBe('idee')
        expect((await notifyOwner({ content: 'Mission Backup prüfen: Schritt 2/3 erledigt', source: 'mission-engine', severity: 'warning', confidence: 0.9 }, d)).route).toBe('gedanke')
        const ideas = store.list().filter(item => item.kind === 'idee')
        expect(ideas.map(item => item.source).sort()).toEqual(['dream-digest', 'self-thinking'])
        expect(ideas.every(item => item.notice === 'keine' && /unbestätigt/.test(item.evidence))).toBe(true)
        const sent = await deliver()
        expect(sent.map(item => item.title)).toEqual(['Mission Backup prüfen: Schritt 2/3 erledigt'])
    })

    it('Planer aus: nur dann trägt der Transport, und Unbestätigtes bleibt draußen', async () => {
        const d = deps({ plannerActive: () => false })
        expect((await notifyOwner(disk, d)).route).toBe('transport')
        expect((await notifyOwner({ content: 'x', source: 'self-thinking', severity: 'info', confidence: 0.85 }, d)).route).toBe('verworfen')
        expect(d.transport).toHaveBeenCalledTimes(1)
        expect(store.list()).toHaveLength(0)
    })

    it('ohne Main/Telegram-Autorität wird nichts gesammelt', async () => {
        const d = deps({ authority: async () => false })
        expect((await notifyOwner(disk, d)).route).toBe('verworfen')
        expect(store.list()).toHaveLength(0)
        expect(d.transport).not.toHaveBeenCalled()
    })
})

describe('Abbildung', () => {
    it('Quelle, Titel, Schwere', () => {
        expect(thoughtSource('L0-health-monitor')).toBe('l0-health-monitor')
        expect(thoughtSource('Self Thinking!')).toBe('self-thinking')
        expect(thoughtSource('***')).toBe('meldung')
        expect(splitNotice('🚨 *ALERT: NAS ist DOWN!*\n\nURL: https://nas.example.com\nSeit: jetzt')).toEqual({ title: '🚨 ALERT: NAS ist DOWN!', evidence: 'URL: https://nas.example.com · Seit: jetzt' })
        expect(noticeToThought({ ...disk, severity: 'error' }, true).severity).toBe('warning')
        expect(noticeToThought({ ...disk, severity: 'critical' }, true).severity).toBe('critical')
        expect(noticeToThought(disk, true).signature).toBe('health-monitor:health:disk')
    })
})

describe('Daemon', () => {
    it('schickt Weg A nicht mehr selbst an den ProactiveMessenger, solange der Planer läuft', () => {
        const daemon = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const start = daemon.indexOf('.sendGovernedProactive = async')
        const block = daemon.slice(start, daemon.indexOf('Register channels unconditionally', start))
        expect(block).toMatch(/notifyOwner\(/)
        expect(block).toMatch(/plannerActive: \(\) => plannerConfigured/)
        expect(block.indexOf('proactive.send(')).toBeGreaterThan(block.indexOf('transport: async'))
        expect(daemon).not.toMatch(/governed\(message, 'autonomy-loop'/)
    })
})
