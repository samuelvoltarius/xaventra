/**
 * 2.88 Paket „Verbinden ohne Technik“ — the model-facing tools.
 *
 *   dienst_finden            read: checked catalog first, then the cached MCP directory (own check per entry)
 *   dienst_verbinden         ONE card „X verbinden?“ (connect-flow.ts); nothing connects before the Ja
 *   zugaenge_liste           read: vault entry ids + released services — never a value
 *   zugang_freigabe_anfragen ONE card: release an entry for one more service
 *   anmelden_mit_zugang      fills the login form of the open page from the vault; returns no value
 *   proxmox_vm               read (status/snapshots) or ONE card (start/shutdown/snapshot/rollback)
 *
 * All owner only. Changing a password has no tool (Nie-Liste „Zugangsdaten ändern“).
 */
import type { NovaTool } from './complete-registry.js'

async function requireOwner(): Promise<void> {
    const { getExecutionPolicyContext } = await import('../core/lifecycle-policy.js')
    const { getUserPermission } = await import('../users/multi-user-middleware.js')
    const ctx = getExecutionPolicyContext()
    if (!ctx.authUserId || getUserPermission(ctx.authUserId, ctx.channel) !== 'owner') throw new Error('Nur für den authentifizierten Owner.')
}

const PASSWORT_AENDERN = /passw(?:o|ö)rt\w*\s+(?:aendern|ändern|wechseln|zurücksetzen|zuruecksetzen|neu setzen)|change\s+password|reset\s+password/i

export const dienstFindenTool: NovaTool = {
    name: 'dienst_finden', category: 'other',
    description: 'Sucht Dienste zum Verbinden, passend zum Wunsch des Owners („verbinde dich mit meinem Wetterdienst“): zuerst geprüfter Katalog, dann das offizielle MCP-Verzeichnis (zwischengespeichert, offline nutzbar). Jeder Treffer mit Kurzsatz und Prüfstufe (geprüft / nicht geprüft = zuerst nur lesend / unbekannt = jedes Werkzeug fragt). Verbindet nichts.',
    parameters: [{ name: 'wunsch', type: 'string', required: true, description: 'Was verbunden werden soll, in einfachen Worten (z. B. „Jellyfin“, „Notizen“).' }],
    handler: async (params) => {
        await requireOwner()
        const { vorschlaegeFuer } = await import('../connections/registry-vetting.js')
        const treffer = vorschlaegeFuer(String(params.wunsch || ''), { limit: 6 })
        if (!treffer.length) return { success: true, treffer: [], hinweis: 'Nichts Passendes gefunden (Katalog und zwischengespeichertes Verzeichnis).' }
        return {
            success: true,
            treffer: treffer.map(item => ({
                dienst: item.connectorId, name: item.title, satz: item.satz.slice(0, 160), stufe: item.stufe, verbindbar: item.verbindbar,
                ...(item.pruefung ? { gruende: item.pruefung.gruende.slice(0, 4), version: item.pruefung.version, netz: item.pruefung.netz } : {}),
            })),
            hinweis: 'Zum Verbinden dienst_verbinden mit „dienst“ aufrufen — es kommt eine Karte, ohne Ja passiert nichts.',
        }
    },
}

export const dienstVerbindenTool: NovaTool = {
    name: 'dienst_verbinden', category: 'other',
    description: 'Legt EINE Karte „X verbinden?“ für einen Dienst aus dienst_finden an. Verbunden wird erst nach dem Ja des Owners; nicht geprüfte Dienste zuerst nur lesend, unbekannte fragen bei jedem Werkzeug. Pakete aus dem Verzeichnis werden nie installiert.',
    parameters: [{ name: 'dienst', type: 'string', required: true, description: 'Der Wert „dienst“ aus dienst_finden (z. B. github oder io.github.beispiel/wetter).' }],
    handler: async (params) => {
        await requireOwner()
        const { requestConnect } = await import('../connections/connect-flow.js')
        const result = await requestConnect({ connectorId: String(params.dienst || '').slice(0, 120), quelle: 'gespraech' })
        return result.ok ? { success: true, message: result.message, cardId: result.card.id } : { success: false, error: result.message }
    },
}

export const zugaengeListeTool: NovaTool = {
    name: 'zugaenge_liste', category: 'security',
    description: 'Zeigt die Einträge im Passwort-Tresor als Kurznamen (credential_id, z. B. „github-main“) mit den Diensten, für die der Owner sie freigegeben hat. Zeigt nie ein Passwort oder Token.',
    parameters: [],
    handler: async () => {
        await requireOwner()
        const { zugaengeSicht } = await import('../secrets/credential-broker.js')
        return { success: true, zugaenge: zugaengeSicht().map(item => ({ credential_id: item.id, name: item.label, dienste: item.dienste })) }
    },
}

export const zugangFreigabeTool: NovaTool = {
    name: 'zugang_freigabe_anfragen', category: 'security',
    description: 'Fragt den Owner per Karte, ob ein Tresor-Eintrag auch für einen weiteren Dienst eingesetzt werden darf. Ändert nichts vor dem Ja. Passwörter ändern macht nur der Owner selbst.',
    parameters: [
        { name: 'credential_id', type: 'string', required: true, description: 'Kurzname aus zugaenge_liste.' },
        { name: 'dienst', type: 'string', required: true, description: 'Adresse des Dienstes (z. B. https://example.com).' },
    ],
    handler: async (params) => {
        await requireOwner()
        const { freigabeAnfragen } = await import('../secrets/tresor-cards.js')
        const result = await freigabeAnfragen(String(params.credential_id || ''), String(params.dienst || ''))
        return result.ok ? { success: true, message: result.message } : { success: false, error: result.message }
    },
}

export const anmeldenMitZugangTool: NovaTool = {
    name: 'anmelden_mit_zugang', category: 'browser',
    description: 'Füllt auf der gerade offenen Anmeldeseite im Browser Benutzername und Passwort aus dem Tresor aus (credential_id aus zugaenge_liste). Das Passwort sieht dabei niemand; die Seite muss für diesen Eintrag freigegeben sein (sonst zugang_freigabe_anfragen). Danach selbst auf „Anmelden“ klicken.',
    parameters: [
        { name: 'credential_id', type: 'string', required: true, description: 'Kurzname aus zugaenge_liste.' },
        { name: 'requestText', type: 'string', description: 'Der aktuelle Owner-Auftrag (zur Prüfung).' },
    ],
    handler: async (params) => {
        await requireOwner()
        const { PASSWORT_AENDERN_TEXT, fuelleLogin } = await import('../secrets/credential-broker.js')
        if (PASSWORT_AENDERN.test(String(params.requestText || ''))) return { success: false, error: PASSWORT_AENDERN_TEXT }
        const { getBrowser } = await import('./browser.js')
        const result = await fuelleLogin(String(params.credential_id || ''), getBrowser())
        if (result.ok === false) return { success: false, error: result.meldung, ...(result.grund === 'freigabe-fehlt' ? { naechsterSchritt: 'zugang_freigabe_anfragen' } : {}) }
        return { success: true, ausgefuellt: { benutzer: result.ergebnis.benutzer, passwort: true }, dienst: result.ergebnis.dienst }
    },
}

export const proxmoxVmTool: NovaTool = {
    name: 'proxmox_vm', category: 'system',
    description: 'Proxmox im Gespräch: „status“ und „snapshots“ lesen; „starten“, „herunterfahren“ (sauber), „snapshot“ und „zuruecksetzen“ legen EINE Karte an — ausgeführt wird erst nach dem Ja, nur für VMs im Pool xaventra. Hart stoppen, Snapshots löschen, Migration gibt es nie.',
    parameters: [
        { name: 'aktion', type: 'string', required: true, description: 'status | snapshots | starten | herunterfahren | snapshot | zuruecksetzen' },
        { name: 'vm', type: 'string', description: 'Name oder Nummer der VM, wie der Owner sie nennt (z. B. „Test-VM“ oder 150).' },
        { name: 'snapshot', type: 'string', description: 'Bei snapshot: Anlass in Worten („vor dem Update“); bei zuruecksetzen: genauer Snapshot-Name.' },
        { name: 'requestText', type: 'string', description: 'Der aktuelle Owner-Auftrag (zur Prüfung).' },
    ],
    handler: async (params) => {
        await requireOwner()
        const { proxmoxImGespraech } = await import('../infra/proxmox-chat.js')
        const result = await proxmoxImGespraech({ aktion: params.aktion, vm: params.vm, snapshot: params.snapshot, text: params.requestText })
        return result.ok ? { success: true, message: result.text, ...(result.cardId ? { cardId: result.cardId } : {}) } : { success: false, error: result.text }
    },
}

export const verbindenTools: NovaTool[] = [dienstFindenTool, dienstVerbindenTool, zugaengeListeTool, zugangFreigabeTool, anmeldenMitZugangTool, proxmoxVmTool]
