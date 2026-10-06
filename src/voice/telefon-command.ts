/**
 * 2.87 Paket P: `/telefon` — derselbe Telefon-Zugang wie in der App, als
 * Telegram-Dialog (nur Owner, Rollen-Standard der Befehle).
 *
 *   /telefon                       Stand in Alltagssprache
 *   /telefon einrichten            die drei Schritte (Server, Login, Passwort)
 *   /telefon server sip.zadarma.com
 *   /telefon login 100100
 *   /telefon passwort …            (wird nicht protokolliert; Nachricht danach löschen)
 *   /telefon rufnummer +43 …       eigene Nummer beim Anbieter (für Anrufe von außen)
 *   /telefon owner +43 …           Owner-Nummer dazu  ·  /telefon owner weg +43 …
 *   /telefon an | aus · /telefon weg direkt|asterisk · /telefon pruefen
 *   /telefon anrufen +43 …         Owner-Nummer direkt, sonst Karte
 *   /telefon vorlage · /telefon loeschen
 */
import {
    asteriskVorlage, normalizeNumber, readTelefonConfig, saveTelefonEingabe, telefonOeffentlich, telefonZuruecksetzen,
    type TelefonEingabe, type TelefonStoreOptions,
} from './telefon-config.js'

export interface TelefonCommandDeps {
    store?: TelefonStoreOptions
    apply?: () => Promise<boolean>
    pruefen?: () => Promise<{ ok: boolean; text: string }>
    anrufen?: (nummer: string) => Promise<string>
    lauscht?: () => boolean
}

const SENSITIVE = /^\/telefon\s+(?:passwort|ari-passwort)\b/i
/** Für die Pipeline: diese Nachricht nie protokollieren. */
export function isSensitiveTelefonCommand(text: string): boolean { return SENSITIVE.test(String(text || '').trim()) }

export function telefonStandText(store: TelefonStoreOptions = {}, lauscht = false): string {
    const view = telefonOeffentlich(store)
    if (!view.eingerichtet && !view.ownerNummern.length) {
        return ['📞 Telefon ist noch nicht eingerichtet.', '', 'So geht es (drei Angaben von deinem Telefonanbieter):', '/telefon server sip.zadarma.com', '/telefon login <deine SIP-Kennung>', '/telefon passwort <dein SIP-Passwort>', '', 'Danach: /telefon owner +43 … (wer mich anrufen darf) und /telefon pruefen.'].join('\n')
    }
    const lines = [`📞 Telefon ${view.aktiv ? 'eingeschaltet' : 'ausgeschaltet'} · Weg: ${view.weg === 'asterisk' ? 'über deine Telefonanlage' : 'direkt'}`]
    if (view.sip.server) lines.push(`Anbieter: ${view.sip.anbieter || view.sip.server} (${view.sip.transport.toUpperCase()} ${view.sip.port}), Login ${view.sip.login || '—'}, Passwort ${view.passwortGespeichert ? 'gespeichert' : 'fehlt'}`)
    if (view.sip.rufnummer) lines.push(`Eigene Nummer: ${view.sip.rufnummer}`)
    lines.push(`Owner-Nummern: ${view.ownerNummern.length ? view.ownerNummern.join(', ') : 'noch keine'}`)
    if (view.pruefung) lines.push(`Letzte Prüfung: ${view.pruefung.text}`)
    lines.push(lauscht ? 'Ich nehme gerade Anrufe über die Telefonanlage an.' : 'Ich nehme gerade keine Anrufe an.')
    if (view.hinweise.length) lines.push('', ...view.hinweise.map(item => `• ${item}`))
    return lines.join('\n')
}

export async function handleTelefonCommand(args: string, deps: TelefonCommandDeps = {}): Promise<string> {
    const store = deps.store || {}
    const apply = deps.apply || (async () => (await import('./telefon-runtime.js')).applyTelefonConfig())
    const lauscht = deps.lauscht || (() => false)
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean)
    const sub = (parts[0] || 'status').toLowerCase()
    const rest = parts.slice(1).join(' ')
    const save = async (input: TelefonEingabe, done: string): Promise<string> => {
        const result = saveTelefonEingabe(input, store)
        if (!result.ok) return `❌ ${(result as { meldung: string }).meldung}`
        await apply().catch(() => false)
        return done
    }
    switch (sub) {
        case 'status': case 'stand': return telefonStandText(store, lauscht())
        case 'einrichten': case 'hilfe': return ['Drei Angaben reichen:', '/telefon server sip.zadarma.com', '/telefon login <SIP-Kennung>', '/telefon passwort <SIP-Passwort>', 'Optional: /telefon rufnummer +43 … · /telefon owner +43 …', 'Dann: /telefon pruefen'].join('\n')
        case 'server': return save({ server: rest }, `Gespeichert: Server ${rest.toLowerCase()}.`)
        case 'login': return save({ login: rest }, 'Gespeichert: Login.')
        case 'passwort': {
            if (!rest) return 'Bitte so: /telefon passwort <dein SIP-Passwort>'
            const answer = await save({ passwort: rest }, 'Passwort sicher gespeichert. Bitte lösch deine Nachricht mit dem Passwort hier im Chat. Prüfen: /telefon pruefen')
            return answer
        }
        case 'rufnummer': return save({ rufnummer: rest }, rest ? `Gespeichert: eigene Nummer ${normalizeNumber(rest)}.` : 'Eigene Nummer entfernt.')
        case 'name': case 'anzeigename': return save({ anzeigename: rest }, 'Gespeichert: Anzeigename.')
        case 'owner': {
            const current = readTelefonConfig(store).ownerNummern
            if (/^(?:weg|entfernen|loeschen|löschen)\b/i.test(rest)) {
                const number = normalizeNumber(rest.replace(/^\S+\s*/, ''))
                return save({ ownerNummern: current.filter(item => normalizeNumber(item) !== number) }, `Entfernt: ${number}.`)
            }
            if (!rest) return `Owner-Nummern: ${current.length ? current.join(', ') : 'noch keine'}. Dazu: /telefon owner +43 …`
            return save({ ownerNummern: [...current, rest] }, `Gespeichert: ${normalizeNumber(rest)} darf mich anrufen.`)
        }
        case 'an': case 'ein': return save({ aktiv: true }, 'Telefon eingeschaltet.')
        case 'aus': return save({ aktiv: false }, 'Telefon ausgeschaltet — ich nehme keine Anrufe an und rufe niemanden an.')
        case 'weg': {
            const weg = /^asterisk|anlage/i.test(rest) ? 'asterisk' : /^direkt/i.test(rest) ? 'direkt' : null
            if (!weg) return 'Bitte so: /telefon weg direkt  oder  /telefon weg asterisk'
            return save({ weg }, weg === 'asterisk' ? 'Weg: über deine Telefonanlage. Die Vorlage für die Anlage: /telefon vorlage' : 'Weg: direkt.')
        }
        case 'pruefen': case 'prüfen': case 'test': {
            const run = deps.pruefen || (async () => (await import('../desktop/telefon-api.js')).pruefeTelefon(store))
            return (await run()).text
        }
        case 'anrufen': {
            if (!rest) return 'Bitte so: /telefon anrufen +43 …'
            const run = deps.anrufen || (async (nummer: string) => (await import('./telefon-ausgang.js')).anrufen(nummer))
            return run(rest)
        }
        case 'vorlage': return asteriskVorlage(readTelefonConfig(store))
        case 'loeschen': case 'löschen': {
            telefonZuruecksetzen(store)
            await apply().catch(() => false)
            return 'Telefon-Zugang gelöscht (auch das Passwort). Ich nehme keine Anrufe mehr an.'
        }
        default: return 'Unbekannt. /telefon [einrichten|server|login|passwort|rufnummer|owner|an|aus|weg|pruefen|anrufen|vorlage|loeschen]'
    }
}
