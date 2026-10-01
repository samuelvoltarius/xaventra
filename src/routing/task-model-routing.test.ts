import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
    TASK_MODEL_RULES,
    classifyTaskModel,
    codexFallbackNotice,
    decideTaskModel,
    describeCodexRouting,
    type TaskModelDecisionInput,
} from './task-model-routing.js'

// CL-20260930-12: the model choice is made per task by a fixed rule table,
// never by the model itself. Findings that started this (live 30.09./01.10.):
// routing was global (codex.enabled → every message to Codex, incl. smalltalk
// and images), /codex status said "wird bevorzugt" while codex.enabled=false,
// and the app-server route had no owner check.

const ownerEnabled: Omit<TaskModelDecisionInput, 'signals'> = {
    permission: 'owner', codexEnabled: true,
}

type DecideExtra = Partial<Omit<TaskModelDecisionInput, 'signals'>> & { signals?: Partial<TaskModelDecisionInput['signals']> }

function decide(content: string, extra: DecideExtra = {}) {
    return decideTaskModel({ ...ownerEnabled, ...extra, signals: { content, ...(extra.signals || {}) } })
}

describe('task model classification (fixed, deterministic)', () => {
    it('classifies code, larger refactors and hard debugging as Codex work', () => {
        expect(classifyTaskModel({ content: 'Schreib mir eine TypeScript-Funktion, die eine CSV-Datei parst und Tests dazu.' }).taskClass).toBe('code')
        expect(classifyTaskModel({ content: 'Bau das Routing-Modul um und verteil die Logik auf mehrere Dateien, das ist ein größerer Umbau.' }).taskClass).toBe('refactor')
        expect(classifyTaskModel({ content: 'Der Build schlägt fehl: TypeError: Cannot read properties of undefined at runner.ts:300 — finde die Ursache.' }).taskClass).toBe('debug')
    })

    it('classifies smalltalk, short questions and images as local work', () => {
        expect(classifyTaskModel({ content: 'Hallo, wie geht es dir heute?' }).taskClass).toBe('smalltalk')
        expect(classifyTaskModel({ content: 'danke dir' }).taskClass).toBe('smalltalk')
        expect(classifyTaskModel({ content: 'Wie spät ist es in Tokio?' }).taskClass).toBe('short')
        expect(classifyTaskModel({ content: 'Was siehst du auf dem Bild?', hasImage: true }).taskClass).toBe('vision')
        expect(classifyTaskModel({ content: 'Mach einen Screenshot vom Desktop', intentKind: 'screenshot' }).taskClass).toBe('vision')
    })

    it('marks memory and customer data as private even inside a code task', () => {
        const result = classifyTaskModel({ content: 'Schreib ein Python-Skript, das die Kundendaten aus meiner Kundenliste exportiert.' })
        expect(result.taskClass).toBe('code')
        expect(result.private).toBe(true)
        expect(classifyTaskModel({ content: 'Was weißt du aus deinem Gedächtnis über meine Familie?' }).private).toBe(true)
        expect(classifyTaskModel({ content: 'Refactor der Parser-Klasse', privateContext: true }).private).toBe(true)
    })
})

describe('task model decision table', () => {
    it('keeps smalltalk local even when Codex is enabled, available and the owner asks', () => {
        const decision = decide('Hallo, wie geht es dir heute?', { codexAvailable: true })
        expect(decision.target).toBe('local')
        expect(decision.wouldBe).toBe('local')
        expect(decision.rule).toBe('R3-light-local')
    })

    it('never sends an image to Codex, even for the owner with a code question', () => {
        const decision = decide('Was ist in diesem Code-Screenshot falsch? Schreib die Funktion neu.', {
            codexAvailable: true, signals: { hasImage: true },
        })
        expect(decision.target).toBe('local')
        expect(decision.rule).toBe('R1-vision-local')
        // An owner yes for private text does not release pictures.
        expect(decide('Bild', { ownerApprovedExternal: true, signals: { hasImage: true } }).target).toBe('local')
    })

    it('keeps private content local without an owner yes and releases it only with one', () => {
        const privateCode = 'Schreib ein Python-Skript, das die Kundendaten exportiert.'
        expect(decide(privateCode, { codexAvailable: true }).target).toBe('local')
        expect(decide(privateCode, { codexAvailable: true }).rule).toBe('R2-private-local')
        expect(decide(privateCode, { codexAvailable: true, ownerApprovedExternal: true }).target).toBe('codex')
    })

    it('gives Codex only to the owner', () => {
        const code = 'Schreib mir eine TypeScript-Funktion mit Unit-Tests.'
        for (const permission of ['admin', 'user', 'guest', undefined]) {
            const decision = decide(code, { permission, codexAvailable: true })
            expect(decision.target).toBe('local')
            expect(decision.rule).toBe('R4-non-owner-local')
        }
        expect(decide(code, { codexAvailable: true }).target).toBe('codex')
    })

    it('reports "wäre Codex, aber aus" when codex.enabled=false', () => {
        const decision = decide('Schreib mir eine TypeScript-Funktion mit Unit-Tests.', { codexEnabled: false, codexAvailable: true })
        expect(decision.target).toBe('local')
        expect(decision.wouldBe).toBe('codex')
        expect(decision.rule).toBe('R5-disabled')
        expect(decision.reason).toContain('wäre Codex, aber aus')
    })

    it('falls back to local with a user notice on exhausted quota or outage', () => {
        const quota = decide('Bau das Modul um, größerer Umbau über mehrere Dateien.', { codexQuotaExhausted: true, codexAvailable: true })
        expect(quota.target).toBe('local')
        expect(quota.rule).toBe('R6-quota-local')
        expect(quota.notice).toMatch(/Quote/)
        const down = decide('Finde die Ursache für den Stacktrace im Build.', { codexAvailable: false })
        expect(down.target).toBe('local')
        expect(down.rule).toBe('R7-unavailable-local')
        expect(down.notice).toMatch(/lokal/)
    })

    it('has exactly one rule per id and a codex rule at the end', () => {
        const ids = TASK_MODEL_RULES.map(rule => rule.id)
        expect(new Set(ids).size).toBe(ids.length)
        expect(TASK_MODEL_RULES.at(-1)?.target).toBe('codex')
        expect(TASK_MODEL_RULES.filter(rule => rule.target === 'codex')).toHaveLength(1)
    })

    it('words a runtime Codex failover as a user notice, separating quota from outage', () => {
        expect(codexFallbackNotice('429 usage limit reached for this plan')).toMatch(/Quote/)
        expect(codexFallbackNotice('Codex auf diesem Node nicht installiert')).toMatch(/nicht erreichbar|nicht verfügbar/)
        expect(codexFallbackNotice('x')).toMatch(/lokal/)
    })
})

describe('/codex status wording (pure)', () => {
    const base = { fallbackLabel: 'vLLM `qwen` auf `spark`', permission: 'owner' as string | undefined }

    it('says off and "wäre Codex, aber aus" when disabled, never "bevorzugt"', () => {
        const text = describeCodexRouting({ ...base, enabled: false, available: true, activeNodeId: 'spark' })
        expect(text).toContain('aus')
        expect(text).toContain('wäre Codex, aber aus')
        expect(text).not.toMatch(/bevorzugt/)
    })

    it('names the task kinds Codex is chosen for when enabled and available', () => {
        const text = describeCodexRouting({ ...base, enabled: true, available: true, activeNodeId: 'spark' })
        expect(text).toMatch(/wird für .*Code.* gewählt/)
        expect(text).toMatch(/Smalltalk/)
        expect(text).toMatch(/lokal/)
    })

    it('says enabled but unavailable, and owner-only for others', () => {
        expect(describeCodexRouting({ ...base, enabled: true, available: false })).toMatch(/nicht verfügbar/)
        expect(describeCodexRouting({ ...base, enabled: true, available: true, permission: 'user' })).toMatch(/nur für den Owner/)
    })
})

describe('nova-runner uses the per-task decision at the routing site', () => {
    const source = readFileSync(new URL('../agents/nova-runner.ts', import.meta.url), 'utf8')

    it('routes to Codex only when the task decision says codex', () => {
        expect(source).toMatch(/decideRunnerTaskModel\(/)
        expect(source).toMatch(/if \(!modelOverride\?\.model && taskModel\.target === 'codex'\)/)
        expect(source).not.toMatch(/if \(!modelOverride\?\.model && codexConfig\?\.enabled\)/)
    })

    it('records decision and reason in the OutcomeLedger', () => {
        const site = source.slice(source.indexOf('decideRunnerTaskModel('), source.indexOf("taskModel.target === 'codex'"))
        expect(site).toMatch(/outcomeLedger\.recordRoute\(kernel\.contract\.id, \{[\s\S]*modelClass: taskModel\.taskClass[\s\S]*reason: `\$\{taskModel\.rule\}/)
    })

    it('tells the user when Codex falls back to local', () => {
        expect(source).toMatch(/codexFallbackNotice\(safeReason\)/)
    })
})
