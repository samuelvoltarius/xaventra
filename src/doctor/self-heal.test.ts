/**
 * Stufe 3 — Selbstheilung mit Beleg und Rückweg. Drills with artificial
 * symptoms in a throwaway data directory; nothing here touches a real system.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    AUTO_RECIPE_IDS, NIE_LISTE, createSelfHealEngine, decideFenceGate, getSelfHealMeshSummary, parseSelfHealSettings,
    readHealJournal, resolveInDataDir, sanitizeSelfHealSummary, setSelfHealSwitch, validateRecipeCatalog,
    type EndpointController, type HealRecipe, type SelfHealSettings,
} from './self-heal.js'
import { createDefaultRecipes, createLogRotationRecipe } from './self-heal-recipes.js'
import type { NightwatchReport } from './nightwatch.js'

let dataDir: string
let clock: number
const now = () => clock
const HOUR = 60 * 60_000
const held = decideFenceGate({ held: true, mode: 'observe' })
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function settings(extra: Partial<SelfHealSettings> = {}): SelfHealSettings {
    return { ...parseSelfHealSettings({ enabled: true }), logRotateBytes: 1024, ...extra }
}

function engine(recipes: HealRecipe[], extra: Partial<SelfHealSettings> = {}, nodeId = 'xaventra-spark') {
    return createSelfHealEngine({ dataDir, nodeId, settings: settings(extra), recipes, now })
}

function write(rel: string, content: string | Buffer): string {
    const abs = join(dataDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    return abs
}

function listTree(rel: string): string[] {
    const root = join(dataDir, rel)
    if (!existsSync(root)) return []
    return readdirSync(root, { recursive: true }).map(String).sort()
}

const fullDisk = () => ({ usedPercent: 95, freeBytes: 1, totalBytes: 100 })
const emptyDisk = () => ({ usedPercent: 40, freeBytes: 60, totalBytes: 100 })

beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'self-heal-'))
    clock = Date.parse('2026-10-01T12:00:00Z')
})

afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
})

describe('S3.1 Rezeptkatalog + Nie-Liste', () => {
    it('accepts the default catalog: exactly the three auto recipes, everything else is a proposal', () => {
        const { accepted, rejected } = validateRecipeCatalog(createDefaultRecipes({}), dataDir)
        expect(rejected).toEqual([])
        expect(accepted.filter(recipe => recipe.level === 'auto').map(recipe => recipe.id).sort()).toEqual([...AUTO_RECIPE_IDS].sort())
        expect(accepted.filter(recipe => recipe.level === 'vorschlag').map(recipe => recipe.id).sort())
            .toEqual(['dienst-neustart-vorschlag', 'lease-verloren-melden', 'platte-voll-melden'])
    })

    it('rejects a recipe that touches the Nie-Liste, even disguised as a proposal', () => {
        expect(NIE_LISTE.map(item => item.effect)).toEqual(expect.arrayContaining(['db:migration', 'nas:neustart', 'secrets:lesen', 'curl-pipe-sh', 'telegram:nicht-main', 'vllm:stoppen']))
        const base = createDefaultRecipes({}).find(recipe => recipe.id === 'platte-voll-melden')!
        const migrate: HealRecipe = { ...base, id: 'db-fix', effects: ['owner:melden', 'db:migration'] as any }
        const secrets: HealRecipe = { ...base, id: 'secret-peek', targets: ['auth.json'] }
        const { accepted, rejected } = validateRecipeCatalog([migrate, secrets], dataDir)
        expect(accepted).toEqual([])
        expect(rejected.map(item => item.id)).toEqual(['db-fix', 'secret-peek'])
        expect(rejected.every(item => /Nie-Liste/.test(item.reason))).toBe(true)
    })

    it('rejects unknown effects, a fourth auto recipe and an auto recipe without Rückweg', () => {
        const log = createLogRotationRecipe({})
        const unknown: HealRecipe = { ...log, id: 'log-rotation', effects: ['shell:ausfuehren'] as any }
        const fourth: HealRecipe = { ...log, id: 'dienst-neustart' }
        const noRollback: HealRecipe = { ...log, rollback: undefined }
        const { accepted, rejected } = validateRecipeCatalog([unknown, fourth, noRollback], dataDir)
        expect(accepted).toEqual([])
        expect(rejected).toHaveLength(3)
    })

    it('rejects a recipe target outside the data directory at load time', () => {
        const escape: HealRecipe = { ...createLogRotationRecipe({}), targets: ['../fremd.log'] }
        expect(validateRecipeCatalog([escape], dataDir).rejected[0].reason).toMatch(/Datenverzeichnis/)
    })

    it('a rejected recipe never runs, even with its symptom present', async () => {
        write('subagent-audit.jsonl', 'x'.repeat(4096))
        const evil: HealRecipe = { ...createLogRotationRecipe({}), effects: ['fs:eigene-logs-archivieren', 'daten:loeschen'] as any }
        const result = await engine([evil]).run({ gate: held, canNotifyOwner: true })
        expect(result.rejected.map(item => item.id)).toEqual(['log-rotation'])
        expect(result.entries).toEqual([])
        expect(readFileSync(join(dataDir, 'subagent-audit.jsonl'), 'utf8')).toHaveLength(4096)
    })
})

describe('S3.2 Pfad-Grenzen (segmentgenau)', () => {
    it('allows own paths and refuses everything outside, including a sibling with the same prefix', () => {
        expect(resolveInDataDir(dataDir, 'tmp/x.bin')).toBe(join(dataDir, 'tmp', 'x.bin'))
        expect(() => resolveInDataDir(dataDir, '../x')).toThrow(/Datenverzeichnis/)
        expect(() => resolveInDataDir(dataDir, `${dataDir}-evil/x`)).toThrow(/Datenverzeichnis/)
        expect(() => resolveInDataDir(dataDir, 'tmp/../../x')).toThrow(/Datenverzeichnis/)
        expect(() => resolveInDataDir(dataDir, '.')).toThrow(/Datenverzeichnis/)
        expect(() => resolveInDataDir(dataDir, '')).toThrow()
        // A name that merely starts with dots is still inside.
        expect(resolveInDataDir(dataDir, '..ok')).toBe(join(dataDir, '..ok'))
    })

    it('a recipe asked to act outside the data directory is stopped by the path guard', async () => {
        const outside = mkdtempSync(join(tmpdir(), 'self-heal-outside-'))
        try {
            writeFileSync(join(outside, 'fremd.log'), 'x'.repeat(4096))
            const rel = join('..', outside.split(/[\\/]/).pop()!, 'fremd.log')
            const recipe = createLogRotationRecipe({ files: [rel] })
            const result = await engine([recipe]).run({ gate: held, canNotifyOwner: true })
            expect(result.entries).toEqual([])
            expect(readFileSync(join(outside, 'fremd.log'), 'utf8')).toHaveLength(4096)
        } finally {
            rmSync(outside, { recursive: true, force: true })
        }
    })
})

describe('Drill: Log-Rotation (auto)', () => {
    it('archives an oversized own audit log, verifies the archive and journals before/after', async () => {
        const content = Buffer.from('{"ok":1}\n'.repeat(400))
        write('subagent-audit.jsonl', content)
        const result = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toHaveLength(1)
        const entry = result.entries[0]
        expect(entry).toMatchObject({ recipe: 'log-rotation', ergebnis: 'geheilt', level: 'auto' })
        expect(entry.vorher).toMatchObject({ bytes: content.length, sha256: sha(content) })
        expect(entry.nachher).toMatchObject({ bytes: 0 })
        const archives = readdirSync(join(dataDir, 'self-heal', 'archive')).filter(name => name.endsWith('.gz'))
        expect(archives).toHaveLength(1)
        expect(sha(gunzipSync(readFileSync(join(dataDir, 'self-heal', 'archive', archives[0]))))).toBe(sha(content))
        expect(existsSync(join(dataDir, 'subagent-audit.jsonl.heal-rotating'))).toBe(false)
        expect(readHealJournal(dataDir, 10).map(item => item.ergebnis)).toEqual(['geheilt'])
    })

    it('does nothing without a symptom', async () => {
        write('subagent-audit.jsonl', 'small\n')
        const result = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toEqual([])
        expect(readFileSync(join(dataDir, 'subagent-audit.jsonl'), 'utf8')).toBe('small\n')
        expect(existsSync(join(dataDir, 'self-heal', 'archive'))).toBe(false)
    })

    it('rolls back when compression fails: the log is byte-identical to before (measured)', async () => {
        const content = 'line\n'.repeat(500)
        write('subagent-audit.jsonl', content)
        const recipe = createLogRotationRecipe({ gzip: async () => { throw new Error('Platte voll beim Schreiben') } })
        const result = await engine([recipe]).run({ gate: held, canNotifyOwner: true })
        const entry = result.entries[0]
        expect(entry.ergebnis).toBe('zurueckgerollt')
        expect(entry.zustandWieVorher).toBe(true)
        expect(entry.rueckweg?.ok).toBe(true)
        expect(sha(readFileSync(join(dataDir, 'subagent-audit.jsonl')))).toBe(sha(content))
        expect(result.checks.some(check => check.requiresNotification && check.severity === 'warning')).toBe(true)
    })

    it('rolls back when the after-probe finds a corrupt archive', async () => {
        const content = 'line\n'.repeat(500)
        write('subagent-audit.jsonl', content)
        const recipe = createLogRotationRecipe({ gzip: async (_source, target) => { writeFileSync(target, 'kein gzip') } })
        const result = await engine([recipe]).run({ gate: held, canNotifyOwner: true })
        expect(result.entries[0]).toMatchObject({ ergebnis: 'zurueckgerollt', zustandWieVorher: true })
        expect(sha(readFileSync(join(dataDir, 'subagent-audit.jsonl')))).toBe(sha(content))
        // Nothing is ever deleted: the broken archive is kept and marked, never counted as an archive.
        expect(readdirSync(join(dataDir, 'self-heal', 'archive')).filter(name => name.endsWith('.gz'))).toEqual([])
    })
})

describe('Drill: eigene Caches leeren (auto)', () => {
    function seedCaches() {
        write('tmp/a.bin', Buffer.alloc(2048, 1))
        write('cache/sub/b.json', '{"b":1}')
        write('resolver-cache.json', '{}')
        write('memory/keep.json', '{"wichtig":true}')
    }

    it('empties only the fixed cache list when the disk is >= 90 %', async () => {
        seedCaches()
        const recipes = createDefaultRecipes({ diskUsage: fullDisk }).filter(recipe => recipe.id === 'cache-leeren')
        const result = await engine(recipes).run({ gate: held, canNotifyOwner: true })
        expect(result.entries[0]).toMatchObject({ recipe: 'cache-leeren', ergebnis: 'geheilt' })
        expect(listTree('tmp')).toEqual([])
        expect(listTree('cache')).toEqual([])
        expect(existsSync(join(dataDir, 'resolver-cache.json'))).toBe(false)
        expect(readFileSync(join(dataDir, 'memory', 'keep.json'), 'utf8')).toBe('{"wichtig":true}')
        expect(listTree('self-heal/quarantine')).toEqual([])
    })

    it('does nothing while the disk is below the threshold', async () => {
        seedCaches()
        const recipes = createDefaultRecipes({ diskUsage: emptyDisk }).filter(recipe => recipe.id === 'cache-leeren')
        const result = await engine(recipes).run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toEqual([])
        expect(listTree('tmp')).toEqual(['a.bin'])
    })

    it('moves everything back when a move fails half way (state measured equal)', async () => {
        seedCaches()
        let calls = 0
        const rename = (from: string, to: string) => {
            if (++calls === 2) throw new Error('EXDEV simuliert')
            renameSync(from, to)
        }
        const before = [listTree('tmp'), listTree('cache'), existsSync(join(dataDir, 'resolver-cache.json'))]
        const recipes = createDefaultRecipes({ diskUsage: fullDisk, rename }).filter(recipe => recipe.id === 'cache-leeren')
        const result = await engine(recipes).run({ gate: held, canNotifyOwner: true })
        expect(result.entries[0]).toMatchObject({ ergebnis: 'zurueckgerollt', zustandWieVorher: true })
        expect([listTree('tmp'), listTree('cache'), existsSync(join(dataDir, 'resolver-cache.json'))]).toEqual(before)
    })
})

describe('Drill: Modell-Endpoint umschalten und zurück (auto)', () => {
    const endpoints = { primary: { model: 'qwen', endpoint: 'http://10.0.0.1:8000/v1' }, secondary: { model: 'qwen-b', endpoint: 'http://10.0.0.2:8000/v1' } }
    function fakeController(alive: Record<string, boolean>, options: { breakAfterSwitch?: boolean } = {}) {
        const calls: string[] = []
        let model = 'qwen'
        const controller: EndpointController = {
            currentModel: () => model,
            probe: async endpoint => alive[endpoint] === true,
            switchTo: async entry => {
                calls.push(entry.endpoint)
                model = entry.model
                if (options.breakAfterSwitch) alive[entry.endpoint] = false
                return true
            },
        }
        return { controller, calls, model: () => model }
    }

    it('switches to the second known endpoint when the first is dead, and back when it returns', async () => {
        const alive = { [endpoints.primary.endpoint]: false, [endpoints.secondary.endpoint]: true }
        const fake = fakeController(alive)
        const recipes = createDefaultRecipes({ endpoints: fake.controller, retryDelayMs: 0 }).filter(recipe => recipe.id === 'endpoint-umschalten')
        const first = await engine(recipes, { endpoints }).run({ gate: held, canNotifyOwner: true })
        expect(first.entries[0]).toMatchObject({ ergebnis: 'geheilt', signature: 'endpoint-tot:primary' })
        expect(fake.model()).toBe('qwen-b')

        alive[endpoints.primary.endpoint] = true
        clock += HOUR
        const back = await engine(recipes, { endpoints }).run({ gate: held, canNotifyOwner: true })
        expect(back.entries[0]).toMatchObject({ ergebnis: 'geheilt', signature: 'endpoint-zurueck:primary' })
        expect(fake.model()).toBe('qwen')
        expect(fake.calls).toEqual([endpoints.secondary.endpoint, endpoints.primary.endpoint])
    })

    // 2.82.0 Abgrenzung: vLLM switch/maintenance and the LLM failover own the endpoint.
    it('never switches while the controller holds (vLLM switch, maintenance marker, LLM failover)', async () => {
        const fake = fakeController({ [endpoints.primary.endpoint]: false, [endpoints.secondary.endpoint]: true })
        const held2 = { ...fake.controller, hold: async () => 'vLLM-Wartungsmarke gesetzt — kein Endpoint-Umschalten' }
        const recipes = createDefaultRecipes({ endpoints: held2, retryDelayMs: 0 }).filter(recipe => recipe.id === 'endpoint-umschalten')
        const result = await engine(recipes, { endpoints }).run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toEqual([])
        expect(fake.calls).toEqual([])
    })

    it('does not switch while the first endpoint answers', async () => {
        const fake = fakeController({ [endpoints.primary.endpoint]: true, [endpoints.secondary.endpoint]: true })
        const recipes = createDefaultRecipes({ endpoints: fake.controller, retryDelayMs: 0 }).filter(recipe => recipe.id === 'endpoint-umschalten')
        const result = await engine(recipes, { endpoints }).run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toEqual([])
        expect(fake.calls).toEqual([])
    })

    it('switches back when the second endpoint fails the after-probe', async () => {
        const alive = { [endpoints.primary.endpoint]: false, [endpoints.secondary.endpoint]: true }
        const fake = fakeController(alive, { breakAfterSwitch: true })
        const recipes = createDefaultRecipes({ endpoints: fake.controller, retryDelayMs: 0 }).filter(recipe => recipe.id === 'endpoint-umschalten')
        const result = await engine(recipes, { endpoints }).run({ gate: held, canNotifyOwner: true })
        expect(result.entries[0]).toMatchObject({ ergebnis: 'zurueckgerollt', zustandWieVorher: true })
        expect(fake.model()).toBe('qwen')
    })

    it('accepts only two plain http(s) endpoints without credentials from config', () => {
        expect(parseSelfHealSettings({ enabled: true, endpoints: [{ model: 'a', endpoint: 'http://u:p@h:1/v1' }, { model: 'b', endpoint: 'http://h2:1/v1' }] }).endpoints).toBeUndefined()
        expect(parseSelfHealSettings({ enabled: true, endpoints: [{ model: 'a', endpoint: 'file:///etc/passwd' }, { model: 'b', endpoint: 'http://h2:1/v1' }] }).endpoints).toBeUndefined()
        expect(parseSelfHealSettings({ enabled: true, endpoints: [{ model: 'a', endpoint: 'http://h1:1/v1' }, { model: 'b', endpoint: 'http://h2:1/v1' }] }).endpoints?.secondary.model).toBe('b')
    })
})

describe('S3.4 Bremsen', () => {
    const bigLog = () => write('subagent-audit.jsonl', 'x'.repeat(4096))

    it('is off by default until autonomy.selfHeal.enabled=true', async () => {
        expect(parseSelfHealSettings(undefined).enabled).toBe(false)
        expect(parseSelfHealSettings({ enabled: 'true' }).enabled).toBe(false)
        bigLog()
        const result = await createSelfHealEngine({ dataDir, nodeId: 'n', settings: parseSelfHealSettings({}), recipes: [createLogRotationRecipe({})], now })
            .run({ gate: held, canNotifyOwner: true })
        expect(result.entries).toEqual([])
        expect(existsSync(join(dataDir, 'subagent-audit.jsonl'))).toBe(true)
    })

    it('Not-Aus stops every recipe; switching it on again resumes', async () => {
        bigLog()
        setSelfHealSwitch(dataDir, 'aus')
        const off = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(off.active).toBe(false)
        expect(off.entries).toEqual([])
        expect(readFileSync(join(dataDir, 'subagent-audit.jsonl'), 'utf8')).toHaveLength(4096)
        setSelfHealSwitch(dataDir, 'an')
        const on = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(on.entries.map(entry => entry.ergebnis)).toEqual(['geheilt'])
    })

    it('respects the per-recipe cooldown', async () => {
        bigLog()
        await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        bigLog()
        clock += 5 * 60_000
        const during = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(during.entries).toEqual([])
        clock += 2 * HOUR
        const after = await engine([createLogRotationRecipe({})]).run({ gate: held, canNotifyOwner: true })
        expect(after.entries.map(entry => entry.ergebnis)).toEqual(['geheilt'])
    })

    it('switches a recipe off after two failed heals and tells the owner', async () => {
        const broken = createLogRotationRecipe({ gzip: async () => { throw new Error('kaputt') } })
        bigLog()
        await engine([broken]).run({ gate: held, canNotifyOwner: true })
        clock += 2 * HOUR
        const second = await engine([broken]).run({ gate: held, canNotifyOwner: true })
        expect(second.checks.some(check => /abgeschaltet/.test(check.message) && check.requiresNotification)).toBe(true)
        clock += 2 * HOUR
        const third = await engine([broken]).run({ gate: held, canNotifyOwner: true })
        expect(third.entries).toEqual([])
        expect(readFileSync(join(dataDir, 'subagent-audit.jsonl'), 'utf8')).toHaveLength(4096)
        // Owner can switch the recipe on again explicitly.
        setSelfHealSwitch(dataDir, 'an', 'log-rotation')
        clock += 2 * HOUR
        const again = await engine([broken]).run({ gate: held, canNotifyOwner: true })
        expect(again.entries).toHaveLength(1)
    })
})

describe('Vorschläge: nie selbst ausführen', () => {
    function nightwatch(finishedAt: string): NightwatchReport {
        return {
            startedAt: finishedAt, finishedAt,
            results: [{
                id: 'rest', kind: 'http', label: 'REST', host: 'local', status: 'fehler', severity: 'critical', message: 'keine Antwort (Zeitüberschreitung)',
                evidence: { host: 'local', command: 'GET http://127.0.0.1:18789/health', exitCode: null, output: 'timeout', durationMs: 5000, checkedAt: finishedAt },
            }],
        }
    }

    it('turns a hanging REST endpoint into a restart proposal, at most once per 6 h', async () => {
        const recipes = createDefaultRecipes({}).filter(recipe => recipe.id === 'dienst-neustart-vorschlag')
        expect(recipes[0].act).toBeUndefined()
        const first = await engine(recipes).run({ gate: held, canNotifyOwner: true, nightwatch: nightwatch(new Date(clock).toISOString()) })
        expect(first.entries[0]).toMatchObject({ ergebnis: 'vorschlag', recipe: 'dienst-neustart-vorschlag' })
        expect(first.entries[0].nachher).toBeUndefined()
        const proposals = JSON.parse(readFileSync(join(dataDir, 'self-heal', 'proposals.json'), 'utf8'))
        expect(proposals.items).toHaveLength(1)
        expect(proposals.items[0]).toMatchObject({ recipe: 'dienst-neustart-vorschlag', status: 'offen' })
        expect(first.checks[0]).toMatchObject({ severity: 'warning', requiresNotification: true })
        expect(first.checks[0].message).toMatch(/Ja-Knopf/)

        clock += HOUR
        const again = await engine(recipes).run({ gate: held, canNotifyOwner: true, nightwatch: nightwatch(new Date(clock).toISOString()) })
        expect(again.entries).toEqual([])
        clock += 6 * HOUR
        const later = await engine(recipes).run({ gate: held, canNotifyOwner: true, nightwatch: nightwatch(new Date(clock).toISOString()) })
        expect(later.entries).toHaveLength(1)
    })

    it('never proposes a restart from a stale Nachtwache report, and never a restart of the NAS', async () => {
        const recipes = createDefaultRecipes({}).filter(recipe => recipe.id === 'dienst-neustart-vorschlag')
        const stale = await engine(recipes).run({ gate: held, canNotifyOwner: true, nightwatch: nightwatch(new Date(clock - 5 * HOUR).toISOString()) })
        expect(stale.entries).toEqual([])
        const nas = await engine(recipes, {}, 'xaventra-nas').run({ gate: held, canNotifyOwner: true, nightwatch: nightwatch(new Date(clock).toISOString()) })
        expect(nas.checks[0].message).toMatch(/NAS/)
        expect(nas.checks[0].message).not.toMatch(/Vorschlag: Dienst-Neustart/)
    })

    it('reports disk >= 90 % and a lost lease with diagnostics only', async () => {
        const recipes = createDefaultRecipes({
            diskUsage: fullDisk,
            leaseFailures: () => [{ service: 'nova-main', status: 403, failures: 4 }],
            fenceStatus: () => ({ mode: 'observe', held: [], violations: 2, blocked: 0, aborted: 0, lastViolation: 'x' }),
        }).filter(recipe => recipe.level === 'vorschlag')
        const result = await engine(recipes).run({ gate: held, canNotifyOwner: true })
        const ids = result.entries.map(entry => entry.recipe).sort()
        expect(ids).toEqual(['lease-verloren-melden', 'platte-voll-melden'])
        const lease = result.entries.find(entry => entry.recipe === 'lease-verloren-melden')!
        expect(lease.befund).toMatchObject({ lease: [{ service: 'nova-main', status: 403, failures: 4 }] })
        expect(result.checks.find(check => /Lease/.test(check.message))?.message).toMatch(/keine DB-Änderung/)
    })
})

describe('S3.5 Fencing + Worker', () => {
    it('enforce without the Main lease: no heal action, only a journal note', async () => {
        write('subagent-audit.jsonl', 'x'.repeat(4096))
        const gate = decideFenceGate({ held: false, mode: 'enforce' })
        expect(gate.allowAuto).toBe(false)
        const result = await engine([createLogRotationRecipe({})]).run({ gate, canNotifyOwner: true })
        expect(result.entries[0]).toMatchObject({ ergebnis: 'gesperrt-fence' })
        expect(readFileSync(join(dataDir, 'subagent-audit.jsonl'), 'utf8')).toHaveLength(4096)
    })

    it('observe without the lease: notes that enforce is missing and still allows only the harmless recipes', async () => {
        write('subagent-audit.jsonl', 'x'.repeat(4096))
        const gate = decideFenceGate({ held: false, mode: 'observe' })
        expect(gate).toMatchObject({ allowAuto: true, held: false })
        expect(gate.note).toMatch(/enforce fehlt/)
        const result = await engine([createLogRotationRecipe({})]).run({ gate, canNotifyOwner: false })
        expect(result.entries[0]).toMatchObject({ ergebnis: 'geheilt', fence: { held: false, mode: 'observe' } })
    })

    it('a worker never notifies the owner itself: reports go to the mesh summary for the Main', async () => {
        const recipes = createDefaultRecipes({ diskUsage: fullDisk }).filter(recipe => recipe.id === 'platte-voll-melden')
        const result = await engine(recipes, {}, 'xaventra-ns2').run({ gate: decideFenceGate({ held: false, mode: 'observe' }), canNotifyOwner: false })
        expect(result.entries).toHaveLength(1)
        expect(result.checks).toEqual([])
        const summary = getSelfHealMeshSummary(dataDir)
        expect(summary?.reports).toHaveLength(1)
        expect(summary?.reports[0]).toMatchObject({ recipe: 'platte-voll-melden', notify: true })
    })

    it('the Main forwards a worker report exactly once', async () => {
        const recipes = createDefaultRecipes({ diskUsage: fullDisk }).filter(recipe => recipe.id === 'platte-voll-melden')
        await engine(recipes, {}, 'xaventra-ns2').run({ gate: decideFenceGate({ held: false, mode: 'observe' }), canNotifyOwner: false })
        const summary = sanitizeSelfHealSummary(JSON.parse(JSON.stringify(getSelfHealMeshSummary(dataDir))))!
        expect(summary).not.toBeNull()
        const mainDir = mkdtempSync(join(tmpdir(), 'self-heal-main-'))
        try {
            const main = () => createSelfHealEngine({ dataDir: mainDir, nodeId: 'xaventra-spark', settings: settings(), recipes: [], now })
            const first = await main().run({ gate: held, canNotifyOwner: true, peers: [{ nodeId: 'xaventra-ns2', selfHeal: summary }] })
            expect(first.checks).toHaveLength(1)
            expect(first.checks[0].message).toMatch(/xaventra-ns2/)
            const second = await main().run({ gate: held, canNotifyOwner: true, peers: [{ nodeId: 'xaventra-ns2', selfHeal: summary }] })
            expect(second.checks).toEqual([])
        } finally {
            rmSync(mainDir, { recursive: true, force: true })
        }
    })

    it('bounds a malformed peer summary instead of trusting it', () => {
        expect(sanitizeSelfHealSummary({ schema: 7 })).toBeNull()
        const summary = sanitizeSelfHealSummary({ schema: 1, enabled: true, killSwitch: false, reports: Array.from({ length: 50 }, (_, index) => ({ id: `r${index}`, at: 'x', recipe: 'r', level: 'auto', ergebnis: 'geheilt', message: 'm'.repeat(5000), notify: 'yes' })) })!
        expect(summary.reports.length).toBeLessThanOrEqual(10)
        expect(summary.reports[0].message.length).toBeLessThanOrEqual(300)
        expect(summary.reports[0].notify).toBe(false)
    })
})
