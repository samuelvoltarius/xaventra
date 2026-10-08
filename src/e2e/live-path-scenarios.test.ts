/**
 * 2.89 Paket D „Echte Abnahme": the live sentences of 06./07.10.2026 over the REAL
 * daemon entry (createDaemonMessageEntry → message-pipeline → runNovaAgent, real tool
 * registry, real tool router in filtered mode, no NOVA_OS_MODE). The model is the only
 * fake (test/helpers/e2e-harness.ts).
 *
 * Every scenario checks: which tools the model was offered, no raw text / catalog in
 * the answer, never „Die Aufgabe ist nicht abgeschlossen", and the expected card/answer.
 *
 * The scenarios that were red on 2.88.3 are named after the package that fixed them
 * (A tools/router/rounds, B connection truth, C capability truth, E pipeline). Since the
 * 2.89 integration every scenario is a plain `it` — none may stay red.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    createE2EHarness, OWNER_TELEGRAM_ID, rawOrCatalogLeak, seedPausedAuftrag,
    type E2EHarness, type HarnessOptions, type TurnResult,
} from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined; vi.unstubAllEnvs() })
async function harness(options: HarnessOptions = {}): Promise<E2EHarness> {
    h = await createE2EHarness(options)
    return h
}

/** Common checks of every scenario. */
function expectClean(result: TurnResult): void {
    expect(result.error, `turn threw: ${String(result.error)}`).toBeUndefined()
    expect(result.final.trim().length + result.buttons.length).toBeGreaterThan(0)
    for (const reply of result.replies) {
        const leak = rawOrCatalogLeak(reply)
        expect(leak, `forbidden text ${leak} in reply: ${reply.slice(0, 300)}`).toBeUndefined()
    }
}

const T = 60_000

describe('Paket D — live sentences over the real entry: answers', () => {
    it('[2.89 A] „homeassit sollte schon laufen" — Home Assistant tools offered, the model answers after its check (A: tool error ends the run)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('homeassit sollte schon laufen', [
            { tool: 'run_command', args: { command: 'docker ps' } }, { text: 'Home Assistant ist noch nicht verbunden — ich richte es ein, wenn du willst.' },
        ])
        expect(result.offeredTools).toContain('hass_status')
        // 2.89.1: hass_status runs FIRST (deterministic); a following shell search is refused.
        expect(result.executedTools[0]).toBe('hass_status')
        expect(result.executedTools).not.toContain('run_command')
        expectClean(result)
        expect(result.final).toContain('Home Assistant ist noch nicht verbunden')
    }, T)

    it('[2.89 B] „Ist Home Assistant verbunden?" — answered from the one connection truth, no model guess (B)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Ist Home Assistant verbunden?', [{ text: 'Ja, Home Assistant ist verbunden.' }])
        expectClean(result)
        // Nothing is connected in this fresh environment: the answer must say so, whatever the model claims.
        expect(result.final).toMatch(/nicht verbunden|noch nicht/i)
        expect(result.final).not.toMatch(/^Ja, Home Assistant ist verbunden/)
        expect(result.trace).toContain('connect:status')
        expect(result.rounds).toHaveLength(0)
    }, T)

    it('„Kannst du ein Fax senden?" — honest no + learning card for the owner, no model', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Kannst du ein Fax senden?', [{ text: 'Klar, ich sende Faxe.' }])
        expectClean(result)
        expect(result.trace).toContain('capability:honest-no')
        expect(result.final).toMatch(/Soll ich es lernen\?/)
        expect(result.rounds).toHaveLength(0)
        const { listApprovalCards } = await e2e.module('core/approval-cards.js')
        const card = listApprovalCards().find((item: any) => item.art === 'faehigkeit-lernen')
        expect(card?.status).toBe('offen')
        expect(card?.titel).toMatch(/Fax/)
    }, T)

    it('„searxng kannst du dich mit dem verbinen ?" — SearXNG already in use → „schon verbunden", no model', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram('searxng kannst du dich mit dem verbinen ?', [{ text: 'Wie lautet die Adresse?' }])
        expectClean(result)
        expect(result.trace).toContain('connect:already-connected')
        expect(result.final).toMatch(/schon verbunden/)
        expect(result.rounds).toHaveLength(0)
    }, T)

    it('[2.89 A] „paperless kannst du dich mit dem verbinen ?" (typo, not connected) — connect tools offered (A: stems/typos)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('paperless kannst du dich mit dem verbinen ?', [
            { tool: 'dienst_finden', args: { name: 'paperless' } }, { text: 'Ich habe Paperless noch nicht gefunden.' },
        ])
        expectClean(result)
        expect(result.offeredTools).toEqual(expect.arrayContaining(['dienst_finden', 'dienst_verbinden']))
    }, T)

    it('„Was kann welcher Knoten?" — node strengths offered and used', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Was kann welcher Knoten?', [
            { tool: 'mesh_strengths' }, { text: 'Hier ist, was jeder Knoten kann.' },
        ])
        expect(result.offeredTools).toContain('mesh_strengths')
        expect(result.executedTools).toContain('mesh_strengths')
        expectClean(result)
        expect(result.final).toContain('Hier ist, was jeder Knoten kann.')
    }, T)

    it('[2.89 A] „Welche VMs laufen auf meinem Proxmox?" — proxmox_vm offered; an unreachable Proxmox ends in a plain answer, not a stop (A)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Welche VMs laufen auf meinem Proxmox?', [
            { tool: 'proxmox_vm', args: { action: 'list' } }, { text: 'Proxmox ist noch nicht verbunden — unter „Verbindungen → Proxmox" reicht ein Token.' },
        ])
        expect(result.offeredTools).toContain('proxmox_vm')
        expect(result.executedTools).toContain('proxmox_vm')
        expectClean(result)
        expect(result.final).toContain('Proxmox ist noch nicht verbunden')
    }, T)

    it('„Welche smarten Geräte findest du?" — the environment overview answers from the inventory', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Welche smarten Geräte findest du?', [{ text: 'Ich sehe 20 Geräte.' }])
        expectClean(result)
        expect(result.final).toMatch(/Geräte/)
        expect(result.final).not.toContain('Ich sehe 20 Geräte')
    }, T)

    it('„Kümmer dich um X und nebenbei um Y" + „Wie steht\'s?" — two projects, then their status', async () => {
        const e2e = await harness()
        const start = await e2e.telegram('Kümmer dich um die Steuerunterlagen und nebenbei um den Gartenplan')
        expectClean(start)
        expect(start.trace).toContain('projects:handled')
        expect(start.final).toMatch(/Steuerunterlagen/)
        expect(start.final).toMatch(/Gartenplan/)
        const status = await e2e.telegram('Wie steht\'s?')
        expectClean(status)
        expect(status.trace).toContain('projects:handled')
        expect(status.final).toMatch(/Steuerunterlagen/)
        expect(status.final).toMatch(/Gartenplan/)
    }, T)

    it('[2.89 A] „Erinnere mich in 10 Minuten an den Kuchen" — set_reminder offered and the reminder stored (A: router)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Erinnere mich in 10 Minuten an den Kuchen', [
            { tool: 'set_reminder', args: { message: 'Kuchen', time: 'in 10 min' } }, { text: 'Ich erinnere dich in 10 Minuten an den Kuchen.' },
        ])
        expect(result.offeredTools).toContain('set_reminder')
        expect(result.executedTools).toContain('set_reminder')
        expectClean(result)
    }, T)

    it('[2.89 A] „Heizung auf 21 Grad" — a Home Assistant service call (climate) is offered (A: hass_service unreachable)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Heizung auf 21 Grad', [
            { tool: 'hass_service', args: { domain: 'climate', service: 'set_temperature', data: { temperature: 21 } } },
            { text: 'Home Assistant ist noch nicht verbunden, deshalb konnte ich die Heizung nicht stellen.' },
        ])
        expect(result.offeredTools).toEqual(expect.arrayContaining(['hass_status', 'hass_service']))
        expectClean(result)
    }, T)

    it('„recherchiere …" — web search offered, SearXNG result, model summarises', async () => {
        const e2e = await harness({ searxng: true })
        const result = await e2e.telegram('recherchiere die besten Wanderwege im Salzkammergut', [
            { tool: 'searxng_search', args: { query: 'beste Wanderwege Salzkammergut' } },
            { text: 'Zwei gute Wege: Wanderweg A (12 km, leicht) und Wanderweg B (18 km, mittel).' },
        ])
        expect(result.offeredTools).toContain('searxng_search')
        expect(result.executedTools).toContain('searxng_search')
        expectClean(result)
        expect(result.final).toContain('Wanderweg A')
    }, T)

    it('„Lichter darfst du ohne Frage schalten" — the owner rule is stored (decisions)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Lichter darfst du ohne Frage schalten', [{ text: 'Alles klar, Lichter schalte ich ab jetzt ohne Rückfrage.' }])
        expectClean(result)
        const { listDecisions } = await e2e.module('core/decisions.js')
        const rules = listDecisions().filter((item: any) => item.status === 'aktiv')
        expect(rules.length, JSON.stringify(listDecisions()).slice(0, 400)).toBeGreaterThan(0)
        expect(JSON.stringify(rules)).toMatch(/licht/i)
    }, T)

    it('„kannst du mir von deinen nodes screenshots senden" — mesh_screenshot offered; no invented „alle Bilder gesendet"', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('kannst du mir von deinen nodes screenshots senden', [
            { tool: 'mesh_screenshot', args: {} }, { text: 'Alle Bilder gesendet.' },
        ])
        expect(result.offeredTools).toContain('mesh_screenshot')
        expectClean(result)
        expect(result.final).not.toContain('Alle Bilder gesendet')
        expect(result.final).toMatch(/kein(e)? (Bild|Bilddatei)/i)
    }, T)

    it('[2.89 C] „hast du Internet?" — answered from one measured source, not a model claim (C)', async () => {
        const e2e = await harness()
        // The network of this harness is closed: the one internet probe (core/environment.ts) is
        // answered offline here, without a real ping. The model claims the opposite.
        const environment = await e2e.module('core/environment.js')
        expect(environment.hasInternet({ force: true, run: () => { throw new Error('e2e harness: network closed') } })).toBe(false)
        const result = await e2e.telegram('hast du Internet?', [{ text: 'Ja, Internet geht.' }], { fallback: 'Ja, Internet geht.' })
        expectClean(result)
        expect(result.trace).toContain('fast-path:internet-status')
        expect(result.final).toMatch(/^Nein, gerade habe ich kein Internet/)
        // Either a check ran in this turn or a measured source answered — never the bare model claim.
        const measured = result.executedTools.length > 0 || result.trace.some(step => step.startsWith('fast-path:') || step.startsWith('capability:'))
        expect(measured, `tools=${result.executedTools} trace=${result.trace}`).toBe(true)
    }, T)

    it('answer „habe getestet" without any tool → the Ungeprüft note is in front', async () => {
        const e2e = await harness()
        const claim = 'Ich habe die Verbindung zum Drucker getestet, alles läuft.'
        const result = await e2e.telegram('Erzähl mir kurz was über den Drucker im Büro', [{ text: claim }], { fallback: claim })
        expectClean(result)
        expect(result.executedTools).toHaveLength(0)
        expect(result.final).toContain(claim)
        expect(result.final).toMatch(/^⚠️ Ungeprüft/)
    }, T)
})

describe('Paket D — channels: /status and /aktivitaet from the app and from Telegram', () => {
    it('/status from Telegram — buttons', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('/status')
        expect(result.error).toBeUndefined()
        expect(result.buttons.length).toBeGreaterThan(0)
        expect(result.buttons[0].to).toBe(OWNER_TELEGRAM_ID)
        expect(result.buttons[0].text).toMatch(/Status/)
    }, T)

    it('[2.89 E] /status from the app — a text answer, no Telegram buttons (E: slash buttons only for Telegram)', async () => {
        const e2e = await harness()
        const result = await e2e.desktop('/status')
        expect(result.error).toBeUndefined()
        expect(result.buttons).toHaveLength(0)
        expect(result.final).toMatch(/Status/)
    }, T)

    it('/aktivitaet from the app — the activity as text, no Telegram buttons', async () => {
        const e2e = await harness({ seed: root => { seedPausedAuftrag(root) } })
        const result = await e2e.desktop('/aktivitaet')
        expect(result.error).toBeUndefined()
        expect(result.buttons).toHaveLength(0)
        expect(result.final).toMatch(/Was ich gerade tue/)
        expect(result.final).toMatch(/Gartenplan/)
    }, T)

    it('[2.89 E] /aktivitaet from Telegram — stop/later buttons for the running project (E: channel "Telegram" vs "telegram")', async () => {
        const e2e = await harness({ seed: root => { seedPausedAuftrag(root) } })
        const result = await e2e.telegram('/aktivitaet')
        expect(result.error).toBeUndefined()
        expect(result.buttons.length).toBeGreaterThan(0)
        expect(JSON.stringify(result.buttons[0].keyboard)).toMatch(/⏹/)
    }, T)

    it('desktop: a tool answer carries evidence (tools + verifiedEvidence) in the outcome', async () => {
        const e2e = await harness()
        const result = await e2e.desktop('Was kann welcher Knoten?', [{ tool: 'mesh_strengths' }, { text: 'Hier ist, was jeder Knoten kann.' }])
        expectClean(result)
        expect(result.outcome?.tools?.map((tool: any) => tool.name)).toContain('mesh_strengths')
    }, T)

    it('[2.89 Abnahme] desktop: a measured fast-path answer carries its probe as evidence, a static one does not', async () => {
        const e2e = await harness()
        const environment = await e2e.module('core/environment.js')
        environment.hasInternet({ force: true, run: () => { throw new Error('e2e harness: network closed') } })
        const internet = await e2e.desktop('hast du Internet?')
        expectClean(internet)
        expect(internet.trace).toContain('fast-path:internet-status')
        expect(internet.outcome?.verifiedEvidence).toBe(1)
        expect(internet.outcome?.tools?.map((tool: any) => tool.name)).toEqual(['probe:internet-status'])
        const identity = await e2e.desktop('wer bist du')
        expect(identity.trace).toContain('fast-path:identity')
        expect(identity.outcome?.verifiedEvidence || 0).toBe(0)
    }, T)

    it('desktop: „Kannst du ein Fax senden?" — honest no + learning question in the app as well', async () => {
        const e2e = await harness()
        const result = await e2e.desktop('Kannst du ein Fax senden?')
        expectClean(result)
        expect(result.trace).toContain('capability:honest-no')
        expect(result.final).toMatch(/Soll ich es lernen\?/)
    }, T)

    it('[2.89 E] REST with the owner token is the owner: „Kümmer dich um …" starts projects (E: REST never owner)', async () => {
        const e2e = await harness()
        const result = await e2e.rest('Kümmer dich um die Steuerunterlagen und nebenbei um den Gartenplan')
        expectClean(result)
        expect(result.trace).toContain('projects:handled')
    }, T)

    it('[2.89 E] a REST rollout probe (X-Xaventra-Probe: 1) is never the owner: no projects, no owner session', async () => {
        const e2e = await harness()
        const result = await e2e.rest('Kümmer dich um die Steuerunterlagen und nebenbei um den Gartenplan', [{ text: 'Echo.' }], { probe: true })
        expect(result.error).toBeUndefined()
        expect(result.trace).not.toContain('projects:handled')
    }, T)
})

describe('Paket D — runs: rounds, errors, progress, stop words', () => {
    it('[2.89 A] a task with 5 tool rounds finishes with the model answer (no stop after 3) (A: round limits)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Mach bitte nacheinander fünf kleine Prüfungen für meinen Wochenplan und fasse sie dann zusammen', [
            { tool: 'get_current_time' },
            { tool: 'kg_search', args: { query: 'Wochenplan' } },
            { tool: 'nova_introspect' },
            { tool: 'kg_search', args: { query: 'Termine' } },
            { tool: 'nova_capabilities' },
            { text: 'Zusammenfassung: alle fünf Prüfungen sind erledigt.' },
        ])
        expect(result.executedTools.length, result.executedTools.join(',')).toBeGreaterThanOrEqual(5)
        expectClean(result)
        expect(result.final).toContain('Zusammenfassung: alle fünf Prüfungen sind erledigt.')
    }, T)

    it('[2.89 A] a tool error in the middle of a run — the run goes on and the model answers (A: one error is not the end)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Schau nach ob Home Assistant läuft und sag mir danach die Uhrzeit', [
            { tool: 'hass_status' },
            { tool: 'get_current_time' },
            { text: 'Home Assistant antwortet nicht; die Uhrzeit habe ich dir trotzdem geholt.' },
        ])
        expect(result.executedTools).toEqual(expect.arrayContaining(['hass_status', 'get_current_time']))
        expectClean(result)
        expect(result.final).toContain('die Uhrzeit habe ich dir trotzdem geholt')
    }, T)

    it('[2.89 E] a 30 s run shows exactly one sign of life before the answer (E: progress dead with cancellation-only execution)', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Erzähl mir ausführlich, wie ein Fahrrad funktioniert', [
            { delayMs: 30_000, then: { text: 'Ein Fahrrad wandelt Muskelkraft über Kette und Ritzel in Bewegung um.' } },
        ], { fallback: 'Ein Fahrrad wandelt Muskelkraft über Kette und Ritzel in Bewegung um.' })
        expectClean(result)
        const signs = result.replies.filter(reply => /Ich arbeite noch/.test(reply))
        expect(signs, result.replies.join(' | ')).toHaveLength(1)
        expect(result.replies.indexOf(signs[0])).toBeLessThan(result.replies.length - 1)
    }, 90_000)

    it('[2.89 E] „brich den Auftrag bitte nicht ab" does NOT stop the project (E: anchored effect patterns, negation)', async () => {
        const e2e = await harness({ seed: root => { seedPausedAuftrag(root) } })
        const result = await e2e.telegram('brich den Auftrag bitte nicht ab', [{ text: 'Keine Sorge, ich mache weiter.' }])
        expect(result.error).toBeUndefined()
        expect(result.trace.some(step => /mission-stop|mission-cancel/.test(step))).toBe(false)
        const { getMissionData } = await e2e.module('core/autonomous-executor.js')
        expect(getMissionData().active?.status).not.toBe('cancelled')
        expect(getMissionData().active).not.toBeNull()
    }, T)

    it('[2.89 Integration] a read-only self-goal is offered only allowed tools: process_list yes, port_scan never', async () => {
        const e2e = await harness()
        // daemon.ts autonomy loop: handleMessage('Telegram', 'Nova-Autonomy', selfPrompt, …, { systemAuthored: true })
        const result = await e2e.send('Telegram', 'Nova-Autonomy', '[SELF-GOAL] Prüfe, welche Prozesse und offenen Ports auf diesem Rechner laufen, und fasse es kurz zusammen.', [
            { tool: 'process_list', args: { filter: 'node' } },
            { text: 'Es laufen die üblichen Dienste.' },
        ], { execution: { systemAuthored: true } })
        expect(result.error).toBeUndefined()
        expect(result.offeredTools.length).toBeGreaterThan(0)
        expect(result.offeredTools).toContain('process_list')
        expect(result.offeredTools).not.toContain('port_scan')
        expect(result.executedTools).toContain('process_list')
        // Live before: „Read-only automation policy blocked tool: process_list“ → the whole run stopped.
        expect(result.logs.some(line => /Read-only automation policy blocked tool|Governed tool execution stopped/.test(line)), result.logs.filter(line => /blocked|stopped/.test(line)).join(' | ')).toBe(false)
        // Every offered tool is one the read-only policy lets run.
        const { isGovernedReadOnlyTool } = await e2e.module('agents/tool-authorization.js')
        expect(result.offeredTools.filter((name: string) => !isGovernedReadOnlyTool(name))).toEqual([])
    }, T)
})

// 2.89.4 item 6 — live 09.10.2026: „Auf welchem Node…" for an inventory and a DHL
// shipment number (the question even arrived BEFORE the message: stale pending).
// Reports and package tracking have no effect target; tracking looks the shipment up.
describe('2.89.4 — reports and package tracking never ask for a node', () => {
    it('„Mach eine Inventur von allem, was du so kannst" — answered, no node question', async () => {
        const e2e = await harness()
        const result = await e2e.telegram('Mach eine Inventur von allem, was du so kannst', [
            { tool: 'nova_capabilities' },
            { text: 'Hier ist meine Inventur der Fähigkeiten.' },
        ])
        expect(result.error, String(result.error)).toBeUndefined()
        expect(result.final).not.toMatch(/Auf welchem Node/)
        expect(result.rounds.length).toBeGreaterThan(0)
        expectClean(result)
    }, T)

    // Number freely invented from documentation test data (RFC 5737 192.0.2.0/24).
    const TRACKING = '192020250'

    it(`„…trackst, Sendungsnummer ${TRACKING}" — no node question, parcel_track with fake fetch`, async () => {
        vi.stubEnv('XAVENTRA_DHL_TRACKING_API_KEY', 'x'.repeat(32))
        const e2e = await harness({
            routes: [{
                match: /api-eu\.dhl\.com\/track\/shipments/,
                respond: () => ({ json: { shipments: [{
                    id: TRACKING,
                    status: { statusCode: 'transit', description: 'Sendung ist unterwegs', timestamp: '2026-10-05T10:00:00Z' },
                    service: 'Express',
                }] } }),
            }],
        })
        const text = `ich hätte gerne, dass du dieses DHL-Express-Paket trackst, Sendungsnummer ${TRACKING}`
        const result = await e2e.telegram(text, [
            { tool: 'parcel_track', args: { number: TRACKING, provider: 'dhl' } },
            { text: `Dein DHL-Paket ${TRACKING} ist unterwegs.` },
        ])
        expect(result.error, String(result.error)).toBeUndefined()
        expect(result.final).not.toMatch(/Auf welchem Node/)
        expect(result.offeredTools).toContain('parcel_track')
        expect(result.executedTools).toContain('parcel_track')
        expectClean(result)
    }, T)

    it(`„Verfolge DHL ${TRACKING}" — no node question, web lookup with fake fetch when no tracking API is set`, async () => {
        vi.stubEnv('XAVENTRA_DHL_TRACKING_API_KEY', '')
        vi.stubEnv('XAVENTRA_17TRACK_TOKEN', '')
        const e2e = await harness({
            routes: [{
                match: /duckduckgo\.com/,
                respond: () => ({ json: {
                    AbstractText: `DHL Sendung ${TRACKING}: Unterwegs, Zustellung erwartet 07.10.2026`,
                    AbstractURL: `https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html?piececode=${TRACKING}`,
                    RelatedTopics: [],
                } }),
            }],
        })
        const result = await e2e.telegram(`Verfolge DHL ${TRACKING}`, [
            { tool: 'web_search', args: { query: `DHL Sendungsverfolgung ${TRACKING}` } },
            { text: `Sendung ${TRACKING} ist unterwegs.` },
        ])
        expect(result.error, String(result.error)).toBeUndefined()
        expect(result.final).not.toMatch(/Auf welchem Node/)
        expect(result.executedTools).toContain('web_search')
        expectClean(result)
    }, T)
})
