/**
 * 2.88 „Was ich nicht kann, lerne ich“ — die Teile der Werkzeug-Schmiede, die
 * das Lernen braucht: Bau auf Owner-Ja im selben Tageslimit, Selbsttest mit
 * einem echten Beispiel (nur lesend), Laufzeit für die Messung danach.
 */
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NovaTool } from './complete-registry.js'
import { getNovaDataDir } from '../core/data-root.js'
import {
    buildTool, buildToolForLearning, getForgeTool, runForgeTool, selfTestForgeTool,
    setForgeModel, setForgeNotifier, setForgePermissionResolver, setForgeRegistry, type ForgeDraft,
} from './skill-builder.js'

const registered = new Map<string, NovaTool>()
const registry = {
    register: (tool: NovaTool) => { registered.set(tool.name, tool) },
    unregister: (name: string) => registered.delete(name),
    get: (name: string) => registered.get(name),
}
let counter = 0
const unique = (base: string) => `${base}_${++counter}_${Date.now() % 100000}`

const addCode = `export default async function (params) { return { summe: Number(params.a) + 1 } }`
const addDraft = (name: string, wirkung: 'lesend' | 'schreibend' = 'lesend'): ForgeDraft => ({
    name, description: 'Zählt eins dazu', why: 'Test', code: addCode,
    parameters: [{ name: 'a', type: 'number', description: 'Zahl', required: true }],
    manifest: { net: [], fs: [], wirkung },
    tests: [{ name: 'eins', params: { a: 1 }, expect: { equals: { summe: 2 } } }],
    ownerId: 'owner-example', origin: 'owner',
})
const kursTests = [{ name: 'CHF', params: { to: 'CHF' }, fetch: [{ url: 'https://api.example.com/latest', body: '{"rates":{"CHF":2}}' }], expect: { equals: { kurs: 2 } } }]
const modelDraft = () => vi.fn(async () => ({ content: JSON.stringify({
    description: 'Holt den Kurs', why: 'gelernt',
    code: `export default async function (params, ctx) { const r = await ctx.fetch('https://api.example.com/latest?to=' + params.to); const d = await r.json(); return { kurs: d.rates[params.to] } }`,
    manifest: { net: ['api.example.com'], fs: [], wirkung: 'lesend' }, tests: kursTests, parameters: [{ name: 'to', type: 'string', description: 'Zielwährung' }],
}) }))

beforeEach(() => {
    rmSync(getNovaDataDir('forge', 'bedarf.json'), { force: true })
    registered.clear()
    setForgeRegistry(registry)
    setForgeNotifier(null)
    setForgePermissionResolver(async () => 'owner')
    setForgeModel(null)
})
afterEach(() => {
    setForgeRegistry(null)
    setForgeNotifier(undefined)
    setForgePermissionResolver(null)
    setForgeModel(null)
})

describe('Schmiede für das Lernen', () => {
    it('Aufrufe zählen ihre Laufzeit (für die Messung nach dem Lernen)', async () => {
        const built = await buildTool(addDraft(unique('plus_eins')))
        expect(built.proposal?.status).toBe('active')
        const result = await runForgeTool(built.proposal!.id, { a: 41 })
        expect(result).toMatchObject({ success: true, result: { summe: 42 } })
        const counters = getForgeTool(built.proposal!.id)!.counters
        expect(counters.calls).toBe(1)
        expect(typeof counters.totalMs).toBe('number')
        expect(counters.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('Selbsttest: echtes Beispiel in der Sandbox, nur für lesende Werkzeuge', async () => {
        const reading = await buildTool(addDraft(unique('plus_eins_test')))
        const test = await selfTestForgeTool(reading.proposal!.id)
        expect(test.ok).toBe(true)
        expect(getForgeTool(reading.proposal!.id)!.counters).toMatchObject({ calls: 1, successes: 1 })

        const writing = await buildTool(addDraft(unique('plus_eins_schreibend'), 'schreibend'))
        expect(writing.proposal?.status).toBe('awaiting-approval')
        expect((await selfTestForgeTool(writing.proposal!.id)).ok).toBe(false)
        expect(getForgeTool(writing.proposal!.id)!.counters.calls).toBe(0)
    })

    it('Bau auf Owner-Ja: ohne Lern-Modell ehrlich nichts; mit Modell gebaut; Tageslimit geteilt → „später“', async () => {
        expect(await buildToolForLearning({ request: 'Baue ein Werkzeug für: Kurs', why: 'Lernen', ownerId: 'owner-example', signature: 'a' }))
            .toMatchObject({ proposal: null, message: 'kein lokales Lern-Modell' })
        const complete = modelDraft()
        setForgeModel({ complete })
        const now = Date.parse('2026-10-07T09:00:00Z')
        for (const signature of ['a', 'b', 'c']) {
            const built = await buildToolForLearning({ request: `Baue ein Werkzeug für: Kurs ${signature}`, why: 'Lernen', ownerId: 'owner-example', signature, now })
            expect(built.deferred).toBeUndefined()
        }
        expect(complete).toHaveBeenCalledTimes(3)
        const fourth = await buildToolForLearning({ request: 'Baue ein Werkzeug für: Kurs d', why: 'Lernen', ownerId: 'owner-example', signature: 'd', now })
        expect(fourth).toMatchObject({ proposal: null, deferred: true })
        expect(complete).toHaveBeenCalledTimes(3)
    })
})
