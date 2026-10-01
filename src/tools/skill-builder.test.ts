import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NovaTool } from './complete-registry.js'
import {
    approveSkillProposal, buildTool, forgeRegisterPath, getForgeTool, getSkillProposals, handleWerkzeugeCommand, noteForgeNeed, runForgeTool,
    setForgeModel, setForgeNotifier, setForgePermissionResolver, setForgeRegistry, type ForgeDraft, type ForgeModel, type BuildResult,
} from './skill-builder.js'

const src = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const registered = new Map<string, NovaTool>()
const events: Array<{ kind: string; text: string }> = []
const registry = {
    register: (tool: NovaTool) => { registered.set(tool.name, tool) },
    unregister: (name: string) => registered.delete(name),
    get: (name: string) => registered.get(name),
}
let counter = 0
const unique = (base: string) => `${base}_${++counter}_${Date.now() % 100000}`

const kursDraft = (name = unique('kurs_holen'), overrides: Partial<ForgeDraft> = {}): ForgeDraft => ({
    name, description: 'Holt den Wechselkurs EUR→CHF', why: 'Owner fragt das täglich',
    code: `export default async function (params, ctx) {
  const r = await ctx.fetch('https://api.frankfurter.app/latest?from=EUR&to=' + params.to)
  const data = await r.json()
  return { kurs: data.rates[params.to] }
}`,
    parameters: [{ name: 'to', type: 'string', description: 'Zielwährung', required: true }],
    manifest: { net: ['api.frankfurter.app'], fs: [], wirkung: 'lesend' },
    tests: [{ name: 'CHF', params: { to: 'CHF' }, fetch: [{ url: 'https://api.frankfurter.app/latest', body: '{"rates":{"CHF":0.94}}' }], expect: { equals: { kurs: 0.94 } } }],
    ownerId: 'owner-alfred', origin: 'build_skill',
    ...overrides,
})

beforeEach(() => {
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
    delete process.env.NOVA_NODE_ONLY
})

describe('Werkzeug-Schmiede: Bau, Tests, Aktivierung (P9 Punkt 5)', () => {
    it('lesend + Tests grün → selbst aktiv, registriert als forge_<name>, Gedanke für den Abendbericht', async () => {
        const draft = kursDraft()
        const result = await buildTool(draft)
        expect(result.proposal?.status).toBe('active')
        expect(result.proposal?.lastTest).toMatchObject({ passed: 1, total: 1 })
        expect(registered.has(`forge_${draft.name}`)).toBe(true)
        expect(events.some(event => event.kind === 'aktiv')).toBe(true)
        expect(existsSync(forgeRegisterPath())).toBe(true)
    })

    it('rote Tests → bleibt Entwurf, nichts registriert', async () => {
        const draft = kursDraft(undefined, { tests: [{ name: 'falsch', params: { to: 'CHF' }, fetch: [{ url: 'https://api.frankfurter.app/latest', body: '{"rates":{"CHF":0.94}}' }], expect: { equals: { kurs: 1 } } }] })
        const result = await buildTool(draft)
        expect(result.proposal?.status).toBe('proposed')
        expect(result.message).toMatch(/nicht grün/)
        expect(registered.size).toBe(0)
    })

    it('Manifest wird erzwungen: Fixture-Host außerhalb des Manifests wird gar nicht erst angenommen', async () => {
        const result = await buildTool(kursDraft(undefined, { manifest: { net: ['example.org'], fs: [], wirkung: 'lesend' } }))
        expect(result.proposal).toBeNull()
        expect(result.message).toMatch(/fehlt im Manifest/)
    })

    it('schreibend → Karte werkzeug-schreibend; Owner-Ja aktiviert genau diesen Code', async () => {
        const draft = kursDraft(unique('notiz_ablegen'), {
            code: `export default async function (params, ctx) { const r = await ctx.fetch('https://notes.example.org/add', { method: 'POST', body: params.text }); return r.status }`,
            parameters: [{ name: 'text', type: 'string', description: 'Text', required: true }],
            manifest: { net: ['notes.example.org'], fs: [], wirkung: 'schreibend' },
            tests: [{ name: 'post', params: { text: 'x' }, fetch: [{ url: 'https://notes.example.org/add', method: 'POST', status: 201, body: '' }], expect: { equals: 201 } }],
        })
        const result = await buildTool(draft)
        expect(result.proposal?.status).toBe('awaiting-approval')
        expect(registered.size).toBe(0)
        const { listApprovalCards } = await import('../core/approval-cards.js')
        const card = listApprovalCards().find(item => item.aktion.ref === result.proposal!.id)
        expect(card?.aktion.kind).toBe('werkzeug-schreibend')
        const active = approveSkillProposal(result.proposal!.id, 'owner-alfred')
        expect(active?.status).toBe('active')
        expect(active?.approvedHash).toBe(active?.codeHash)
    })

    it('extern/physisch → Karte; der Name hebt eine zu niedrige Wirkung an; jeder Aufruf braucht die Owner-Freigabe', async () => {
        const draft = kursDraft(unique('licht_schalten'), {
            code: `export default async function (params, ctx) { const r = await ctx.fetch('https://ha.example.org/api/services/light/toggle', { method: 'POST', body: '{}' }); return r.status }`,
            manifest: { net: ['ha.example.org'], fs: [], wirkung: 'lesend' },
            parameters: [],
            tests: [{ name: 'toggle', params: {}, fetch: [{ url: 'https://ha.example.org/api/services/light/toggle', method: 'POST', status: 200, body: '' }], expect: { equals: 200 } }],
        })
        const result = await buildTool(draft)
        expect(result.proposal?.manifest.wirkung).toBe('physisch')
        expect(result.proposal?.status).toBe('awaiting-approval')
        const active = approveSkillProposal(result.proposal!.id, 'owner-alfred')
        expect(active?.status).toBe('active')
        const call = await runForgeTool(active!.id, {})
        expect(call.success).toBe(false)
        expect(String(call.error)).toMatch(/Freigabe|Auftraggeber|Owner/)
    })

    it('Ausführung nur im Sandbox-Kind, nur für den Owner; Zähler laufen mit', async () => {
        const draft = kursDraft(unique('summe'), {
            code: `export default async function (params) { if (params.a < 0) throw new Error('negativ'); return params.a + params.b }`,
            parameters: [{ name: 'a', type: 'number', description: 'a' }, { name: 'b', type: 'number', description: 'b' }],
            manifest: { net: [], fs: [], wirkung: 'lesend' },
            tests: [{ name: '2+3', params: { a: 2, b: 3 }, expect: { equals: 5 } }],
        })
        const { proposal } = await buildTool(draft)
        expect(await runForgeTool(proposal!.id, { a: 4, b: 5, authorizationUserId: 'owner-alfred' })).toMatchObject({ success: true, result: 9 })
        setForgePermissionResolver(async () => 'user')
        expect(await runForgeTool(proposal!.id, { a: 1, b: 1 })).toMatchObject({ success: false })
        expect(getForgeTool(proposal!.id)?.counters).toMatchObject({ calls: 1, successes: 1, failures: 0 })
    })

    it('2 Fehlschläge in Folge ohne Lern-Modell → aus und abgemeldet', async () => {
        const draft = kursDraft(unique('kaputt'), {
            code: `export default async function (params) { if (params.a < 0) throw new Error('negativ'); return params.a }`,
            parameters: [{ name: 'a', type: 'number', description: 'a' }],
            manifest: { net: [], fs: [], wirkung: 'lesend' },
            tests: [{ name: 'ok', params: { a: 1 }, expect: { equals: 1 } }],
        })
        const { proposal } = await buildTool(draft)
        await runForgeTool(proposal!.id, { a: -1 })
        expect(getForgeTool(proposal!.id)?.status).toBe('active')
        await runForgeTool(proposal!.id, { a: -1 })
        expect(getForgeTool(proposal!.id)).toMatchObject({ status: 'disabled' })
        expect(registered.has(`forge_${draft.name}`)).toBe(false)
        expect(events.some(event => event.kind === 'aus')).toBe(true)
    })

    it('2 Fehlschläge mit Lern-Modell → neue Version (v2), Historie bleibt', async () => {
        const name = unique('teiler')
        const fixed = `export default async function (params) { return params.b === 0 ? null : params.a / params.b }`
        const model: ForgeModel = { complete: async () => ({ content: JSON.stringify({ name, description: 'teilt', why: 'fix', code: fixed, parameters: [{ name: 'a', type: 'number', description: 'a' }, { name: 'b', type: 'number', description: 'b' }], manifest: { net: [], fs: [], wirkung: 'lesend' }, tests: [{ name: 'durch null', params: { a: 1, b: 0 }, expect: { equals: null } }] }) }) }
        const { proposal } = await buildTool(kursDraft(name, {
            code: `export default async function (params) { if (params.b === 0) throw new Error('durch null'); return params.a / params.b }`,
            parameters: [{ name: 'a', type: 'number', description: 'a' }, { name: 'b', type: 'number', description: 'b' }],
            manifest: { net: [], fs: [], wirkung: 'lesend' },
            tests: [{ name: '6/3', params: { a: 6, b: 3 }, expect: { equals: 2 } }],
        }))
        setForgeModel(model)
        await runForgeTool(proposal!.id, { a: 1, b: 0 })
        await runForgeTool(proposal!.id, { a: 1, b: 0 })
        await expect.poll(() => getForgeTool(proposal!.id)?.version, { timeout: 15_000 }).toBe(2)
        await expect.poll(() => getForgeTool(proposal!.id)?.status, { timeout: 15_000 }).toBe('active')
        expect(getForgeTool(proposal!.id)?.history.map(item => item.version)).toEqual([1])
        expect(await runForgeTool(proposal!.id, { a: 1, b: 0 })).toMatchObject({ success: true, result: null })
    })

    it('Worker bauen nichts', async () => {
        process.env.NOVA_NODE_ONLY = 'true'
        const result = await buildTool(kursDraft())
        expect(result.proposal).toBeNull()
        expect(result.message).toMatch(/Worker/)
    })
})

describe('Bedarfs-Hook (message-pipeline)', () => {
    const owner = { principalId: 'owner-alfred', permission: 'owner' }

    it('Owner-Wunsch → Bau im Hintergrund mit dem lokalen Lern-Modell', async () => {
        const name = unique('wetter_salzburg')
        setForgeModel({ complete: async () => ({ content: JSON.stringify({ ...kursDraft(name), ownerId: undefined }) }) })
        let built: BuildResult | null = null
        const queued = noteForgeNeed({ ...owner, request: 'Bau dir ein Werkzeug für den Wechselkurs' }, { allowInTests: true, onBuilt: result => { built = result } })
        expect(queued).toMatchObject({ queued: true, kind: 'owner-wunsch' })
        await expect.poll(() => built?.proposal?.status ?? null, { timeout: 15_000 }).toBe('active')
        expect(noteForgeNeed({ ...owner, request: 'Bau dir ein Werkzeug für den Wechselkurs' }, { allowInTests: true }).reason).toMatch(/schon bearbeitet/)
    })

    it('fehlendes Werkzeug und Wiederholung werden erkannt; ohne Lern-Modell wird nichts gebaut', () => {
        const missing = noteForgeNeed({ ...owner, request: 'Mach den Export', toolExecutions: [{ toolName: 'pdf_export', success: false, error: 'Tool nicht gefunden: pdf_export' }] }, { allowInTests: true })
        expect(missing).toMatchObject({ queued: false, kind: 'fehlendes-werkzeug', reason: 'kein lokales Lern-Modell' })
        expect(events.some(event => event.kind === 'bedarf')).toBe(true)
        const repeated = noteForgeNeed({ ...owner, request: 'Zähl die Zeilen im Log', routineSkillCreated: { name: 'Routine: log zeilen', steps: [{ tool: 'execute_python' }] } }, { allowInTests: true })
        expect(repeated.kind).toBe('wiederholung')
    })

    it('Gruppen, Fremde und System-Nachrichten lösen nie einen Bau aus', () => {
        expect(noteForgeNeed({ principalId: 'x', permission: 'user', request: 'Bau dir ein Werkzeug' }, { allowInTests: true }).queued).toBe(false)
        expect(noteForgeNeed({ ...owner, isGroup: true, request: 'Bau dir ein Werkzeug' }, { allowInTests: true }).queued).toBe(false)
        expect(noteForgeNeed({ ...owner, systemAuthored: true, request: 'Bau dir ein Werkzeug' }, { allowInTests: true }).queued).toBe(false)
    })
})

describe('Ein Register, alte Wege stillgelegt', () => {
    it('/werkzeuge zeigt Status, Wirkung, Version und Zähler', async () => {
        const draft = kursDraft(unique('anzeige'))
        await buildTool(draft)
        const text = await handleWerkzeugeCommand('', { principalId: 'owner-alfred', permission: 'owner' })
        expect(text).toContain(`forge_${draft.name}`)
        expect(text).toMatch(/lesend/)
        expect(text).toMatch(/Aufrufe 0/)
    })

    it('alte skill-forge.json wird einmal übernommen (als Altbestand, nie ausführbar) und umbenannt', async () => {
        const learning = join(process.env.NOVA_RUNTIME_ROOT!, '.nova-learning')
        mkdirSync(learning, { recursive: true })
        rmSync(forgeRegisterPath(), { force: true })
        writeFileSync(join(learning, 'skill-forge.json'), JSON.stringify({ version: 1, proposals: [{ id: 'forge_alt_1', name: 'sum_values', description: 'alt', why: 'x', code: 'return 1', status: 'pending' }] }))
        const all = getSkillProposals(10)
        expect(all.find(item => item.id === 'forge_alt_1')).toMatchObject({ status: 'disabled', origin: 'altbestand' })
        expect(existsSync(join(learning, 'skill-forge.json.migriert'))).toBe(true)
    })

    it('kein .nova-tools-Lader, kein new Function, keine Doppel-Einstiege, kein Cloud-Modell im Generator', async () => {
        expect(existsSync(src('tools/self-extension.ts'))).toBe(false)
        expect(existsSync(src('tools/skill-synthesis.ts'))).toBe(false)
        expect(existsSync(src('synthesis/sandbox.ts'))).toBe(false)
        const registrySource = readFileSync(src('tools/complete-registry.ts'), 'utf8')
        expect(registrySource).not.toMatch(/loadCustomToolsFromDisk|executeCustomTool|new Function/)
        for (const name of ["name: 'create_tool'", "name: 'create_runtime_tool'", "name: 'list_custom_tools'"]) expect(registrySource).not.toContain(name)
        const builder = readFileSync(src('tools/skill-builder.ts'), 'utf8')
        expect(builder).not.toMatch(/resolveModelId|createNovaLLMClient/)
    })

    it('create_skill ohne lokales Lern-Modell lehnt ehrlich ab', async () => {
        const { createSkillTool } = await import('./skill-builder.js')
        expect(await createSkillTool.handler({ name: 'x_y_z', description: 'irgendwas' })).toMatchObject({ message: expect.stringMatching(/Kein lokales Lern-Modell/) })
    })
})
