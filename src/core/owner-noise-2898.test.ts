/** 2.89.8 (U5): less noise - one report per day, hand-over offers collected, availability only on a state change. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApprovalCard } from './approval-cards.js'
import { AVAILABILITY_DEBOUNCE_MS, AvailabilityGate, classifyAvailability } from './availability-notices.js'
import { notifyOwner, type OwnerNotifyDeps } from './owner-notify.js'
import { parsePlannerSettings, startPlannerRuntime, stopPlannerRuntime } from '../planner/runtime.js'
import type { DeliveryPort } from '../planner/delivery-port.js'

let dir: string
const T0 = Date.parse('2026-10-01T10:00:00.000Z')
const MIN = 60_000
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owner-noise-')) })
afterEach(() => { stopPlannerRuntime(); rmSync(dir, { recursive: true, force: true }) })

describe('one proactive report per day', () => {
    it('the evening report is off unless autonomy.briefing.eveningEnabled is true', async () => {
        expect(parsePlannerSettings({}).briefing.eveningEnabled).toBe(false)
        expect(parsePlannerSettings({ briefing: { eveningEnabled: true } }).briefing.eveningEnabled).toBe(true)
        const port: DeliveryPort = { name: 'test-port', deliver: async () => ({ status: 'zugestellt' }) }
        const runtime = await startPlannerRuntime({}, { dataDir: dir, now: () => T0, authority: () => true, startTimer: false, port })
        expect(runtime!.planner.getJob('sys-briefing-morgen')?.enabled).toBe(true)
        expect(runtime!.planner.getJob('sys-briefing-abend')?.enabled).toBe(false)
        stopPlannerRuntime()
        const optIn = await startPlannerRuntime({ briefing: { eveningEnabled: true } }, { dataDir: dir, now: () => T0, authority: () => true, startTimer: false, port })
        expect(optIn!.planner.getJob('sys-briefing-abend')?.enabled).toBe(true)
    })
})

describe('hand-over offers are collected', () => {
    const delegation = (over: Record<string, unknown> = {}) => createApprovalCard({
        art: 'delegation', titel: 'Auftrag an Claude senden?', beleg: 'Technischer Auftrag', vorschlag: 'Mit Ja geht der Auftrag raus.',
        aktion: { kind: 'delegation', ref: `dlg-${Math.random().toString(16).slice(2, 14)}` }, ablaufMs: 24 * 60 * MIN, sammeln: true, ...over,
    } as any, { dataDir: dir, now: () => T0, ledger: null })
    it('waits for the report; still immediate when marked important or about to expire', () => {
        const collected = delegation()
        expect(collected.ok && collected.card.zustellung).toBe('bericht')
        const important = delegation({ wichtigkeit: 'hoch' })
        expect(important.ok && important.card.zustellung).toBe('sofort')
        const soon = delegation({ ablaufMs: 30 * MIN })
        expect(soon.ok && soon.card.zustellung).toBe('sofort')
        // Doctor cases talk about outages: the urgent-text rule used to send each one at once. Collected now.
        const outageText = { titel: 'Auftrag an Claude senden?', beleg: 'Lokales Modell nicht erreichbar, Dienst offline' }
        const outageCollected = delegation(outageText)
        expect(outageCollected.ok && outageCollected.card.zustellung).toBe('bericht')
        const outageSingle = delegation({ ...outageText, sammeln: false })
        expect(outageSingle.ok && outageSingle.card.zustellung).toBe('sofort')
    })
})

describe('availability notices only on a state change', () => {
    const notice = (content: string) => ({ source: 'mesh', content, dedupeKey: 'node-a' })
    it('classifies down and up statements', () => {
        expect(classifyAvailability('Node A ist nicht erreichbar')).toBe('down')
        expect(classifyAvailability('Node A ist wieder erreichbar')).toBe('up')
        expect(classifyAvailability('Update installiert')).toBeNull()
    })
    it('debounces, reports an outage once, then the recovery once', () => {
        let now = T0
        const gate = new AvailabilityGate(join(dir, 'state.json'), () => now)
        const down = notice('Node A ist nicht erreichbar')
        expect(gate.judge(down).send).toBe(false)                       // first sight: debounce
        now += 5 * MIN; expect(gate.judge(down).send).toBe(false)
        now += 6 * MIN; expect(gate.judge(down).send).toBe(true)        // 11 min down: told once
        for (let i = 0; i < 10; i++) { now += 5 * MIN; expect(gate.judge(down).send).toBe(false) }
        expect(gate.judge(notice('Node A ist wieder erreichbar')).send).toBe(true)
        expect(gate.judge(notice('Node A ist wieder erreichbar')).send).toBe(false)
        expect(gate.judge({ source: 'mesh', content: 'Update installiert' }).send).toBe(true)
    })
    it('a flapping node that recovers inside the debounce is never announced', () => {
        let now = T0
        const gate = new AvailabilityGate(null, () => now)
        expect(gate.judge(notice('Node A nicht erreichbar')).send).toBe(false)
        now += AVAILABILITY_DEBOUNCE_MS - MIN
        expect(gate.judge(notice('Node A wieder erreichbar')).send).toBe(false)
    })
    it('survives a restart without re-announcing a reported outage', () => {
        let now = T0
        const path = join(dir, 'state.json')
        const first = new AvailabilityGate(path, () => now)
        first.judge(notice('Node A nicht erreichbar'))
        now += 11 * MIN
        expect(first.judge(notice('Node A nicht erreichbar')).send).toBe(true)
        const second = new AvailabilityGate(path, () => now + MIN)
        expect(second.judge(notice('Node A nicht erreichbar')).send).toBe(false)
    })
    it('notifyOwner drops a suppressed availability notice before any thought is created', async () => {
        const thoughts: unknown[] = []
        const gate = new AvailabilityGate(null, () => T0)
        const deps: OwnerNotifyDeps = {
            ingest: () => ({ actionable: true, reason: 'ok' }), authority: async () => true, plannerActive: () => true,
            addThought: input => { thoughts.push(input); return { thought: { id: 't1' }, deduped: false } },
            transport: async () => true, availability: n => gate.judge(n),
        }
        const result = await notifyOwner({ content: 'Node A ist nicht erreichbar', source: 'mesh', severity: 'error', confidence: 0.9, dedupeKey: 'node-a' }, deps)
        expect(result.route).toBe('verworfen')
        expect(thoughts).toHaveLength(0)
        const other = await notifyOwner({ content: 'Backup fertig', source: 'backup', severity: 'info', confidence: 0.9 }, deps)
        expect(other.route).toBe('gedanke')
    })
})
