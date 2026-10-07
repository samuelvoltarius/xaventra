import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 2.88 „Was ich nicht kann, lerne ich“: ehrliche Fähigkeitsprüfung, Lernauftrag
// im Hintergrund (a Rezept → b Verbindung → c Paket → d Code-Vorschlag),
// Selbsttest, Übernahme, Messung mit Rückrollen, Lernschleife.

import { answerApprovalCard, createApprovalCard, listApprovalCards, maintainApprovalCards, registerCardExecutor, unregisterCardExecutor, type ApprovalCard, type CardStoreOptions } from '../core/approval-cards.js'
import {
    assessCapability, capabilityGate, capabilityHonestyPrompt, capabilityReplyGate, capabilityLearningTick, createLearnCardExecutor, detectCapabilityRequest, handleCapabilityRequest,
    HONEST_NO, LEARN_CARD_KIND, learnedCapabilities, listLearnJobs, offerLearningAfterReply, rateSource, replyOffersLearning, searchQueryFor,
    type CapabilityInventory, type ForgeHealth, type LearnDeps, type LearnJob,
} from './capability-learning.js'

let clock: number
let opts: CardStoreOptions
let pending: Promise<unknown>[]
let deps: LearnDeps
let notes: string[]
let failures: Array<{ topic: string; reason: string }>
let inventory: CapabilityInventory

const owner = { principalId: 'owner-1', permission: 'owner' }

function makeDeps(over: Partial<LearnDeps> = {}): LearnDeps {
    return {
        dataDir: opts.dataDir,
        now: () => clock,
        inventory: async () => inventory,
        search: { search: vi.fn(async () => ({ tool: 'searxng_search', hits: [] })) },
        directory: () => [],
        connectors: () => [],
        hasRecipeBuilder: () => true,
        recipe: vi.fn(async () => ({ status: 'aktiv' as const, ref: 'sp-fax', tool: 'forge_fax_senden', detail: 'Tests 3/3 grün' })),
        connect: vi.fn(async () => ({ ok: true, message: 'Karte geschickt' })),
        softwareInstall: vi.fn(async () => ({ ok: true, message: 'Installationskarte geschickt', ref: 'whisper-cpp' })),
        proposeCode: vi.fn(async () => 'th-000000000001'),
        probe: vi.fn(async () => ({ result: 'ok' as const, detail: 'Beispiel lief' })),
        forgeHealth: () => null,
        rollback: vi.fn(async () => true),
        notify: (text: string) => { notes.push(text) },
        activity: () => undefined,
        rememberFailure: (topic: string, reason: string) => { failures.push({ topic, reason }) },
        offerCard: input => {
            const created = createApprovalCard(input, opts)
            return created.ok ? { ok: true, card: created.card } : { ok: false }
        },
        schedule: task => { pending.push(task()) },
        ...over,
    }
}

const press = (card: ApprovalCard, answer: 'ja' | 'nein') =>
    answerApprovalCard(`ac:${card.buttons.find(button => button.answer === answer)!.token}`, { userId: '111', ownerIds: ['111'], via: 'desktop' }, opts)
const learnCards = () => listApprovalCards(opts).filter(card => card.aktion.kind === LEARN_CARD_KIND)
const settle = async () => { while (pending.length) await pending.shift() }
const job = (): LearnJob => listLearnJobs(deps)[0]

beforeEach(() => {
    clock = Date.parse('2026-10-07T10:00:00Z')
    const dataDir = mkdtempSync(join(tmpdir(), 'capability-learning-'))
    opts = { dataDir, now: () => clock, ledger: { recordApproval: vi.fn() } }
    pending = []
    notes = []
    failures = []
    inventory = { tools: ['web_search', 'read_file', 'transcribe_audio'], connected: new Set(), learned: [] }
    deps = makeDeps()
    unregisterCardExecutor(LEARN_CARD_KIND)
    registerCardExecutor(createLearnCardExecutor(() => deps))
})

describe('Fähigkeitsfrage erkennen', () => {
    it('erkennt „Kannst du …?“ und Bitten, nicht aber Wissensfragen oder Erzählungen', () => {
        expect(detectCapabilityRequest('Kannst du mir ein Fax an die Praxis schicken?')).toMatchObject({ question: true, topic: 'ein Fax an die Praxis schicken' })
        expect(detectCapabilityRequest('Schick bitte ein Fax an die Praxis')).toMatchObject({ question: false })
        expect(detectCapabilityRequest('Was ist eigentlich ein Fax?')).toBeNull()
        expect(detectCapabilityRequest('Ich habe gestern ein Fax bekommen.')).toBeNull()
        expect(detectCapabilityRequest('/status')).toBeNull()
    })
})

describe('belastbar entscheiden, ob ich es kann', () => {
    it('kein Werkzeug für ein bekanntes Feld → kann nicht; mit Werkzeug → kann', () => {
        expect(assessCapability('Kannst du ein Fax schicken?', inventory)).toMatchObject({ status: 'kann-nicht', domain: { id: 'fax' } })
        expect(assessCapability('Kannst du ein Fax schicken?', { ...inventory, tools: [...inventory.tools, 'fax_send'] })).toMatchObject({ status: 'kann' })
    })

    it('Verbindung zählt als Werkzeug; Unbekanntes bleibt unklar (Modell entscheidet mit Ehrlichkeitsregel)', () => {
        expect(assessCapability('Kannst du meine Termine im Kalender lesen?', inventory)).toMatchObject({ status: 'kann-nicht' })
        expect(assessCapability('Kannst du meine Termine im Kalender lesen?', { ...inventory, connected: new Set(['google-calendar']) })).toMatchObject({ status: 'kann' })
        expect(assessCapability('Kannst du mir einen Witz erzählen?', inventory)).toMatchObject({ status: 'unklar' })
        expect(assessCapability('Kannst du meine Sprachnachricht abschreiben?', inventory)).toMatchObject({ status: 'kann' })
    })

    it('kein falsches Nein bei Verwandtem: Erinnerung an einen Termin ist kein Kalenderzugriff', () => {
        expect(assessCapability('Erinnere mich bitte an den Termin morgen', inventory).status).toBe('unklar')
        expect(assessCapability('Spiel Musik im Wohnzimmer', { ...inventory, tools: [...inventory.tools, 'hass_service'] }).status).toBe('kann')
    })

    it('gelernte Fähigkeiten zählen (Feld oder ähnliches Thema)', () => {
        const learned = [{ signature: 'x', topic: 'den Wasserstand der Salzach abfragen', tools: ['forge_pegel'] }]
        expect(assessCapability('Kannst du den Wasserstand der Salzach abfragen?', { ...inventory, learned })).toMatchObject({ status: 'kann' })
    })
})

describe('ehrliche Antwort mit Lern-Angebot', () => {
    it('Owner: „Nein, das kann ich noch nicht. Soll ich es lernen?“ + Karte Ja/Nein (kein „Immer“)', async () => {
        const result = await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        expect(result).toEqual({ handled: true, reply: HONEST_NO })
        const cards = learnCards()
        expect(cards).toHaveLength(1)
        expect(cards[0].wirkung).toBe('intern')
        expect(cards[0].direktAt).toBeTruthy()
        expect(cards[0].buttons.map(button => button.answer).sort()).toEqual(['ja', 'nein', 'spaeter'])
        expect(job().status).toBe('angeboten')
    })

    it('2.89: die Lernkarte schließt sich selbst, sobald die Fähigkeit inzwischen da ist (echte Kartenpflege)', async () => {
        let jetzt: CapabilityInventory | null = null
        deps = makeDeps({ inventoryNow: () => jetzt })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        const [card] = learnCards()
        expect(maintainApprovalCards(opts).settled).toEqual([])
        jetzt = { ...inventory, tools: [...inventory.tools, 'fax_send'] }
        expect(maintainApprovalCards(opts).settled.map(item => item.id)).toEqual([card.id])
    })

    it('kann ich → nicht abgefangen (normaler Weg antwortet)', async () => {
        inventory.tools.push('fax_send')
        expect(await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)).toEqual({ handled: false })
    })

    it('Nicht-Owner bekommt die ehrliche Antwort ohne Angebot', async () => {
        const result = await handleCapabilityRequest('Kannst du mir ein Fax schicken?', { principalId: 'gast', permission: 'user' }, deps)
        expect(result).toEqual({ handled: true, reply: 'Nein, das kann ich noch nicht.' })
        expect(learnCards()).toHaveLength(0)
    })

    it('Nie-Liste: ehrlich nein, aber kein Lern-Angebot', async () => {
        const result = await offerLearningAfterReply('Kannst du die Firewall auf dem Router abschalten?', owner, deps)
        expect(result.reply).toMatch(/lerne ich nicht selbst/)
        expect(learnCards()).toHaveLength(0)
    })

    it('Modell-Antwort mit der Ehrlichkeitsformel bekommt dieselbe Karte', async () => {
        expect(capabilityHonestyPrompt()).toContain(HONEST_NO)
        expect(replyOffersLearning('Nein, das kann ich noch nicht. Soll ich es lernen?')).toBe(true)
        expect(replyOffersLearning('Ich kann das noch nicht genau sagen.')).toBe(false)
        const result = await offerLearningAfterReply('Kannst du den Wasserstand der Salzach abfragen?', owner, deps)
        expect(result.reply).toBe(HONEST_NO)
        expect(learnCards()).toHaveLength(1)
    })
})

describe('Lernauftrag nach „Ja“', () => {
    it('(a) Rezept aus vorhandenen Werkzeugen → Selbsttest → gelernt + kurze Meldung', async () => {
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        const answer = await press(learnCards()[0], 'ja')
        expect(answer.ok).toBe(true)
        expect(answer.message).toMatch(/lerne das jetzt im Hintergrund/)
        await settle()
        expect(deps.recipe).toHaveBeenCalledTimes(1)
        expect(deps.probe).toHaveBeenCalled()
        expect(job()).toMatchObject({ status: 'gelernt', weg: 'rezept', ref: 'sp-fax' })
        expect(notes.at(-1)).toMatch(/^Gelernt: Faxe senden\. Probier mal: „/)
        // danach zählt es als vorhanden
        inventory = { ...inventory, learned: learnedCapabilities(deps), tools: [...inventory.tools, 'forge_fax_senden'] }
        expect(assessCapability('Kannst du mir ein Fax schicken?', inventory).status).toBe('kann')
    })

    it('(b) braucht das Feld einen Dienst → geprüfte Verbindung statt Bau; gelernt erst, wenn verbunden', async () => {
        deps = makeDeps({ connectors: () => ['google-calendar'], probe: vi.fn(async () => ({ result: 'warten' as const })) })
        await handleCapabilityRequest('Kannst du meine Termine im Kalender lesen?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(deps.recipe).not.toHaveBeenCalled()
        expect(deps.connect).toHaveBeenCalledWith('google-calendar')
        expect(job()).toMatchObject({ status: 'wartet-auf-freigabe', weg: 'verbindung', ref: 'google-calendar' })
        deps.probe = vi.fn(async () => ({ result: 'ok' as const, detail: 'verbunden' }))
        clock += 60_000
        await capabilityLearningTick(deps)
        expect(job().status).toBe('gelernt')
        expect(notes.at(-1)).toMatch(/^Gelernt: Kalender lesen/)
    })

    it('(c) fehlende Software → Install-Katalog (Karte), nie ein freier Befehl', async () => {
        inventory.tools = ['web_search']
        deps = makeDeps({ probe: vi.fn(async () => ({ result: 'warten' as const })) })
        await handleCapabilityRequest('Kannst du mir die Sprachnachricht abschreiben?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(deps.recipe).not.toHaveBeenCalled()
        expect(deps.softwareInstall).toHaveBeenCalledWith('stt')
        expect(job()).toMatchObject({ status: 'wartet-auf-freigabe', weg: 'paket' })
    })

    it('(d) kein Weg, aber seriöse Quelle → nur PATCH_GATE-Vorschlag notiert, nichts angewendet', async () => {
        deps = makeDeps({
            hasRecipeBuilder: () => false,
            search: { search: async () => ({ tool: 'searxng_search', hits: [{ url: 'https://github.com/example/fax-api', title: 'fax-api — release 2026', snippet: 'Official client, MIT License, updated 2026' }] }) },
        })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(deps.proposeCode).toHaveBeenCalledTimes(1)
        expect(job()).toMatchObject({ status: 'code-vorschlag', weg: 'code' })
        expect(job().quellen[0]).toMatchObject({ url: 'https://github.com/example/fax-api' })
        expect(notes.at(-1)).toMatch(/Code-Erweiterung/)
        expect(notes.at(-1)).toMatch(/nichts angewendet/)
    })

    it('scheitert ehrlich mit „was fehlt“, merkt es sich und bietet es nicht endlos neu an', async () => {
        deps = makeDeps({ hasRecipeBuilder: () => false })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(job().status).toBe('gescheitert')
        expect(job().fehlt).toMatch(/Lern-Modell/)
        expect(notes.at(-1)).toMatch(/^Nicht gelernt: Faxe senden\. Es fehlt: /)
        expect(failures).toHaveLength(1)
        clock += 60 * 60_000
        const again = await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        expect(again.reply).toMatch(/^Nein, das kann ich noch nicht\. Mein Lernversuch am 07\.10\. ist gescheitert, es fehlt: /)
        expect(learnCards().filter(card => card.status === 'offen')).toHaveLength(0)
    })

    it('Infrastrukturfehler (Websuche Zeitlimit) zählt nicht als Lernversuch', async () => {
        deps = makeDeps({ hasRecipeBuilder: () => false, search: { search: async () => { throw new Error('fetch failed: ETIMEDOUT') } } })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(job()).toMatchObject({ status: 'gescheitert', infrastruktur: true, attempts: 0 })
        clock += 60_000
        const again = await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        expect(again.reply).toBe(HONEST_NO)
    })

    it('Owner sagt Nein → nichts passiert, 30 Tage keine neue Frage', async () => {
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'nein')
        await settle()
        expect(deps.recipe).not.toHaveBeenCalled()
        expect(job().status).toBe('abgelehnt')
        clock += 24 * 60 * 60_000
        expect((await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)).reply).toBe('Nein, das kann ich noch nicht.')
    })

    it('läuft schon ein Lernauftrag, sagt sie das statt neu zu fragen', async () => {
        deps = makeDeps({ probe: vi.fn(async () => ({ result: 'warten' as const })), recipe: vi.fn(async () => ({ status: 'wartet' as const, ref: 'sp-fax', detail: 'Karte' })) })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect((await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)).reply).toMatch(/lerne ich gerade/)
    })

    it('wartet zu lange auf Freigabe → ehrlich aufgeben statt neu fragen', async () => {
        deps = makeDeps({ probe: vi.fn(async () => ({ result: 'warten' as const })), recipe: vi.fn(async () => ({ status: 'wartet' as const, ref: 'sp-fax', detail: 'Karte' })) })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        clock += 8 * 24 * 60 * 60_000
        await capabilityLearningTick(deps)
        expect(job()).toMatchObject({ status: 'gescheitert' })
        expect(job().fehlt).toMatch(/Freigabe/)
    })
})

describe('nach der Übernahme weiter messen', () => {
    let health: ForgeHealth
    async function learned(): Promise<void> {
        health = { status: 'active', calls: 4, failures: 0, totalMs: 4000 }
        deps = makeDeps({ forgeHealth: () => health })
        await handleCapabilityRequest('Kannst du mir ein Fax schicken?', owner, deps)
        await press(learnCards()[0], 'ja')
        await settle()
        expect(job().status).toBe('gelernt')
    }

    it('gesund → bleibt', async () => {
        await learned()
        health = { status: 'active', calls: 10, failures: 0, totalMs: 10_500 }
        expect((await capabilityLearningTick(deps)).rolledBack).toEqual([])
        expect(job().status).toBe('gelernt')
    })

    it('Fehlerrate steigt → automatisch zurückrollen und kurz melden', async () => {
        await learned()
        health = { status: 'active', calls: 8, failures: 3, totalMs: 8000 }
        const tick = await capabilityLearningTick(deps)
        expect(tick.rolledBack).toHaveLength(1)
        expect(deps.rollback).toHaveBeenCalledTimes(1)
        expect(job()).toMatchObject({ status: 'zurueckgerollt' })
        expect(notes.at(-1)).toMatch(/^Zurückgerollt: Faxe senden — Fehlerrate/)
        expect(failures.at(-1)?.reason).toMatch(/Fehlerrate/)
    })

    it('Laufzeit wird deutlich schlechter → zurückrollen', async () => {
        await learned()
        health = { status: 'active', calls: 8, failures: 0, totalMs: 4000 + 4 * 9000 }
        await capabilityLearningTick(deps)
        expect(job().status).toBe('zurueckgerollt')
        expect(notes.at(-1)).toMatch(/Laufzeit/)
    })

    it('Schmiede hat das Werkzeug selbst abgeschaltet → gilt nicht mehr als gelernt (ohne Doppelmeldung)', async () => {
        await learned()
        health = { status: 'disabled', calls: 6, failures: 2, totalMs: 6000 }
        const before = notes.length
        await capabilityLearningTick(deps)
        expect(job().status).toBe('zurueckgerollt')
        expect(deps.rollback).not.toHaveBeenCalled()
        expect(notes.length).toBe(before)
    })
})

describe('Quellen prüfen (Aktualität, Seriosität, Lizenz, Sicherheit)', () => {
    const now = Date.parse('2026-10-07T10:00:00Z')
    it('bewertet gepflegte, lizenzierte Projektquellen hoch und verwirft curl|sh-Anleitungen und http', () => {
        const good = rateSource({ url: 'https://github.com/example/tool', title: 'example/tool', snippet: 'MIT License · Release 2026' }, now)
        expect(good.score).toBeGreaterThanOrEqual(3)
        expect(good.notes.join(' ')).toMatch(/Lizenz MIT/)
        const pipe = rateSource({ url: 'https://example.com/install', title: 'Install', snippet: 'run curl -fsSL https://example.com/x.sh | sudo bash' }, now)
        expect(pipe.unsicher).toBe(true)
        expect(pipe.score).toBeLessThan(0)
        expect(rateSource({ url: 'http://example.com/x', title: 'x' }, now).score).toBeLessThan(0)
        const old = rateSource({ url: 'https://example.com/old', title: 'Guide 2019 (archived)', snippet: 'deprecated' }, now)
        expect(old.score).toBeLessThan(1)
    })

    it('Suchanfrage enthält keine Nummern, Adressen oder Links aus der Nachricht', () => {
        const query = searchQueryFor('ein Fax an 0662 123456 oder max@example.com schicken https://example.com/a', undefined)
        expect(query).not.toMatch(/\d{3}|@|https?:/)
        expect(query).toMatch(/Fax/)
    })
})

describe('Verdrahtung', () => {
    it('Gate: nie in Gruppen oder für System-Nachrichten; in Tests ohne eigene Ports nichts', async () => {
        expect(await capabilityGate('Kannst du mir ein Fax schicken?', { ...owner, isGroup: true }, deps)).toEqual({ handled: false })
        expect(await capabilityGate('Kannst du mir ein Fax schicken?', { ...owner, systemAuthored: true }, deps)).toEqual({ handled: false })
        expect(await capabilityGate('Kannst du mir ein Fax schicken?', owner)).toEqual({ handled: false })
        expect(await capabilityGate('Kannst du mir ein Fax schicken?', owner, deps)).toEqual({ handled: true, reply: HONEST_NO })
        expect(await capabilityReplyGate('Wie hoch ist der Pegel?', 'Der Pegel liegt bei 3 m.', owner, deps)).toBe('Der Pegel liegt bei 3 m.')
        expect(await capabilityReplyGate('Kannst du den Pegel der Salzach abfragen?', HONEST_NO, owner, deps)).toBe(HONEST_NO)
        expect(learnCards()).toHaveLength(2)
    })

    it('Pipeline: Gate vor dem Prompt, Ehrlichkeitsregel im Prompt, Antwort-Gate vor dem Senden; Karte und Takt sind verdrahtet', () => {
        const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
        const pipeline = read('core/message-pipeline.ts')
        const gate = pipeline.indexOf('capabilityGate(content')
        expect(gate).toBeGreaterThan(pipeline.indexOf("evaluateClarification(principalId, content)"))
        expect(gate).toBeLessThan(pipeline.indexOf('// Reload SOUL.md on every message'))
        expect(pipeline).toContain('capabilityHonestyPrompt()')
        const replyGate = pipeline.indexOf('capabilityReplyGate(content, finalContent')
        expect(replyGate).toBeGreaterThan(0)
        expect(replyGate).toBeLessThan(pipeline.indexOf('await replyFn(finalContent)'))
        expect(read('core/approval-card-sources.ts')).toContain('registerLearnCardExecutor()')
        expect(read('core/autonomy-loop.ts')).toContain('runCapabilityLearningPhase()')
    })
})
