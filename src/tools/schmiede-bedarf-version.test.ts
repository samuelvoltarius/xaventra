/**
 * 2.84.0 Punkt 4: Die Werkzeug-Schmiede bekommt echten Bedarf (ein vom Modell
 * angefordertes, nirgends registriertes Werkzeug), neue Versionen zählen ins
 * selbe Tageslimit, und ein „Ja“ auf eine Schmiede-Idee schaltet kein
 * funktionierendes Werkzeug ab (Kandidat statt Ersatz).
 */
import { readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelRequest } from '@openai/agents'
import type { NovaTool } from './complete-registry.js'
import { NovaAgentsModel } from '../agents/nova-model-provider.js'
import { getNovaDataDir } from '../core/data-root.js'
import {
    buildTool, getForgeTool, missingToolFailures, noteForgeNeed, reviseTool,
    setForgeModel, setForgeNotifier, setForgePermissionResolver, setForgeRegistry, type ForgeDraft,
} from './skill-builder.js'

const registered = new Map<string, NovaTool>()
const events: Array<{ kind: string; text: string }> = []
const registry = {
    register: (tool: NovaTool) => { registered.set(tool.name, tool) },
    unregister: (name: string) => registered.delete(name),
    get: (name: string) => registered.get(name),
}
let counter = 0
const unique = (base: string) => `${base}_${++counter}_${Date.now() % 100000}`
const owner = { principalId: 'owner-example', permission: 'owner' }

const kursCode = (factor: number) => `export default async function (params, ctx) {
  const r = await ctx.fetch('https://api.example.com/latest?to=' + params.to)
  const data = await r.json()
  return { kurs: data.rates[params.to] * ${factor} }
}`
const kursTests = [{ name: 'CHF', params: { to: 'CHF' }, fetch: [{ url: 'https://api.example.com/latest', body: '{"rates":{"CHF":2}}' }], expect: { equals: { kurs: 2 } } }]
const kursDraft = (name: string): ForgeDraft => ({
    name, description: 'Holt den Kurs', why: 'Owner fragt das täglich', code: kursCode(1),
    parameters: [{ name: 'to', type: 'string', description: 'Zielwährung', required: true }],
    manifest: { net: ['api.example.com'], fs: [], wirkung: 'lesend' }, tests: kursTests, ownerId: owner.principalId, origin: 'build_skill',
})
/** Lern-Modell, das einen Entwurf liefert; factor 1 = Tests grün, sonst rot. */
const modelReturning = (factor: number, extra = '') => {
    const complete = vi.fn(async () => ({ content: JSON.stringify({ description: 'Holt den Kurs', why: 'besser', code: kursCode(factor) + extra, manifest: { net: ['api.example.com'], fs: [], wirkung: 'lesend' }, tests: kursTests, parameters: [{ name: 'to', type: 'string', description: 'Zielwährung' }] }) }))
    return { complete }
}

beforeEach(() => {
    // The test setup owns an isolated runtime. Earlier tests must not consume
    // this test's rolling 24-hour build allowance as fixed dates approach today.
    rmSync(getNovaDataDir('forge', 'bedarf.json'), { force: true })
    registered.clear()
    events.length = 0
    setForgeRegistry(registry)
    setForgeNotifier(event => events.push({ kind: event.kind, text: event.text }))
    setForgePermissionResolver(async () => 'owner')
    setForgeModel(null)
})
afterEach(() => {
    setForgeRegistry(null)
    setForgeNotifier(undefined)
    setForgePermissionResolver(null)
    setForgeModel(null)
})

const request = (): ModelRequest => ({ input: 'Wie wird das Wetter morgen?',
    tools: [{ type: 'function', name: 'fetch_url', description: 'Read HTTP URL', parameters: { type: 'object', properties: {} }, strict: false }],
    modelSettings: {}, outputType: { type: 'text' }, handoffs: [], tracing: false } as any)
const asks = (name: string) => ({ content: '', toolCalls: [{ id: 'call-1', name, arguments: {} }] })

async function stopFor(name: string): Promise<unknown> {
    const client = { complete: vi.fn().mockResolvedValue(asks(name)) }
    return new NovaAgentsModel('lokal', { client }).getResponse(request()).then(() => null, error => error)
}

describe('Punkt 4: fehlendes Werkzeug kommt als Bedarf an', () => {
    it('Modell-Gate nennt den angeforderten Werkzeugnamen im Fehler', async () => {
        const error = await stopFor('wetter_holen')
        expect(String((error as Error)?.message)).toMatch(/outside the offered contract.*wetter_holen/)
    })

    it('nicht registriertes Werkzeug → Fehleintrag „Tool nicht gefunden“ → noteForgeNeed: fehlendes-werkzeug', async () => {
        setForgeModel({ complete: async () => ({ content: 'kein json' }) })
        const error = await stopFor('wetter_holen')
        const failures = missingToolFailures(error, name => name === 'fetch_url' || name === 'web_search')
        expect(failures).toHaveLength(1)
        expect(failures[0]).toMatchObject({ toolName: 'wetter_holen', success: false, result: 'Tool nicht gefunden: wetter_holen' })
        const need = noteForgeNeed({ ...owner, request: 'Wie wird das Wetter morgen?', toolExecutions: failures }, { allowInTests: true, onBuilt: () => undefined })
        expect(need).toMatchObject({ queued: true, kind: 'fehlendes-werkzeug' })
    })

    it('Gegenprobe: registriertes, nur nicht angebotenes Werkzeug ist kein Bedarf', async () => {
        setForgeModel({ complete: async () => ({ content: 'kein json' }) })
        const error = await stopFor('web_search')
        const failures = missingToolFailures(error, name => name === 'fetch_url' || name === 'web_search')
        expect(failures).toEqual([])
        expect(noteForgeNeed({ ...owner, request: 'Such mir was', toolExecutions: failures }, { allowInTests: true }).reason).toBe('kein Bedarf')
        expect(missingToolFailures(new Error('provider unavailable'), () => false)).toEqual([])
    })

    it('der Runner legt den Fehleintrag im SDK-Abbruch an (über missingToolFailures, gegen das Register)', () => {
        const source = readFileSync(fileURLToPath(new URL('../agents/nova-runner.ts', import.meta.url)), 'utf8')
        const stop = source.indexOf('SDK loop stopped safely')
        const hook = source.lastIndexOf('missingToolFailures(', stop)
        expect(hook).toBeGreaterThan(0)
        expect(stop - hook).toBeLessThan(800)
        expect(source.slice(hook - 300, stop)).toMatch(/getToolRegistry\(\)\.getAll\(\)/)
        expect(source).toMatch(/toolExecutions: missingTools\.length \? \[\.\.\.toolExecutions, \.\.\.missingTools\]/)
    })
})

describe('Punkt 4: neue Versionen mit Tageslimit, Kandidat statt Ersatz', () => {
    it('4× reviseTool an einem Tag → der vierte baut nicht, nichts abgeschaltet', async () => {
        const built = await buildTool(kursDraft(unique('kurs_limit')))
        expect(built.proposal?.status).toBe('active')
        const model = modelReturning(1)
        setForgeModel(model)
        const day = Date.parse('2026-10-05T09:00:00Z')
        for (let i = 0; i < 3; i++) await reviseTool(built.proposal!.id, `Owner-Ja ${i}`, { now: () => day + i * 60_000 })
        expect(model.complete).toHaveBeenCalledTimes(3)
        const fourth = await reviseTool(built.proposal!.id, 'Owner-Ja 4', { now: () => day + 10 * 60_000 })
        expect(model.complete).toHaveBeenCalledTimes(3)
        expect(fourth.message).toMatch(/morgen/)
        expect(getForgeTool(built.proposal!.id)?.status).toBe('active')
        expect(events.some(event => /morgen/.test(event.text))).toBe(true)
    })

    it('Limit ist geteilt: drei Bedarfs-Bauten am Tag sperren auch reviseTool', async () => {
        const built = await buildTool(kursDraft(unique('kurs_geteilt')))
        setForgeModel({ complete: async () => ({ content: 'kein json' }) })
        const day = Date.parse('2026-10-08T09:00:00Z')
        for (const ask of ['Bau ein Werkzeug für A', 'Bau ein Werkzeug für B', 'Bau ein Werkzeug für C']) {
            expect(noteForgeNeed({ ...owner, request: ask }, { allowInTests: true, now: () => day, onBuilt: () => undefined }).queued).toBe(true)
        }
        const model = modelReturning(1)
        setForgeModel(model)
        const result = await reviseTool(built.proposal!.id, 'Owner-Ja', { now: () => day + 60_000 })
        expect(model.complete).not.toHaveBeenCalled()
        expect(result.message).toMatch(/morgen/)
    })

    it('Ja auf Idee, Entwurf mit roten Tests → aktives Werkzeug bleibt aktiv mit altem Code', async () => {
        const built = await buildTool(kursDraft(unique('kurs_rot')))
        const before = built.proposal!
        setForgeModel(modelReturning(3))
        const result = await reviseTool(before.id, 'Owner-Ja auf Idee werkzeug-langsam', { now: () => Date.parse('2026-10-11T09:00:00Z') })
        const after = getForgeTool(before.id)!
        expect(after.status).toBe('active')
        expect(after.codeHash).toBe(before.codeHash)
        expect(after.version).toBe(before.version)
        expect(registered.has(`forge_${before.name}`)).toBe(true)
        expect(result.message).toMatch(/verworfen/)
        expect(events.some(event => /verworfen/.test(event.text))).toBe(true)
        expect(events.some(event => event.kind === 'aus')).toBe(false)
    })

    it('Ja auf Idee, Entwurf ungültig → ebenfalls kein Abschalten', async () => {
        const built = await buildTool(kursDraft(unique('kurs_kaputt')))
        setForgeModel({ complete: async () => ({ content: 'kein json' }) })
        await reviseTool(built.proposal!.id, 'Owner-Ja', { now: () => Date.parse('2026-10-14T09:00:00Z') })
        expect(getForgeTool(built.proposal!.id)?.status).toBe('active')
    })

    it('Kandidat mit grünen Tests ersetzt die aktive Version (lesend → selbst aktiv, v2)', async () => {
        const built = await buildTool(kursDraft(unique('kurs_gruen')))
        setForgeModel(modelReturning(1, '\n// v2'))
        await reviseTool(built.proposal!.id, 'Owner-Ja', { now: () => Date.parse('2026-10-17T09:00:00Z') })
        const after = getForgeTool(built.proposal!.id)!
        expect(after.status).toBe('active')
        expect(after.version).toBe(2)
        expect(after.codeHash).not.toBe(built.proposal!.codeHash)
    })

    it('Gegenprobe: 2 Fehlschläge in Folge (Reparatur) dürfen weiter abschalten', async () => {
        const built = await buildTool(kursDraft(unique('kurs_rep')))
        setForgeModel(modelReturning(3))
        await reviseTool(built.proposal!.id, 'Fehlschlag', { mode: 'reparatur', now: () => Date.parse('2026-10-20T09:00:00Z') })
        expect(getForgeTool(built.proposal!.id)?.status).toBe('disabled')
    })
})
