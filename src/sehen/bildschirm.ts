/**
 * 2.88 „Sehen und lenken“ Teil 1: Ihr Computer — die Computer-Session.
 *
 * Jeder Node mit grafischer Sitzung erscheint als „Bildschirm“ (generisch:
 * Spark-Desktop, Labor-VM-Desktop, jede eingerichtete Sitzung). Quellen, die
 * es schon gibt — nichts Neues nach außen:
 *   Sitzung   Mesh-Capture (mesh/node-capture.ts, requestNodeCapture): nur
 *             Nodes, deren Betreiber die Aufnahme lokal eingerichtet hat
 *             (NOVA_MESH_CAPTURE_ENABLED, NOVA_CAPTURE_SOCKET); gesperrte
 *             Sitzungen werden nie entsperrt.
 *   Virtuell  Desktop-Direkt (desktop-direct/*): virtuelle Bildschirme über
 *             den vorhandenen Einmal-Link.
 * Das Bild kommt nur über die authentifizierte Owner-API (kein neuer Port):
 * die App holt im Sekundentakt ein frisches Bild (gedrosselt, ein Abruf je
 * Bildschirm gleichzeitig).
 *
 * Knöpfe: Zuschauen · Übernehmen · Stoppen · Anderes Ziel.
 *   Übernehmen  Xaventra stoppt SOFORT eigene Maus/Tastatur (derselbe Halt wie
 *               /desktop „Übernehmen“, desktop-direct/pause.ts) und schaut nur
 *               zu. Der Owner bedient selbst — Eingaben nur, wenn sie auf
 *               diesem Rechner schon erlaubt sind (NOVA_DESKTOP_INPUT_ENABLED
 *               und eingerichtete Sitzung). „Zurückgeben“ hebt den Halt auf.
 *   Stoppen     Halt wie oben plus Stopp der laufenden Aktivitäten auf diesem
 *               Node (über die Aktivitäts-Knöpfe, also die vorhandenen Wege).
 *   Anderes Ziel  Freitext als Gedanke an den Planer.
 * Halte gelten bis „Zurückgeben“ oder bis zum Neustart des Main (dann gibt
 * es auch keinen laufenden Desktop-Schritt mehr).
 */
import { createHash, randomUUID } from 'node:crypto'
import { agentDesktopInputPauseReason, holdAgentDesktopInput } from '../desktop-direct/pause.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { Aktivitaet } from './aktivitaet.js'

export type BildschirmZustand = 'bereit' | 'unbekannt' | 'gesperrt' | 'kein-bild'
export type BildschirmAktion = 'uebernehmen' | 'zurueckgeben' | 'stoppen' | 'ziel'

export interface Bildschirm {
    id: string
    name: string
    art: 'sitzung' | 'virtuell'
    zustand: BildschirmZustand
    zustandText: string
    lokal: boolean
    /** 'bild' = Live-Bild über die Owner-API; 'link' = eigenes Fenster (Desktop-Direkt). */
    zuschauen: 'bild' | 'link'
    /** Darf der Owner nach „Übernehmen“ selbst klicken/tippen? */
    eingabeErlaubt: boolean
    /** Desktop-Direkt erlaubt Bedienen im eigenen Fenster. */
    linkSteuern: boolean
    uebernommen: boolean
    gestoppt: boolean
    /** Was Xaventra dort gerade tut (kurz) oder ''. */
    tut: string
}

export interface BildschirmBild { mimeType: 'image/png' | 'image/jpeg'; base64: string; bytes: number; sha256: string; capturedAt: string }
export interface BildschirmAntwort { ok: boolean; message: string; zustand?: BildschirmZustand }

const NODE_ID = /^[A-Za-z0-9_.-]{1,80}$/
const ID = /^(node|direkt):[A-Za-z0-9_.-]{1,80}$/
export const BILD_MIN_ABSTAND_MS = 1_500
const PROBE_ABSTAND_MS = 10 * 60_000
const ZUSTAND_TEXT: Record<BildschirmZustand, string> = {
    bereit: 'bereit', unbekannt: 'noch nicht angesehen', gesperrt: 'gesperrt – ich entsperre nie selbst', 'kein-bild': 'kein eingerichteter Bildschirm',
}

const clean = (value: unknown, max = 160) => redactSecrets(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export interface BildschirmDeps {
    now?: () => number
    env?: NodeJS.ProcessEnv
    lokalerNode?: () => string
    /** Online-Nodes, die eine Sitzung haben KÖNNTEN (Mesh). */
    nodes?: () => Promise<string[]>
    /** Ein Bild von genau diesem Node (Mesh-Capture, Main-Autorität). */
    aufnahme?: (node: string, principalId: string) => Promise<{ base64: string; bytes: number; sha256: string; capturedAt: string; mimeType: 'image/png' }>
    direkt?: () => Promise<{ enabled: boolean; desktops: Array<{ id: string; label: string; allowControl: boolean; agentInput: boolean; active: string[] }> }>
    aktivitaet?: () => Promise<Aktivitaet[]>
    stoppeAktivitaet?: (id: string, by: string) => Promise<{ ok: boolean; message: string }>
    gedanke?: (input: { title: string; evidence: string; proposal: string; node?: string }) => Promise<boolean>
    /** Eine Owner-Eingabe auf der lokal eingerichteten Sitzung. */
    eingabe?: (action: unknown) => Promise<unknown>
}

function produktion(d: BildschirmDeps): Required<BildschirmDeps> {
    return {
        now: d.now || Date.now,
        env: d.env || process.env,
        lokalerNode: d.lokalerNode || (() => { try { return process.env.NOVA_NODE_ID || 'main' } catch { return 'main' } }),
        nodes: d.nodes || (async () => (await import('../mesh/mesh-transport-runtime.js')).currentCaptureNodes()),
        aufnahme: d.aufnahme || (async (node, principalId) => (await import('../mesh/mesh-transport-runtime.js')).requestNodeCapture(node, { operation: 'capture', principalId, runId: `bildschirm-${randomUUID()}` })),
        direkt: d.direkt || (async () => (await import('../desktop-direct/runtime.js')).listDirectDesktops()),
        aktivitaet: d.aktivitaet || (async () => (await (await import('./aktivitaet.js')).sammleAktivitaet()).eintraege),
        stoppeAktivitaet: d.stoppeAktivitaet || (async (id, by) => (await import('./aktivitaet.js')).steuereAktivitaet(id, 'stopp', { by })),
        gedanke: d.gedanke || (async input => {
            const { getPlannerRuntime } = await import('../planner/runtime.js')
            const store = getPlannerRuntime()?.thoughts || (await import('../planner/index.js')).getThoughtStore()
            store.add({ source: 'owner-lenkung', kind: 'vorschlag', title: input.title, evidence: input.evidence, proposal: input.proposal, severity: 'info', permission: 'fragen', ...(input.node ? { node: input.node } : {}) })
            return true
        }),
        eingabe: d.eingabe || (async action => {
            const { requestSessionInput } = await import('../host/capture-agent.js')
            return requestSessionInput(process.env.NOVA_CAPTURE_SOCKET || '', process.env.NOVA_CAPTURE_TOKEN_FILE || '', randomUUID(), action)
        }),
    }
}

// ---------------------------------------------------------------------------
// Zustand (nur im Speicher des Main)
// ---------------------------------------------------------------------------

const bekannt = new Map<string, { zustand: BildschirmZustand; at: number }>()
const letztesBild = new Map<string, { bild: BildschirmBild; at: number }>()
const laufend = new Map<string, Promise<BildschirmBild | BildschirmAntwort>>()
const halte = new Map<string, { art: 'uebernommen' | 'gestoppt'; release: () => void; name: string }>()

/** Test helper. */
export function _resetBildschirme(): void {
    bekannt.clear(); letztesBild.clear(); laufend.clear()
    for (const hold of halte.values()) hold.release()
    halte.clear()
}

function lokalEingerichtet(env: NodeJS.ProcessEnv): boolean {
    return env.NOVA_MESH_CAPTURE_ENABLED === '1' && Boolean(env.NOVA_CAPTURE_SOCKET) && Boolean(env.NOVA_CAPTURE_TOKEN_FILE)
}
function eingabeErlaubt(env: NodeJS.ProcessEnv): boolean {
    return env.NOVA_DESKTOP_INPUT_ENABLED === '1' && Boolean(env.NOVA_CAPTURE_SOCKET) && Boolean(env.NOVA_CAPTURE_TOKEN_FILE)
}

function zustandAus(error: unknown): { zustand: BildschirmZustand; message: string } {
    const text = String((error as Error)?.message || error)
    if (/locked|gesperrt/i.test(text)) return { zustand: 'gesperrt', message: 'Der Bildschirm ist gesperrt. Ich entsperre nie selbst – entsperr ihn am Gerät.' }
    if (/not enrolled|no enrolled|headless|no desktop image|unavailable/i.test(text)) return { zustand: 'kein-bild', message: 'Dieser Rechner hat keinen eingerichteten Bildschirm.' }
    if (/fenc|authority|autorit/i.test(text)) return { zustand: 'unbekannt', message: 'Zusehen geht nur über den Hauptrechner – der ist gerade nicht zuständig.' }
    return { zustand: 'unbekannt', message: 'Gerade kommt kein Bild. Ich versuche es gleich wieder.' }
}

function tutAuf(node: string, lokal: boolean, eintraege: readonly Aktivitaet[]): string {
    const passend = eintraege.filter(item => item.jetzt && (item.node === node || (lokal && ['main', 'local', 'lokal'].includes(item.node))))
    return passend[0] ? clean(`${passend[0].artText}: ${passend[0].tut}`, 120) : ''
}

// ---------------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------------

export async function listeBildschirme(deps: BildschirmDeps = {}): Promise<{ bildschirme: Bildschirm[]; ohneBildschirm: string[]; agentPausiert: string | null; probleme: string[] }> {
    const d = produktion(deps)
    const now = d.now()
    const probleme: string[] = []
    const lokal = clean(d.lokalerNode(), 80)
    let nodes: string[] = []
    try { nodes = (await d.nodes()).filter(node => NODE_ID.test(node)) } catch (error) { probleme.push(`Knoten: ${clean((error as Error)?.message || error, 120)}`) }
    if (!nodes.includes(lokal) && NODE_ID.test(lokal)) nodes.unshift(lokal)
    let eintraege: Aktivitaet[] = []
    try { eintraege = await d.aktivitaet() } catch { /* nur für „was sie dort tut“ */ }
    const out: Bildschirm[] = []
    const ohne: string[] = []
    for (const node of nodes.slice(0, 16)) {
        const id = `node:${node}`
        const istLokal = node === lokal
        let zustand: BildschirmZustand = bekannt.get(id)?.zustand || 'unbekannt'
        if (istLokal) zustand = lokalEingerichtet(d.env) ? (zustand === 'gesperrt' ? 'gesperrt' : 'bereit') : 'kein-bild'
        else if (zustand === 'unbekannt' || (zustand === 'kein-bild' && now - (bekannt.get(id)?.at || 0) > PROBE_ABSTAND_MS)) void probe(d, id, node)
        if (zustand === 'kein-bild') { ohne.push(node); continue }
        const hold = halte.get(id)
        out.push({
            id, name: node, art: 'sitzung', zustand, zustandText: ZUSTAND_TEXT[zustand], lokal: istLokal, zuschauen: 'bild',
            eingabeErlaubt: istLokal && eingabeErlaubt(d.env), linkSteuern: false,
            uebernommen: hold?.art === 'uebernommen', gestoppt: hold?.art === 'gestoppt', tut: tutAuf(node, istLokal, eintraege),
        })
    }
    try {
        const direkt = await d.direkt()
        for (const desktop of direkt.enabled ? direkt.desktops.slice(0, 16) : []) {
            if (!NODE_ID.test(desktop.id)) continue
            const id = `direkt:${desktop.id}`
            const hold = halte.get(id)
            out.push({
                id, name: clean(desktop.label, 60) || desktop.id, art: 'virtuell', zustand: 'bereit', zustandText: desktop.active.length ? 'gerade offen' : 'bereit', lokal: false, zuschauen: 'link',
                eingabeErlaubt: false, linkSteuern: desktop.allowControl === true, uebernommen: hold?.art === 'uebernommen', gestoppt: hold?.art === 'gestoppt', tut: '',
            })
        }
    } catch (error) { probleme.push(`Virtuelle Bildschirme: ${clean((error as Error)?.message || error, 120)}`) }
    return { bildschirme: out, ohneBildschirm: ohne, agentPausiert: agentDesktopInputPauseReason(), probleme }
}

async function probe(d: Required<BildschirmDeps>, id: string, node: string): Promise<void> {
    const last = bekannt.get(id)
    if (laufend.has(id) || (last && d.now() - last.at < PROBE_ABSTAND_MS && last.zustand !== 'unbekannt')) return
    bekannt.set(id, { zustand: last?.zustand || 'unbekannt', at: d.now() })
    await holeBild(d, id, node, 'xaventra-owner').catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Bild
// ---------------------------------------------------------------------------

async function holeBild(d: Required<BildschirmDeps>, id: string, node: string, principalId: string): Promise<BildschirmBild | BildschirmAntwort> {
    const running = laufend.get(id)
    if (running) return running
    const work = (async (): Promise<BildschirmBild | BildschirmAntwort> => {
        try {
            const receipt = await d.aufnahme(node, principalId)
            const bytes = Buffer.from(String(receipt.base64 || ''), 'base64')
            if (!bytes.length || bytes.length !== receipt.bytes || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw new Error('capture hash mismatch')
            const bild: BildschirmBild = { mimeType: 'image/png', base64: receipt.base64, bytes: receipt.bytes, sha256: receipt.sha256, capturedAt: receipt.capturedAt }
            bekannt.set(id, { zustand: 'bereit', at: d.now() })
            letztesBild.set(id, { bild, at: d.now() })
            return bild
        } catch (error) {
            const mapped = zustandAus(error)
            bekannt.set(id, { zustand: mapped.zustand, at: d.now() })
            return { ok: false, message: mapped.message, zustand: mapped.zustand }
        }
    })()
    laufend.set(id, work)
    try { return await work } finally { laufend.delete(id) }
}

/** Ein aktuelles Bild (höchstens alle 1,5 s neu, sonst das letzte). Nur Owner. */
export async function bildschirmBild(id: unknown, principalId: string, deps: BildschirmDeps = {}): Promise<{ ok: true; bild: BildschirmBild } | { ok: false; message: string; zustand?: BildschirmZustand }> {
    const key = String(id ?? '')
    if (!ID.test(key)) return { ok: false, message: 'Unbekannter Bildschirm.' }
    if (key.startsWith('direkt:')) return { ok: false, message: 'Diesen Bildschirm siehst du im eigenen Fenster (Zuschauen öffnet es).' }
    const d = produktion(deps)
    const node = key.slice('node:'.length)
    const last = letztesBild.get(key)
    if (last && d.now() - last.at < BILD_MIN_ABSTAND_MS) return { ok: true, bild: last.bild }
    const principal = String(principalId || 'owner').replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 200) || 'owner'
    const result = await holeBild(d, key, node, principal)
    if ('base64' in result) return { ok: true, bild: result }
    return { ok: false, message: result.message, ...(result.zustand ? { zustand: result.zustand } : {}) }
}

// ---------------------------------------------------------------------------
// Knöpfe
// ---------------------------------------------------------------------------

function halten(id: string, name: string, art: 'uebernommen' | 'gestoppt'): void {
    const previous = halte.get(id)
    if (previous) { previous.art = art; return }
    const release = holdAgentDesktopInput(`owner-${art}:${id}`, name)
    halte.set(id, { art, release, name })
}

export async function steuereBildschirm(id: unknown, aktion: unknown, opts: { by: string; text?: unknown }, deps: BildschirmDeps = {}): Promise<BildschirmAntwort> {
    const key = String(id ?? '')
    if (!ID.test(key)) return { ok: false, message: 'Unbekannter Bildschirm.' }
    if (!['uebernehmen', 'zurueckgeben', 'stoppen', 'ziel'].includes(String(aktion))) return { ok: false, message: 'Unbekannter Knopf.' }
    const d = produktion(deps)
    const { bildschirme } = await listeBildschirme(deps)
    const screen = bildschirme.find(item => item.id === key)
    if (!screen && aktion !== 'zurueckgeben') return { ok: false, message: 'Diesen Bildschirm sehe ich gerade nicht.' }
    const name = screen?.name || halte.get(key)?.name || key.slice(key.indexOf(':') + 1)
    const by = clean(opts.by, 80) || 'owner'
    if (aktion === 'uebernehmen') {
        halten(key, name, 'uebernommen')
        const was = screen?.eingabeErlaubt ? 'Du kannst jetzt selbst klicken und tippen.' : screen?.linkSteuern ? 'Zum Bedienen öffnet sich das eigene Fenster.' : 'Eingaben von hier sind auf diesem Rechner nicht freigegeben – du schaust zu.'
        return { ok: true, message: `Übernommen: Ich nehme sofort die Hände von Maus und Tastatur und schaue nur zu. ${was} „Zurückgeben“, wenn ich weitermachen darf.` }
    }
    if (aktion === 'zurueckgeben') {
        const hold = halte.get(key)
        if (!hold) return { ok: true, message: 'Ich arbeite hier schon wieder selbst.' }
        hold.release()
        halte.delete(key)
        return { ok: true, message: 'Danke – ich darf hier wieder weiterarbeiten.' }
    }
    if (aktion === 'ziel') {
        const text = clean(opts.text, 500)
        if (text.length < 2) return { ok: false, message: 'Schreib kurz, was ich stattdessen tun soll.' }
        const done = await d.gedanke({ title: clean(`Anderes Ziel auf ${name}`, 150), evidence: `Owner gibt ein anderes Ziel für ${name}: „${text}“`, proposal: text, node: name }).catch(() => false)
        return done ? { ok: true, message: `Gut, neues Ziel ist in meiner Planung: „${text}“.` } : { ok: false, message: 'Ich konnte es gerade nicht in meine Planung schreiben.' }
    }
    // stoppen: Hände weg + laufende Aktivitäten auf diesem Node anhalten.
    halten(key, name, 'gestoppt')
    let eintraege: Aktivitaet[] = []
    try { eintraege = await d.aktivitaet() } catch { /* halt bleibt trotzdem */ }
    const node = key.startsWith('node:') ? key.slice(5) : ''
    const ziel = eintraege.filter(item => item.jetzt && item.aktionen.includes('stopp') && (item.node === node || (screen?.lokal && ['main', 'local', 'lokal'].includes(item.node))))
    const gestoppt: string[] = []
    for (const item of ziel.slice(0, 10)) {
        try { if ((await d.stoppeAktivitaet(item.id, by)).ok) gestoppt.push(item.titel) } catch { /* nächster */ }
    }
    return { ok: true, message: `Gestoppt: Ich fasse ${name} nicht mehr an${gestoppt.length ? ` und habe angehalten: ${gestoppt.slice(0, 3).join(', ')}` : ''}. „Zurückgeben“, wenn ich wieder darf.` }
}

/** Owner bedient selbst (nur nach „Übernehmen“, nur wo Eingaben schon erlaubt sind). */
export async function bildschirmEingabe(id: unknown, action: unknown, deps: BildschirmDeps = {}): Promise<BildschirmAntwort> {
    const key = String(id ?? '')
    if (!ID.test(key)) return { ok: false, message: 'Unbekannter Bildschirm.' }
    const d = produktion(deps)
    if (halte.get(key)?.art !== 'uebernommen') return { ok: false, message: 'Erst „Übernehmen“ drücken.' }
    const { bildschirme } = await listeBildschirme(deps)
    const screen = bildschirme.find(item => item.id === key)
    if (!screen?.eingabeErlaubt) return { ok: false, message: 'Eingaben von hier sind auf diesem Rechner nicht freigegeben.' }
    try {
        const { desktopInputArgs } = await import('../host/desktop-input.js')
        desktopInputArgs(action)
    } catch { return { ok: false, message: 'Diese Eingabe geht nicht.' } }
    try {
        await d.eingabe(action)
        letztesBild.delete(key)
        return { ok: true, message: 'ok' }
    } catch (error) {
        const mapped = zustandAus(error)
        return { ok: false, message: mapped.zustand === 'gesperrt' ? mapped.message : 'Die Eingabe kam nicht sicher an – ich wiederhole sie nicht von selbst.' }
    }
}

/** Telegram-Kurzliste. */
export function bildschirmeText(liste: Awaited<ReturnType<typeof listeBildschirme>>): string {
    const lines = ['🖥 Ihr Computer']
    if (!liste.bildschirme.length) lines.push('', 'Gerade sehe ich keinen Bildschirm, auf dem ich arbeiten kann.')
    for (const screen of liste.bildschirme) {
        lines.push(`• ${screen.name} – ${screen.uebernommen ? 'du hast übernommen' : screen.gestoppt ? 'gestoppt' : screen.zustandText}${screen.tut ? ` · ${screen.tut}` : ''}`)
    }
    if (liste.agentPausiert) lines.push('', 'Meine Maus/Tastatur ist gerade pausiert.')
    lines.push('', 'Live zusehen und übernehmen geht in der App unter „Ihr Computer“.')
    return lines.join('\n')
}
