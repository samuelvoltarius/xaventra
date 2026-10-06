/**
 * 2.87 Paket P: ausgehende Anrufe.
 *
 * - An eine Owner-Nummer: direkt (der Owner ruft sich selbst an).
 * - An jede andere Nummer: nur per Karte (Wirkung „extern“ — ein Anruf
 *   verlässt das Haus und kostet Guthaben, also Geld). Erst das Ja auf der
 *   Karte wählt.
 * - Gewählt wird über die Telefonanlage (Asterisk ARI auf 127.0.0.1), die der
 *   Owner dafür freigeschaltet hat. Ohne Freischaltung: ehrlicher Satz, nichts
 *   passiert. Der direkte Weg braucht den Telefon-Baustein (noch nicht da).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getNovaDataDir } from '../core/data-root.js'
import type { CardExecutor } from '../core/approval-cards.js'
import { isOwnerNumber, normalizeNumber, readAriPasswort, readTelefonConfig, type TelefonConfig, type TelefonStoreOptions } from './telefon-config.js'
import { allowOutbound } from './telefon-bridge.js'

export const TELEFON_CARD_KIND = 'telefon-anruf'
const PLAN_ID = /^t-[a-f0-9]{12}$/
const PLAN_TTL_MS = 60 * 60_000

export type AnrufEntscheidung =
    | { art: 'direkt'; nummer: string }
    | { art: 'karte'; nummer: string }
    | { art: 'nein'; text: string }

export function entscheideAnruf(nummer: unknown, config: TelefonConfig): AnrufEntscheidung {
    const number = normalizeNumber(nummer)
    if (!/^\+[1-9]\d{6,14}$/.test(number)) return { art: 'nein', text: 'Bitte die Nummer mit Ländervorwahl angeben, z. B. +43 …' }
    if (!config.aktiv) return { art: 'nein', text: 'Das Telefon ist ausgeschaltet.' }
    return isOwnerNumber(number, config.ownerNummern) ? { art: 'direkt', nummer: number } : { art: 'karte', nummer: number }
}

export interface AriDeps { fetch?: typeof fetch; opts?: TelefonStoreOptions }

/** Wählt über Asterisk ARI (nur 127.0.0.1); das Gespräch landet im Kontext „xaventra“. */
export async function waehleUeberAnlage(nummer: string, config: TelefonConfig, deps: AriDeps = {}): Promise<{ ok: boolean; text: string }> {
    if (config.weg !== 'asterisk') return { ok: false, text: 'Anrufen direkt aus Xaventra braucht noch den Telefon-Baustein. Über eine Telefonanlage geht es schon.' }
    const url = config.asterisk.ariUrl
    const user = config.asterisk.ariBenutzer
    const password = readAriPasswort(deps.opts)
    if (!url || !user || !password || !config.asterisk.ausgang) return { ok: false, text: 'Zum Anrufen muss die Telefonanlage das noch erlauben (ARI und Ausgangsleitung, Anleitung in den Telefon-Einstellungen).' }
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(url)) return { ok: false, text: 'Die Telefonanlage wird nur auf diesem Rechner angesprochen.' }
    const endpoint = config.asterisk.ausgang.replace('{nummer}', nummer)
    const query = new URLSearchParams({ endpoint, extension: 's', context: 'xaventra-raus', priority: '1', timeout: '45', ...(config.sip.rufnummer ? { callerId: config.sip.rufnummer } : {}) })
    allowOutbound(nummer)
    try {
        const response = await (deps.fetch || fetch)(`${url}/ari/channels?${query}`, {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ variables: { XAVENTRA_NUMMER: nummer } }),
            signal: AbortSignal.timeout(8_000),
        })
        if (response.ok) return { ok: true, text: `Ich rufe ${nummer} an.` }
        if (response.status === 401) return { ok: false, text: 'Die Telefonanlage hat den Zugang abgelehnt — ARI-Benutzer und Passwort prüfen.' }
        return { ok: false, text: `Die Telefonanlage konnte nicht wählen (Code ${response.status}).` }
    } catch {
        return { ok: false, text: 'Die Telefonanlage ist gerade nicht erreichbar.' }
    }
}

// ------------------------------------------------------------------ Karten

interface Plan { id: string; nummer: string; createdAt: number }
const planFile = (opts: TelefonStoreOptions = {}) => join(opts.dataDir || getNovaDataDir(), 'telefon', 'ausgang.json')

function loadPlans(opts: TelefonStoreOptions = {}): Plan[] {
    try { const raw = JSON.parse(readFileSync(planFile(opts), 'utf8')); return Array.isArray(raw?.plaene) ? raw.plaene : [] } catch { return [] }
}
function savePlans(plans: Plan[], opts: TelefonStoreOptions = {}): void {
    const path = planFile(opts)
    mkdirSync(join(opts.dataDir || getNovaDataDir(), 'telefon'), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, plaene: plans.slice(-50) }), { mode: 0o600 })
    renameSync(tmp, path)
}

export function neuerAnrufPlan(nummer: string, opts: TelefonStoreOptions = {}): Plan {
    const now = (opts.now || Date.now)()
    const plan = { id: `t-${randomBytes(6).toString('hex')}`, nummer, createdAt: now }
    savePlans([...loadPlans(opts).filter(item => now - item.createdAt < PLAN_TTL_MS), plan], opts)
    return plan
}

/** Karte für einen Anruf an eine fremde Nummer (Geld/extern = immer Karte). */
export async function anrufKarte(nummer: string, opts: TelefonStoreOptions = {}): Promise<{ ok: boolean; text: string }> {
    const { createApprovalCard } = await import('../core/approval-cards.js')
    const plan = neuerAnrufPlan(nummer, opts)
    const result = createApprovalCard({
        art: TELEFON_CARD_KIND, titel: `${nummer} anrufen?`,
        beleg: 'Ein Anruf an eine Nummer außerhalb deiner Owner-Nummern verlässt das Haus und kostet Guthaben.',
        vorschlag: `${nummer} anrufen — nur genau das.`, aktion: { kind: TELEFON_CARD_KIND, ref: plan.id },
        wirkung: 'extern', ablaufMs: PLAN_TTL_MS, quelle: 'telefon', direkteAntwort: true,
    }, opts.dataDir ? { dataDir: opts.dataDir } : {})
    return result.ok ? { ok: true, text: `${nummer} ist keine Owner-Nummer. Bitte bestätige den Anruf auf der Karte.` }
        : { ok: false, text: 'Die Karte konnte ich nicht anlegen — nichts gewählt.' }
}

export function createTelefonCardExecutor(deps: AriDeps = {}): CardExecutor {
    return {
        kind: TELEFON_CARD_KIND,
        impact: 'extern',
        allowAlways: () => false,
        async execute(card) {
            const ref = String(card.aktion.ref || '')
            const plan = PLAN_ID.test(ref) ? loadPlans(deps.opts).find(item => item.id === ref) : undefined
            if (!plan) return { ok: false, message: 'Unbekannter Anruf — nichts gewählt.' }
            savePlans(loadPlans(deps.opts).filter(item => item.id !== ref), deps.opts)
            const config = readTelefonConfig(deps.opts)
            if (!config.aktiv) return { ok: false, message: 'Das Telefon ist ausgeschaltet — nichts gewählt.' }
            const result = await waehleUeberAnlage(plan.nummer, config, deps)
            return { ok: result.ok, message: result.text }
        },
        async reject(card) {
            savePlans(loadPlans(deps.opts).filter(item => item.id !== card.aktion.ref), deps.opts)
            return { ok: true, message: 'Gut, ich rufe nicht an.' }
        },
    }
}

/** Ein ausgehender Anruf auf Wunsch des Owners: Owner-Nummer direkt, sonst Karte. */
export async function anrufen(nummer: unknown, deps: AriDeps = {}): Promise<string> {
    const config = readTelefonConfig(deps.opts)
    const decision = entscheideAnruf(nummer, config)
    if (decision.art === 'nein') return decision.text
    if (decision.art === 'karte') return (await anrufKarte(decision.nummer, deps.opts)).text
    return (await waehleUeberAnlage(decision.nummer, config, deps)).text
}
