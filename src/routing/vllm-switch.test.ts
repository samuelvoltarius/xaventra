import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_VLLM_TARGETS, issueVllmTicket, verifyVllmTicket, type SignedVllmTicket, type VllmTicket } from '../install/vllm-ticket.js'
import type { NodeMemoryView } from './local-model-control.js'
import { startVllmSwitch, vllmSwitchRefusal, type VllmHostStateView, type VllmNoticeLevel, type VllmSwitchOutcome, type VllmSwitchRuntime } from './vllm-switch.js'
import { clearActiveVllmSwitch, getActiveVllmSwitch, vllmSwitchBlocks, vllmSwitchBusyMessage } from './vllm-switch-state.js'

// Phase 8: vLLM-Wechsel am Spark. Keine echte Maschine: ein simulierter Spark
// (Host-Agent + vLLM-Endpunkt) mit echten signierten Tickets.

const keys = generateKeyPairSync('ed25519')
const pem = (k: any, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString()
const publicKey = pem(keys.publicKey, 'spki'), privateKey = pem(keys.privateKey, 'pkcs8')
const BASE = 'http://spark.example.com:8000'
const POLL = 10_000
const PLAN = { id: 'v0123456789ab', node: 'spark', target: 'coder', approvedBy: 'owner:111' }
const roomy: NodeMemoryView = { nodeId: 'spark', totalBytes: 121 * 1024 ** 3, freeBytes: 20 * 1024 ** 3, memoryStatus: 'warn', vllmNode: true }

interface SparkOptions {
    current?: string
    ids?: Record<string, string>
    /** Polls until a launched model answers. */
    bootPolls?: number
    newBoots?: boolean
    rollbackBoots?: boolean
    /** After the switch the old model keeps answering and no restart happens (ids may all be equal). */
    stale?: boolean
    probeOk?: (id: string) => boolean
    maintenance?: boolean
    refuseSwitch?: boolean
}

function fakeSpark(options: SparkOptions = {}) {
    let clock = 1_000_000
    const ids = options.ids || { flash: 'qwen-flash', coder: 'qwen-coder', nano: 'qwen-nano' }
    const sim = {
        current: options.current || 'flash',
        marker: options.maintenance === true,
        ownPlan: null as string | null,
        serving: ids[options.current || 'flash'] as string | null,
        container: { name: 'sparkrun_flash_solo', startedAt: new Date(clock - 3_600_000).toISOString(), running: true },
        pending: null as null | { target: string; readyAt: number; boots: boolean },
        launches: 0,
        tickets: [] as VllmTicket[],
        used: new Set<string>(),
    }
    const tick = () => {
        const p = sim.pending
        if (p && clock >= p.readyAt) {
            sim.pending = null
            if (p.boots) {
                sim.serving = ids[p.target]
                sim.container = { name: `sparkrun_${p.target}_solo`, startedAt: new Date(clock).toISOString(), running: true }
            }
        }
    }
    const host = {
        async state(): Promise<VllmHostStateView> {
            return { success: true, currentTarget: sim.current, maintenance: sim.marker, ownMarkerPlan: sim.ownPlan, modelIds: { ...ids }, switchRunning: false, container: { ...sim.container } }
        },
        async action(signed: SignedVllmTicket) {
            const ticket = verifyVllmTicket(signed, { nodeId: 'spark', clientId: 'main', publicKey, targets: DEFAULT_VLLM_TARGETS, now: clock })
            if (sim.used.has(ticket.id)) return { success: false, error: 'Ticket bereits verwendet' }
            sim.used.add(ticket.id)
            sim.tickets.push(ticket)
            if (ticket.operation === 'markieren') {
                if (sim.marker) return { success: false, error: 'Wartungsmarke existiert bereits' }
                sim.marker = true; sim.ownPlan = ticket.planId
                return { success: true, savedTarget: sim.current }
            }
            if (ticket.operation === 'freigeben') {
                if (sim.ownPlan !== ticket.planId) return { success: false, error: 'fremde Marke' }
                sim.marker = false; sim.ownPlan = null
                return { success: true }
            }
            if (!sim.marker || sim.ownPlan !== ticket.planId) return { success: false, error: 'ohne eigene Marke' }
            if (options.refuseSwitch && ticket.purpose === 'wechsel') return { success: false, error: 'Wechsel-Skript fehlt auf diesem Host' }
            sim.launches++
            sim.current = ticket.target
            const launchedAt = clock
            if (options.stale && ticket.purpose === 'wechsel') return { success: true, launchedAt }
            sim.serving = null
            sim.pending = { target: ticket.target, readyAt: clock + (options.bootPolls ?? 2) * POLL, boots: ticket.purpose === 'wechsel' ? options.newBoots !== false : options.rollbackBoots !== false }
            return { success: true, launchedAt }
        },
    }
    const endpoint = {
        async models() { tick(); if (!sim.serving) throw Error('ECONNREFUSED'); return [sim.serving] },
        async chat(id: string) { return options.probeOk ? options.probeOk(id) : true },
    }
    const notices: Array<{ level: VllmNoticeLevel; title: string; text: string }> = []
    const issued: string[] = []
    const runtime: VllmSwitchRuntime = {
        nodeId: 'spark', targets: DEFAULT_VLLM_TARGETS, host, endpoint, baseUrl: BASE,
        issue: input => { issued.push(`${input.operation}:${input.purpose}:${input.target}`); return issueVllmTicket({ ...input, nodeId: 'spark', clientId: 'main', targets: DEFAULT_VLLM_TARGETS }, privateKey, clock) },
        busy: async () => null,
        memory: async () => roomy,
        notify: (level, title, text) => { notices.push({ level, title, text }) },
        now: () => clock,
        sleep: async ms => { clock += ms },
        switchTimeoutMs: 60_000, restoreTimeoutMs: 60_000, pollMs: POLL,
    }
    return { sim, runtime, notices, issued }
}

async function run(spark: ReturnType<typeof fakeSpark>, plan = PLAN): Promise<VllmSwitchOutcome> {
    const start = await startVllmSwitch(plan, spark.runtime)
    if (!start.started) return (start as { outcome: VllmSwitchOutcome }).outcome
    return start.done
}

afterEach(() => clearActiveVllmSwitch())

describe('vLLM-Wechsel: geschlossene Zielliste, nie freier Text', () => {
    it('lehnt freie Zielnamen und Shell-Zeichen ab, bevor irgendetwas am Host passiert', async () => {
        for (const target of ['flash; rm -rf /', '$(reboot)', 'coder && curl x|sh', '../../etc/passwd', 'CODER', 'gpt-4o', '', 'vllm-stop']) {
            const spark = fakeSpark()
            const outcome = await run(spark, { ...PLAN, target })
            expect(outcome.status).toBe('nicht-ausgefuehrt')
            expect(spark.issued).toEqual([])
            expect(spark.sim.tickets).toEqual([])
        }
        expect(() => issueVllmTicket({ operation: 'wechseln', purpose: 'wechsel', target: 'flash;id', planId: PLAN.id, approvedBy: 'owner:1', nodeId: 'spark', clientId: 'main', targets: DEFAULT_VLLM_TARGETS }, privateKey)).toThrow(/Liste/)
    })

    it('braucht das Ja des Owners und den richtigen Knoten', async () => {
        for (const plan of [{ ...PLAN, approvedBy: 'model:qwen' }, { ...PLAN, approvedBy: '' }, { ...PLAN, node: 'ns1' }]) {
            const spark = fakeSpark()
            expect((await run(spark, plan)).status).toBe('nicht-ausgefuehrt')
            expect(spark.issued).toEqual([])
        }
    })
})

describe('vLLM-Wechsel: Ablauf mit automatischem Rückweg', () => {
    it('Erfolg → neues Ziel aktiv, Probe bestanden, Wartungsmarke entfernt, Statusmeldung', async () => {
        const spark = fakeSpark()
        const start = await startVllmSwitch(PLAN, spark.runtime)
        expect(start.started).toBe(true)
        // Während des Wechsels hält Xaventra genau diesen Endpunkt zurück — mit klarer Meldung.
        expect(vllmSwitchBlocks(`${BASE}/v1`)).toBe(true)
        expect(vllmSwitchBlocks('http://localhost:11434')).toBe(false)
        expect(vllmSwitchBusyMessage()).toMatch(/Modellwechsel am spark läuft \(flash → coder/)
        expect(spark.notices[0]).toMatchObject({ level: 'status' })
        expect(spark.notices[0].title).toMatch(/Modellwechsel läuft/)
        expect(spark.notices[0].text).toMatch(/~15 min ohne lokales LLM/)
        const outcome = await (start as { done: Promise<VllmSwitchOutcome> }).done
        expect(outcome.status).toBe('ausgefuehrt')
        expect(spark.sim.current).toBe('coder')
        expect(spark.sim.serving).toBe('qwen-coder')
        expect(spark.sim.marker).toBe(false)
        expect(spark.issued).toEqual(['markieren:wechsel:coder', 'wechseln:wechsel:coder', 'freigeben:wechsel:coder'])
        expect(spark.sim.tickets.every(ticket => ticket.planId === PLAN.id && ticket.nodeId === 'spark' && ticket.approvedBy === 'owner:111')).toBe(true)
        expect(getActiveVllmSwitch()).toBeNull()
        expect(vllmSwitchBlocks(BASE)).toBe(false)
    })

    it('Zeitüberschreitung → automatisch zurück auf das alte Ziel, Meldung „zurückgerollt“ mit Grund', async () => {
        const spark = fakeSpark({ newBoots: false })
        const outcome = await run(spark)
        expect(outcome.status).toBe('zurueckgerollt')
        expect(outcome.message).toMatch(/zurückgerollt: flash läuft wieder/)
        expect(outcome.message).toMatch(/Zeitüberschreitung/)
        expect(spark.issued).toEqual(['markieren:wechsel:coder', 'wechseln:wechsel:coder', 'wechseln:rueckweg:flash', 'freigeben:wechsel:coder'])
        expect(spark.sim.current).toBe('flash')
        expect(spark.sim.serving).toBe('qwen-flash')
        expect(spark.sim.marker).toBe(false)
        expect(spark.notices.at(-1)?.title).toMatch(/zurückgerollt/)
    })

    it('Probe scheitert → Rückweg (kein Erfolg nur weil /v1/models antwortet)', async () => {
        const spark = fakeSpark({ probeOk: id => id !== 'qwen-coder' })
        const outcome = await run(spark)
        expect(outcome.status).toBe('zurueckgerollt')
        expect(outcome.reason).toMatch(/Prüfanfrage 3× gescheitert/)
        expect(spark.sim.current).toBe('flash')
    })

    it('altes Modell antwortet noch (gleiche IDs, kein Neustart) → kein falscher Erfolg, Rückweg', async () => {
        const same = { flash: 'qwen', coder: 'qwen', nano: 'qwen' }
        const spark = fakeSpark({ ids: same, stale: true })
        const outcome = await run(spark)
        expect(outcome.status).toBe('zurueckgerollt')
        expect(outcome.reason).toMatch(/kein Neustart/)
    })

    it('Rückweg scheitert → Wartungsmarke weg (Wächter übernimmt) und dringender Alarm', async () => {
        const spark = fakeSpark({ newBoots: false, rollbackBoots: false })
        const outcome = await run(spark)
        expect(outcome.status).toBe('fehlgeschlagen')
        expect(spark.sim.marker).toBe(false)
        expect(outcome.message).toMatch(/Wächter übernimmt/)
        const alarm = spark.notices.find(item => item.level === 'dringend')
        expect(alarm?.title).toMatch(/Rückweg gescheitert/)
        expect(getActiveVllmSwitch()).toBeNull()
    })

    it('Host lehnt den Start ab → nichts gewechselt, Marke wieder weg, kein Rückweg nötig', async () => {
        const spark = fakeSpark({ refuseSwitch: true })
        const outcome = await run(spark)
        expect(outcome.status).toBe('nicht-ausgefuehrt')
        expect(spark.sim.launches).toBe(0)
        expect(spark.sim.marker).toBe(false)
        expect(spark.issued).not.toContain('wechseln:rueckweg:flash')
    })
})

describe('vLLM-Wechsel: Vorbedingungen (Karte UND Ausführung)', () => {
    const state = (patch: Partial<VllmHostStateView> = {}): VllmHostStateView => ({ success: true, currentTarget: 'flash', maintenance: false, modelIds: { flash: 'a', coder: 'b' }, switchRunning: false, ...patch })
    const base = { target: 'coder', targets: DEFAULT_VLLM_TARGETS, state: state(), busy: null, memory: roomy }

    it('lässt einen sauberen Wechsel zu', () => {
        expect(vllmSwitchRefusal(base)).toBeNull()
    })

    it('verweigert bei Wartungsmarke, laufendem Wechsel, gleichem Ziel, fehlendem Rückweg, LLM-Aufgaben und Speicher', () => {
        expect(vllmSwitchRefusal({ ...base, state: state({ maintenance: true }) })).toMatch(/Wartungsmarke/)
        expect(vllmSwitchRefusal({ ...base, state: state({ switchRunning: true }) })).toMatch(/läuft bereits/)
        expect(vllmSwitchRefusal({ ...base, target: 'flash' })).toMatch(/schon aktiv/)
        expect(vllmSwitchRefusal({ ...base, state: state({ currentTarget: null }) })).toMatch(/Rückweg/)
        expect(vllmSwitchRefusal({ ...base, state: state({ modelIds: { coder: 'b' } }) })).toMatch(/Rückweg nicht prüfbar/)
        expect(vllmSwitchRefusal({ ...base, busy: 'Laufende Aufgaben brauchen das LLM: Mission „x“' })).toMatch(/Mission/)
        expect(vllmSwitchRefusal({ ...base, memory: null })).toMatch(/Speicher/)
        expect(vllmSwitchRefusal({ ...base, memory: { ...roomy, memoryStatus: 'crit' } })).toMatch(/kritisch/)
        expect(vllmSwitchRefusal({ ...base, state: null })).toMatch(/Host-Agent/)
    })

    it('Wartungsmarke gesetzt → kein Ticket, kein Eingriff', async () => {
        const spark = fakeSpark({ maintenance: true })
        const outcome = await run(spark)
        expect(outcome.status).toBe('nicht-ausgefuehrt')
        expect(outcome.reason).toMatch(/Wartungsmarke/)
        expect(spark.issued).toEqual([])
    })

    it('laufende Owner-Aufgabe → kein Wechsel', async () => {
        const spark = fakeSpark()
        spark.runtime.busy = async () => 'Laufende Aufgaben brauchen das LLM: 1 Subagent(en)'
        const outcome = await run(spark)
        expect(outcome.status).toBe('nicht-ausgefuehrt')
        expect(spark.issued).toEqual([])
    })
})
