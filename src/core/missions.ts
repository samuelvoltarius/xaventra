/**
 * Missionen (Phase 6b): wenn eine aktive Verantwortung verletzt ist, entsteht
 * eine Mission mit Vertrag und arbeitet innerhalb der Aktions-Policy, bis das
 * Kriterium wieder erfüllt ist — oder sie übergibt sauber an Alfred.
 *
 * Vertrag: done-when (Kriterien der Verantwortung) · darf (≤ L1 automatisch)
 * · fragen bei (L2, Knopf-Karte `mission-schritt`) · nie (L3, auch nicht per
 * Knopf). Schritte kommen aus einem festen Plan je Ableitungsregel, nie vom
 * Modell. Höchstens 3 Versuche, Diagnose zu Beginn jedes Versuchs, Budget
 * (Zeit, Tool-Calls, Kosten 0).
 *
 * Zustände:
 *   geplant ──tick──> in-arbeit ──L2──> wartet-auf-alfred ──Ja──> in-arbeit (genau dieser Schritt, dann weiter)
 *                         │                     └──Nein / Karte abgelaufen──> blockiert (Handoff)
 *                         ├── Kriterium erfüllt ──> abgeschlossen
 *                         ├── L3 / nicht im Vertrag / kein Ausführungsweg ──> blockiert (Handoff)
 *                         └── Versuch gescheitert ──(<3)──> in-arbeit (nächster Tick) ──(3)──> fehlgeschlagen (Handoff)
 *
 * Persistenz: `<dataDir>/missions/missions.json` (atomar). Nach einem Neustart
 * steht eine wartende Mission genau dort, wo sie wartete; das „Ja“ führt nur
 * den wartenden Schritt aus und läuft dann weiter (kein Neustart von vorn).
 *
 * Ausführen nur über registrierte Schritt-Ausführer (Self-Heal-Zyklus,
 * Install-Warteschlange, Sensing approveDevice, Diagnose) — kein freier
 * Befehlsweg. Nur am Main (Fence); auf Workern passiert nichts.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateAction, recordActionOutcome, trustUpgradeProposal, type ActionLevel } from './action-policy.js'
import { atomicWriteJsonSync } from './atomic-storage.js'
import type { CardExecutor, NewCardInput, ApprovalCard } from './approval-cards.js'
import type { CheckOutcome, Responsibility, ResponsibilityManager, ResponsibilitySignals, ThoughtPort } from './responsibilities.js'
import { redactSecrets } from '../security/secret-redaction.js'

export type MissionStatus = 'geplant' | 'in-arbeit' | 'wartet-auf-alfred' | 'blockiert' | 'abgeschlossen' | 'fehlgeschlagen'
export type StepStatus = 'offen' | 'laeuft' | 'erledigt' | 'fehlgeschlagen' | 'wartet' | 'abgelehnt'

export interface MissionStep {
    id: string
    kind: string
    titel: string
    node?: string
    ref?: string
    status: StepStatus
    runs: number
    level?: ActionLevel
    approvedBy?: string
    approvedAt?: string
    cardId?: string
    result?: string
}

export interface Mission {
    id: string
    responsibilityId: string
    titel: string
    anlass: string[]
    vertrag: { doneWhen: string[]; darf: string; fragenBei: string; nie: string }
    steps: MissionStep[]
    cursor: number
    versuche: number
    maxVersuche: number
    diagnosen: string[]
    budget: { startedAt: string; deadlineAt: string; maxToolCalls: number; toolCalls: number; maxKosten: 0; kosten: number }
    status: MissionStatus
    node: string
    createdAt: string
    updatedAt: string
    waitingStepId?: string
    handoff?: string
    grund?: string
    log: Array<{ at: string; text: string }>
}

export interface StepContext { approvedBy?: string; localNodeId: string; signals: () => Promise<ResponsibilitySignals> }
export interface StepResult { ok: boolean; message: string; toolCalls?: number; costUsd?: number; rolledBack?: boolean }
export interface StepExecutor { kind: string; run(step: MissionStep, mission: Mission, ctx: StepContext): Promise<StepResult> }

export interface MissionCardPort {
    create(input: NewCardInput): { ok: true; card: ApprovalCard; created: boolean } | { ok: false; reason: string }
    /** Card status ('offen', 'ja', 'abgelaufen', …) or undefined when unknown. */
    status?(cardId: string): string | undefined
}

export interface MissionEngineOptions {
    dataDir: string
    now?: () => number
    localNodeId: string
    /** True only on the fenced Main. Workers never create or run missions. */
    isMain: () => boolean
    responsibilities: ResponsibilityManager
    signals: () => ResponsibilitySignals | Promise<ResponsibilitySignals>
    executors: readonly StepExecutor[]
    ports: { thoughts: ThoughtPort; cards: MissionCardPort }
    budget?: { minutes?: number; maxToolCalls?: number }
    /** No new mission for the same responsibility this long after a blocked/failed one. */
    cooldownMs?: number
}

export interface MissionEngine {
    list(filter?: { status?: MissionStatus | MissionStatus[] }): Mission[]
    get(id: string): Mission | null
    startForViolations(outcomes: readonly CheckOutcome[]): Mission[]
    advance(id: string): Promise<Mission | null>
    tick(): Promise<{ active: boolean; reason?: string; advanced: string[] }>
    approveStep(missionId: string, stepId: string, ctx: { decidedBy: string }): Promise<{ ok: boolean; message: string }>
    rejectStep(missionId: string, stepId: string, ctx: { decidedBy: string }): Promise<{ ok: boolean; message: string }>
    isWaiting(missionId: string, stepId: string): boolean
    /** Test hook: replace the persisted plan (simulates a broken producer). */
    _replaceStepsForTest(missionId: string, steps: MissionStep[]): void
}

export const MAX_VERSUCHE = 3
const OPEN: readonly MissionStatus[] = ['geplant', 'in-arbeit', 'wartet-auf-alfred']
const TERMINAL: readonly MissionStatus[] = ['blockiert', 'abgeschlossen', 'fehlgeschlagen']
const KEEP_TERMINAL = 200
const LOG_LIMIT = 40
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60_000
export const MISSION_REF_PATTERN = /^(m-[a-f0-9]{12}):(s\d{1,2})$/
const SOURCE = 'mission'

const clean = (value: unknown, max: number) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)

const STEP_TITLES: Record<string, string> = {
    'diagnose': 'Diagnose (Messungen lesen)',
    'self-heal-zyklus': 'Selbstheilung (freigegebene Rezepte)',
    'dienst-neustart': 'Dienst neu starten',
    'install-katalog': 'Aus dem Katalog installieren',
    'geraet-einrichten': 'Gerät einrichten',
}

/** Fixed plan per derivation rule. Never from a model. */
export function planSteps(responsibility: Responsibility): MissionStep[] {
    const node = responsibility.scope[0]
    const step = (kind: string, extra: Partial<MissionStep> = {}): MissionStep => ({ id: '', kind, titel: STEP_TITLES[kind] || kind, status: 'offen', runs: 0, ...extra })
    const steps: MissionStep[] = [step('diagnose', { node })]
    if (responsibility.regel === 'knoten-gesund' && responsibility.aktionen.includes('self-heal-zyklus')) steps.push(step('self-heal-zyklus', { node }))
    if (responsibility.regel === 'dienst-laeuft' && responsibility.aktionen.includes('dienst-neustart')) {
        const ref = responsibility.kriterien[0]?.ref
        steps.push(step('dienst-neustart', { node, ref, titel: `Dienst neu starten: ${clean(responsibility.titel.replace(/ läuft$/, ''), 80)}` }))
    }
    return steps.map((item, index) => ({ ...item, id: `s${index + 1}` }))
}

export function createMissionEngine(options: MissionEngineOptions): MissionEngine {
    const now = options.now ?? Date.now
    const iso = () => new Date(now()).toISOString()
    const file = join(options.dataDir, 'missions', 'missions.json')
    const executors = new Map(options.executors.map(item => [item.kind, item]))
    const busy = new Set<string>()
    const budgetMinutes = Math.min(24 * 60, Math.max(5, Number(options.budget?.minutes) || 120))
    const maxToolCalls = Math.min(200, Math.max(2, Number(options.budget?.maxToolCalls) || 20))
    const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const isMain = () => { try { return options.isMain() === true } catch { return false } }
    const signals = async () => options.signals()

    const load = (): Mission[] => {
        try {
            const raw = JSON.parse(readFileSync(file, 'utf8'))
            return raw?.version === 1 && Array.isArray(raw.items) ? raw.items : []
        } catch { return [] }
    }
    const saveAll = (items: Mission[]) => {
        const open = items.filter(item => !TERMINAL.includes(item.status))
        const done = items.filter(item => TERMINAL.includes(item.status)).slice(-KEEP_TERMINAL)
        atomicWriteJsonSync(file, { version: 1, items: [...done, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) })
    }
    const save = (mission: Mission) => {
        mission.updatedAt = iso()
        mission.log = mission.log.slice(-LOG_LIMIT)
        const items = load()
        const index = items.findIndex(item => item.id === mission.id)
        if (index >= 0) items[index] = mission
        else items.push(mission)
        saveAll(items)
    }
    const note = (mission: Mission, text: string) => { mission.log.push({ at: iso(), text: clean(text, 300) }) }

    function handoffText(mission: Mission, why: string): string {
        const done = mission.steps.filter(step => step.status === 'erledigt').map(step => `${step.titel}${step.result ? ` (${clean(step.result, 80)})` : ''}`)
        const tried = mission.versuche ? `, ${mission.versuche} Versuch(e)` : ''
        return clean(`bis hier gekommen: ${done.length ? done.join('; ') : 'noch kein Schritt ausgeführt'}${tried}; brauche dich für: ${why}`, 900)
    }

    function finish(mission: Mission, status: 'blockiert' | 'fehlgeschlagen' | 'abgeschlossen', why: string): Mission {
        mission.status = status
        mission.waitingStepId = undefined
        if (status === 'abgeschlossen') {
            mission.grund = clean(why, 300)
            note(mission, `abgeschlossen: ${why}`)
            save(mission)
            options.ports.thoughts.add({
                source: SOURCE, title: `Erledigt: ${mission.titel}`, kind: 'ereignis', permission: 'selbst', severity: 'info',
                evidence: `${why}. Schritte: ${mission.steps.filter(step => step.status === 'erledigt').map(step => step.titel).join(', ')}`,
                signature: `mission:${mission.id}:abgeschlossen`, node: mission.node,
            })
            return mission
        }
        mission.grund = clean(why, 300)
        mission.handoff = handoffText(mission, why)
        note(mission, `${status}: ${why}`)
        save(mission)
        options.ports.thoughts.add({
            source: SOURCE, title: `Brauche dich: ${mission.titel}`, kind: 'ereignis', permission: 'selbst', severity: 'warning',
            evidence: mission.handoff, signature: `mission:${mission.id}:${status}`, node: mission.node,
        })
        return mission
    }

    function failAttempt(mission: Mission, why: string): Mission {
        mission.versuche++
        mission.diagnosen.push(clean(`Versuch ${mission.versuche} gescheitert: ${why}`, 300))
        if (mission.versuche >= mission.maxVersuche) return finish(mission, 'fehlgeschlagen', `${why} (nach ${mission.versuche} Versuchen)`)
        // next attempt on the next tick; it starts with a fresh diagnosis, approvals do not carry over
        mission.steps = mission.steps.map(step => ({ ...step, status: 'offen', approvedBy: undefined, approvedAt: undefined, cardId: undefined }))
        mission.cursor = 0
        mission.status = 'in-arbeit'
        note(mission, `Versuch ${mission.versuche} gescheitert, nächster Versuch folgt: ${why}`)
        save(mission)
        return mission
    }

    async function runSteps(mission: Mission): Promise<Mission> {
        const responsibility = options.responsibilities.get(mission.responsibilityId)
        if (!responsibility || responsibility.status !== 'aktiv') return finish(mission, 'blockiert', `Verantwortung ${mission.responsibilityId} ist nicht (mehr) aktiv`)
        while (mission.cursor < mission.steps.length) {
            const step = mission.steps[mission.cursor]
            if (now() > Date.parse(mission.budget.deadlineAt)) return finish(mission, 'fehlgeschlagen', `Zeitbudget (${budgetMinutes} min) aufgebraucht`)
            if (mission.budget.toolCalls >= mission.budget.maxToolCalls) return finish(mission, 'fehlgeschlagen', `Budget (${mission.budget.maxToolCalls} Tool-Calls) aufgebraucht`)
            // The policy decides on every run — an approval never lifts L3.
            const verdict = evaluateAction({ kind: step.kind, node: step.node, origin: 'mission' }, { localNodeId: options.localNodeId })
            step.level = verdict.level
            if (verdict.decision === 'never' || verdict.decision === 'handoff') return finish(mission, 'blockiert', `${step.titel} — ${verdict.reason} (mache ich nie selbst)`)
            if (!responsibility.aktionen.includes(step.kind)) return finish(mission, 'blockiert', `${step.titel} — nicht im Vertrag der Verantwortung`)
            const executor = executors.get(step.kind)
            if (!executor) return finish(mission, 'blockiert', `${step.titel} — kein registrierter Ausführungsweg`)
            if (verdict.decision === 'ask' && !step.approvedBy) {
                const done = mission.steps.filter(item => item.status === 'erledigt').map(item => item.titel)
                const card = options.ports.cards.create({
                    art: 'mission-schritt',
                    titel: `${mission.titel}: ${step.titel}?`,
                    beleg: `Anlass: ${mission.anlass.join('; ')}. Bisher: ${done.join(', ') || '—'}.`,
                    vorschlag: `Genau diesen Schritt ausführen (${verdict.reason}). Danach mache ich mit der Mission weiter.`,
                    aktion: { kind: 'mission-schritt', ref: `${mission.id}:${step.id}` },
                    wirkung: verdict.impact,
                    node: step.node || mission.node,
                    quelle: SOURCE,
                    dedupeKey: `mission:${mission.id}:${step.id}:${mission.versuche}`,
                    ablaufMs: 24 * 60 * 60_000,
                })
                if (card.ok === false) return finish(mission, 'blockiert', `${step.titel} — Rückfrage nicht möglich (${'reason' in card ? card.reason : '?'})`)
                step.status = 'wartet'
                step.cardId = card.card.id
                mission.status = 'wartet-auf-alfred'
                mission.waitingStepId = step.id
                note(mission, `wartet auf Alfred: ${step.titel}`)
                save(mission)
                return mission
            }
            step.status = 'laeuft'
            step.runs++
            mission.budget.toolCalls++
            save(mission)
            let result: StepResult
            try {
                result = await executor.run(step, mission, { approvedBy: step.approvedBy, localNodeId: options.localNodeId, signals })
            } catch (error) {
                result = { ok: false, message: `Fehler: ${clean((error as Error)?.message || error, 200)}` }
            }
            mission.budget.toolCalls += Math.max(0, Math.floor(Number(result.toolCalls) || 0))
            const cost = Number(result.costUsd) || 0
            mission.budget.kosten += cost
            step.result = clean(result.message, 300)
            if (verdict.level !== 'L0') recordActionOutcome(step.kind, { ok: result.ok === true, rolledBack: result.rolledBack === true }, { dataDir: options.dataDir, now })
            if (step.kind === 'diagnose') mission.diagnosen.push(clean(`Versuch ${mission.versuche + 1}, Diagnose: ${result.message}`, 300))
            if (cost > mission.budget.maxKosten) {
                step.status = 'fehlgeschlagen'
                return finish(mission, 'fehlgeschlagen', `${step.titel} — Kostenbudget 0 überschritten`)
            }
            if (result.ok !== true) {
                step.status = 'fehlgeschlagen'
                note(mission, `${step.titel}: ${result.message}`)
                return failAttempt(mission, `${step.titel}: ${result.message}`)
            }
            step.status = 'erledigt'
            note(mission, `${step.titel}: ${result.message}`)
            mission.cursor++
            if (verdict.level === 'L2') {
                const proposal = trustUpgradeProposal(step.kind, { dataDir: options.dataDir, now })
                if (proposal) options.ports.thoughts.add({ source: 'vertrauen', title: proposal.titel, evidence: proposal.text, kind: 'vorschlag', permission: 'selbst', severity: 'info', signature: `vertrauen:${proposal.kind}` })
            }
            save(mission)
            const measured = options.responsibilities.measure(responsibility, await signals())
            if (measured.erfuellt === true) return finish(mission, 'abgeschlossen', measured.ergebnisse.map(item => item.befund).join('; ') || 'Kriterium erfüllt')
        }
        const measured = options.responsibilities.measure(responsibility, await signals())
        if (measured.erfuellt === true) return finish(mission, 'abgeschlossen', measured.ergebnisse.map(item => item.befund).join('; ') || 'Kriterium erfüllt')
        const why = measured.ergebnisse.filter(item => item.erfuellt !== true).map(item => item.befund).join('; ') || 'Kriterium nicht bestätigt'
        return failAttempt(mission, `Kriterium weiter verletzt: ${why}`)
    }

    async function withLock(id: string, fn: () => Promise<Mission | null>): Promise<Mission | null> {
        if (busy.has(id)) return engine.get(id)
        busy.add(id)
        try { return await fn() } finally { busy.delete(id) }
    }

    const engine: MissionEngine = {
        list(filter = {}) {
            const wanted = filter.status ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status]) : null
            return load().filter(item => !wanted || wanted.has(item.status))
        },
        get(id) {
            return load().find(item => item.id === id) || null
        },
        startForViolations(outcomes) {
            if (!isMain()) return []
            const items = load()
            const created: Mission[] = []
            for (const outcome of outcomes) {
                const responsibility = outcome.responsibility
                if (outcome.erfuellt !== false || responsibility.status !== 'aktiv') continue
                const mine = items.filter(item => item.responsibilityId === responsibility.id)
                if (mine.some(item => OPEN.includes(item.status))) continue
                if (mine.some(item => (item.status === 'blockiert' || item.status === 'fehlgeschlagen') && now() - Date.parse(item.updatedAt) < cooldownMs)) continue
                const at = iso()
                const mission: Mission = {
                    id: `m-${randomBytes(6).toString('hex')}`,
                    responsibilityId: responsibility.id,
                    titel: clean(responsibility.titel, 120),
                    anlass: outcome.verletzt.map(item => clean(item.befund, 200)).slice(0, 5),
                    vertrag: {
                        doneWhen: responsibility.kriterien.map(item => clean(item.text, 120)),
                        darf: 'L0/L1 automatisch (lesen, eigene umkehrbare Wartung)',
                        fragenBei: 'L2 — jeder folgenreiche Schritt per Knopf, genau einmal',
                        nie: 'L3 — Nie-Liste, weder automatisch noch per Knopf',
                    },
                    steps: planSteps(responsibility),
                    cursor: 0,
                    versuche: 0,
                    maxVersuche: MAX_VERSUCHE,
                    diagnosen: [],
                    budget: { startedAt: at, deadlineAt: new Date(now() + budgetMinutes * 60_000).toISOString(), maxToolCalls, toolCalls: 0, maxKosten: 0, kosten: 0 },
                    status: 'geplant',
                    node: responsibility.scope[0] || options.localNodeId,
                    createdAt: at,
                    updatedAt: at,
                    log: [{ at, text: `geplant: ${outcome.verletzt.map(item => item.befund).join('; ').slice(0, 250)}` }],
                }
                items.push(mission)
                created.push(mission)
            }
            if (created.length) saveAll(items)
            return created
        },
        async advance(id) {
            if (!isMain()) return engine.get(id)
            return withLock(id, async () => {
                const mission = engine.get(id)
                if (!mission || TERMINAL.includes(mission.status) || mission.status === 'wartet-auf-alfred') return mission
                if (mission.status === 'geplant') note(mission, 'in Arbeit')
                mission.status = 'in-arbeit'
                return runSteps(mission)
            })
        },
        async tick() {
            if (!isMain()) return { active: false, reason: 'kein Main (Worker oder ohne Fence)', advanced: [] }
            const advanced: string[] = []
            for (const mission of engine.list({ status: [...OPEN] })) {
                if (mission.status === 'wartet-auf-alfred') {
                    const step = mission.steps.find(item => item.id === mission.waitingStepId)
                    const status = step?.cardId ? options.ports.cards.status?.(step.cardId) : undefined
                    if (step && (status === 'abgelaufen' || status === 'erledigt' || (options.ports.cards.status && status === undefined))) {
                        await withLock(mission.id, async () => finish(mission, 'blockiert', `${step.titel} — Karte ${status || 'verschwunden'}, keine Antwort`))
                    }
                    continue
                }
                await engine.advance(mission.id)
                advanced.push(mission.id)
            }
            return { active: true, advanced }
        },
        async approveStep(missionId, stepId, ctx) {
            if (!isMain()) return { ok: false, message: 'Nur der Main führt Missionen aus — nichts ausgeführt.' }
            let message = ''
            const final = await withLock(missionId, async () => {
                const mission = engine.get(missionId)
                if (!mission) { message = 'Mission nicht mehr vorhanden — nichts ausgeführt.'; return null }
                const step = mission.steps.find(item => item.id === stepId)
                if (mission.status !== 'wartet-auf-alfred' || mission.waitingStepId !== stepId || !step) {
                    message = 'Die Mission wartet nicht (mehr) auf diesen Schritt — nichts ausgeführt.'
                    return null
                }
                step.approvedBy = clean(ctx.decidedBy, 60)
                step.approvedAt = iso()
                step.status = 'offen'
                mission.status = 'in-arbeit'
                mission.waitingStepId = undefined
                note(mission, `Alfred: Ja zu „${step.titel}“`)
                save(mission)
                return runSteps(mission)
            })
            if (!final) return { ok: false, message: message || 'Gerade beschäftigt — bitte gleich noch einmal.' }
            const step = final.steps.find(item => item.id === stepId)
            return { ok: true, message: `${step?.titel || 'Schritt'}: ${step?.status === 'erledigt' ? `ausgeführt (${step.result || 'ok'})` : step?.status || '?'}. Mission: ${final.status}.` }
        },
        async rejectStep(missionId, stepId, ctx) {
            let message = ''
            const final = await withLock(missionId, async () => {
                const mission = engine.get(missionId)
                const step = mission?.steps.find(item => item.id === stepId)
                if (!mission || !step || mission.status !== 'wartet-auf-alfred' || mission.waitingStepId !== stepId) {
                    message = 'Die Mission wartet nicht (mehr) auf diesen Schritt.'
                    return null
                }
                step.status = 'abgelehnt'
                note(mission, `Alfred: Nein zu „${step.titel}“ (${clean(ctx.decidedBy, 60)})`)
                return finish(mission, 'blockiert', `${step.titel} (Alfred hat Nein gesagt)`)
            })
            return final ? { ok: true, message: `Verstanden, Mission blockiert. ${final.handoff || ''}`.trim() } : { ok: false, message }
        },
        isWaiting(missionId, stepId) {
            const mission = engine.get(missionId)
            return Boolean(mission && mission.status === 'wartet-auf-alfred' && mission.waitingStepId === stepId)
        },
        _replaceStepsForTest(missionId, steps) {
            const mission = engine.get(missionId)
            if (!mission) return
            mission.steps = steps
            mission.cursor = 0
            save(mission)
        },
    }
    return engine
}

/** Card executor `mission-schritt`: [Ja] runs exactly the waiting step and continues; [Nein] blocks with handoff. */
export function createMissionCardExecutor(getEngine: () => MissionEngine | null): CardExecutor {
    const parse = (ref: string) => MISSION_REF_PATTERN.exec(String(ref || ''))
    return {
        kind: 'mission-schritt',
        impact: 'intern',
        async execute(card, _answer, ctx) {
            const match = parse(card.aktion.ref)
            const engine = getEngine()
            if (!match || !engine) return { ok: false, message: 'Missionen sind aus oder die Referenz ist ungültig — nichts ausgeführt.' }
            return engine.approveStep(match[1], match[2], { decidedBy: ctx.decidedBy })
        },
        async reject(card, ctx) {
            const match = parse(card.aktion.ref)
            const engine = getEngine()
            if (!match || !engine) return { ok: true, message: 'Abgelehnt.' }
            return engine.rejectStep(match[1], match[2], { decidedBy: ctx.decidedBy })
        },
        isStillOpen(card) {
            const match = parse(card.aktion.ref)
            const engine = getEngine()
            if (!engine) return true
            return Boolean(match && engine.isWaiting(match[1], match[2]))
        },
    }
}
