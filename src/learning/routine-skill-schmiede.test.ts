import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoutineSkillStore, setRoutineSkillStore, type ObserveInput, type RoutineSkill, type RoutineSkillEvent } from './routine-skills.js'
import type { NovaTool } from '../tools/complete-registry.js'
import {
    approveSkillProposal, buildTool, getForgeTool, noteForgeNeed, setForgeModel, setForgeNotifier, setForgePermissionResolver, setForgeRegistry,
    type BuildResult, type ForgeDraft,
} from '../tools/skill-builder.js'
import { getNovaDataDir } from '../core/data-root.js'

// 2.83.0 Punkt 9: ein Werkzeug der Schmiede, gebaut aus der Wiederholung eines
// Routine-Skills, ersetzt dort den allgemeinen Schritt. Gemessen wird gegen die
// alte Version; ist die neue schlechter, geht der Skill selbst zurück.
let dir: string
let events: RoutineSkillEvent[]
let store: RoutineSkillStore
const OWNER = 'owner@example.com'
const registered = new Map<string, NovaTool>()
const registry = {
    register: (tool: NovaTool) => { registered.set(tool.name, tool) },
    unregister: (name: string) => registered.delete(name),
    get: (name: string) => registered.get(name),
}

let runCounter = 0
const python = [{ toolName: 'execute_python', params: { code: 'len(open(log).readlines())' }, success: true }]
function run(): ObserveInput {
    return { runId: `run-${++runCounter}`, principalId: OWNER, permission: 'owner', request: 'Zähl die Zeilen im Server-Log', intentKind: 'lookup', steps: python, success: true }
}
function learnSkill(): RoutineSkill {
    store.observe(run()); store.observe(run())
    const third = store.observe(run()) as { created?: RoutineSkill }
    expect(third.created?.steps[0].tool).toBe('execute_python')
    return third.created!
}

let toolCounter = 0
const zeilenDraft = (overrides: Partial<ForgeDraft> = {}): ForgeDraft => ({
    name: `zeilen_zaehlen_${++toolCounter}_${Date.now() % 100000}`,
    description: 'Zählt die Zeilen eines Logs von logs.example.com', why: 'Routine nutzt immer wieder execute_python',
    code: `export default async function (params, ctx) {
  const r = await ctx.fetch('https://logs.example.com/server.log')
  const text = await r.text()
  return { zeilen: text.split('|').length }
}`,
    parameters: [],
    manifest: { net: ['logs.example.com'], fs: [], wirkung: 'lesend' },
    tests: [{ name: 'drei', params: {}, fetch: [{ url: 'https://logs.example.com/server.log', body: 'a|b|c' }], expect: { equals: { zeilen: 3 } } }],
    ownerId: OWNER, origin: 'bedarf',
    ...overrides,
})

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routine-schmiede-'))
    events = []
    store = new RoutineSkillStore({ dir, notify: event => events.push(event) })
    setRoutineSkillStore(store)
    registered.clear()
    setForgeRegistry(registry)
    setForgeNotifier(() => undefined)
    setForgePermissionResolver(async () => 'owner')
    setForgeModel(null)
})
afterEach(() => {
    setRoutineSkillStore(null)
    setForgeRegistry(null)
    setForgeNotifier(undefined)
    setForgePermissionResolver(null)
    setForgeModel(null)
    rmSync(dir, { recursive: true, force: true })
})

describe('Schmiede-Werkzeug fließt in den Routine-Skill zurück (Punkt 9)', () => {
    it('Übernahme: Bedarf „wiederholung“ → lesendes Werkzeug aktiv → Skill v2 nutzt forge_…', async () => {
        const skill = learnSkill()
        const draft = zeilenDraft()
        setForgeModel({ complete: async () => ({ content: JSON.stringify(draft) }) })
        let built: BuildResult | null = null
        const queued = noteForgeNeed({ principalId: OWNER, permission: 'owner', request: 'Zähl die Zeilen im Server-Log', routineSkillCreated: skill },
            { allowInTests: true, onBuilt: result => { built = result } })
        expect(queued).toMatchObject({ queued: true, kind: 'wiederholung' })
        await expect.poll(() => built?.proposal?.status ?? null, { timeout: 15_000 }).toBe('active')
        const adopted = store.get(skill.id)!
        expect(adopted.steps[0].tool).toBe(`forge_${draft.name}`)
        expect(adopted.version).toBe(2)
        expect(adopted.enabled).toBe(true)
        expect(adopted.history.map(item => item.version)).toEqual([1])
        expect(adopted.history[0].steps[0].tool).toBe('execute_python')
        expect(events.some(event => event.kind === 'werkzeug')).toBe(true)
        // Der Bedarf merkt sich Skill und ersetztes Werkzeug.
        const needs = JSON.parse(readFileSync(getNovaDataDir('forge', 'bedarf.json'), 'utf8')).needs
        expect(needs.some((need: any) => need.skillId === skill.id && need.from === 'execute_python')).toBe(true)
        // Keine Doppelung: eine neue Version desselben Werkzeugs übernimmt nicht noch einmal.
        expect(store.adoptTool(skill.id, 'execute_python', `forge_${draft.name}`)).toBeNull()
        expect(store.get(skill.id)!.version).toBe(2)
    })

    it('Rücksprung: 2 Fehlschläge der neuen Version → v3 mit execute_python, Skill bleibt an', () => {
        const skill = learnSkill()
        expect(store.adoptTool(skill.id, 'execute_python', 'forge_zeilen')?.version).toBe(2)
        store.recordOutcome(skill.id, false)
        const back = store.recordOutcome(skill.id, false)!
        expect(back.version).toBe(3)
        expect(back.steps[0].tool).toBe('execute_python')
        expect(back.enabled).toBe(true)
        expect(back.consecutiveFailures).toBe(0)
        const event = events.find(item => item.kind === 'zurueckgesetzt')
        expect(event?.detail).toMatch(/forge_zeilen hat .* nicht verbessert, zurück auf v1/)
        // Danach gilt wieder die normale Regel (2 Fehlschläge schalten ab).
        store.recordOutcome(skill.id, false)
        expect(store.recordOutcome(skill.id, false)?.enabled).toBe(false)
    })

    it('Vergleich: schlechtere Quote als die alte Version → zurück, auch ohne 2 Fehlschläge in Folge', () => {
        const skill = learnSkill()
        for (let index = 0; index < 10; index++) store.recordOutcome(skill.id, index !== 0) // alt: 9/10
        store.adoptTool(skill.id, 'execute_python', 'forge_zeilen')
        for (const ok of [true, false, true, false]) expect(store.recordOutcome(skill.id, ok)?.version).toBe(2)
        const back = store.recordOutcome(skill.id, true)! // neu: 3/5 = 60 % < 90 %
        expect(back.version).toBe(3)
        expect(back.steps[0].tool).toBe('execute_python')
        expect(events.find(item => item.kind === 'zurueckgesetzt')?.detail).toMatch(/3\/5.*9\/10/)
    })

    it('Bestätigung: 5/5 ok → Gedanke „Skill nutzt jetzt …“, Version bleibt', () => {
        const skill = learnSkill()
        store.adoptTool(skill.id, 'execute_python', 'forge_zeilen')
        for (let index = 0; index < 5; index++) store.recordOutcome(skill.id, true)
        const kept = store.get(skill.id)!
        expect(kept.version).toBe(2)
        expect(kept.steps[0].tool).toBe('forge_zeilen')
        expect(kept.adoption?.status).toBe('bestaetigt')
        expect(events.find(item => item.kind === 'werkzeug-bestaetigt')?.detail).toMatch(/5\/5 ok/)
    })

    it('Gegenprobe: Skill ohne den ersetzten Schritt, abgeschalteter Skill → keine neue Version', () => {
        const skill = learnSkill()
        expect(store.adoptTool(skill.id, 'fetch_url', 'forge_zeilen')).toBeNull()
        store.setEnabled(skill.id, false)
        expect(store.adoptTool(skill.id, 'execute_python', 'forge_zeilen')).toBeNull()
        expect(store.get(skill.id)!.version).toBe(1)
    })

    it('Gegenprobe: schreibendes Werkzeug wird auch nach Owner-Freigabe nicht automatisch übernommen', async () => {
        const skill = learnSkill()
        const draft = zeilenDraft({ manifest: { net: ['logs.example.com'], fs: [], wirkung: 'schreibend' }, adoptFor: { skillId: skill.id, from: 'execute_python' } })
        const result = await buildTool(draft)
        expect(result.proposal?.status).toBe('awaiting-approval')
        expect(approveSkillProposal(result.proposal!.id, 'owner')?.status).toBe('active')
        expect(getForgeTool(result.proposal!.id)?.adoptFor).toEqual({ skillId: skill.id, from: 'execute_python' })
        expect(store.get(skill.id)!.steps[0].tool).toBe('execute_python')
        expect(store.get(skill.id)!.version).toBe(1)
    })
})
