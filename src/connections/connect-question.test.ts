import { describe, expect, it } from 'vitest'
import { answerConnectQuestion, connectQuestionTarget, connectQuestionZiel, type ConnectQuestionDeps } from './connect-question.js'
import type { Verbindungsstand } from './connection-state.js'

// 2.88.2 (live 07.10.2026): "searxng kannst du dich mit dem verbinen ?" — SearXNG was
// listed as connected under Verbindungen, yet she asked the owner for a URL.
// 2.89: the answer comes from the one connection truth (connector / device kind + state),
// never from a title substring — a „wartet auf Anmeldung“ entry is not „schon verbunden“.

const stand = (zustand: Verbindungsstand['zustand'], grund = ''): Verbindungsstand => ({ zustand, grund })
const deps = (over: Partial<ConnectQuestionDeps> = {}): ConnectQuestionDeps => ({
    connectors: [{ name: 'home-assistant', title: 'Home Assistant' }, { name: 'n8n', title: 'n8n' }, { name: 'gmail', title: 'Gmail' }],
    connector: id => id === 'home-assistant' ? stand('verbunden', 'bei Home Assistant angemeldet') : id === 'n8n' ? stand('wartet', 'Zugang fehlt noch') : stand('gefunden', 'nicht verbunden'),
    geraete: art => art === 'tuya' ? [{ titel: 'Tuya-Gerät', stand: stand('wartet', 'Code aus der Tuya-App fehlt noch') }] : art === 'hue' ? [{ titel: 'Hue Bridge', stand: stand('gefunden') }] : [],
    quellen: () => [{ title: 'SearXNG auf diesem Rechner', verbunden: true }],
    ...over,
})

describe('"Kannst du dich mit X verbinden?" answers from the one connection truth', () => {
    it.each([
        ['searxng kannst du dich mit dem verbinen ?', 'searxng'],
        ['Kannst du dich mit Home Assistant verbinden?', 'home assistant'],
        ['verbinde dich mit searxng', 'searxng'],
    ])('reads the target from %s', (text, target) => {
        expect(connectQuestionTarget(text)).toBe(target)
    })
    it('resolves connector or device kind, not a title substring', () => {
        const { connectors } = deps()
        expect(connectQuestionZiel('home assistant', connectors)).toEqual({ connectorId: 'home-assistant', title: 'Home Assistant' })
        expect(connectQuestionZiel('hue', connectors)).toEqual({ art: 'hue' })
        expect(connectQuestionZiel('tuya geräte', connectors)).toEqual({ art: 'tuya' })
        expect(connectQuestionZiel('spotify', connectors)).toBeNull()
    })
    it('already connected → says so at once', () => {
        expect(answerConnectQuestion('Kannst du dich mit Home Assistant verbinden?', deps())).toBe('Ja — Home Assistant ist schon verbunden. Ich nutze es schon.')
        expect(answerConnectQuestion('searxng kannst du dich mit dem verbinen ?', deps())).toMatch(/^Ja — SearXNG auf diesem Rechner ist schon verbunden/)
    })
    it('begun but waiting → names the missing step (never „schon verbunden“)', () => {
        expect(answerConnectQuestion('Kannst du dich mit n8n verbinden?', deps())).toBe('n8n ist angefangen, aber noch nicht fertig: Zugang fehlt noch. Unter „Verbindungen“ geht es mit einem Knopf weiter.')
        expect(answerConnectQuestion('Kannst du dich mit Tuya verbinden?', deps())).toMatch(/^Tuya-Gerät ist angefangen, aber noch nicht fertig: Code aus der Tuya-App/)
        const waitingHa = deps({ connector: () => stand('wartet', 'Anmeldung fehlt noch') })
        expect(answerConnectQuestion('Kannst du dich mit Home Assistant verbinden?', waitingHa)).not.toMatch(/schon verbunden/)
    })
    it('found but not connected, or unknown → normal path (Gegenprobe)', () => {
        expect(answerConnectQuestion('Kannst du dich mit Hue verbinden?', deps())).toBeNull()
        expect(answerConnectQuestion('Kannst du dich mit Gmail verbinden?', deps())).toBeNull()
        expect(answerConnectQuestion('Kannst du dich mit Spotify verbinden?', deps())).toBeNull()
        expect(answerConnectQuestion('Wie wird das Wetter?', deps())).toBeNull()
    })
})

describe('2.89: "Ist X verbunden?" is answered from the same truth — yes and no', () => {
    it.each([
        ['Ist Home Assistant verbunden?', 'home assistant'],
        ['ist mein home assistant schon verbunden', 'home assistant'],
        ['Bist du mit Gmail verbunden?', 'gmail'],
        ['Ist die Hue Bridge eingerichtet?', 'hue bridge'],
    ])('reads the status target from %s', (text, target) => {
        expect(connectQuestionTarget(text)).toBe(target)
    })
    it('connected / waiting / not connected — never a model guess', () => {
        expect(answerConnectQuestion('Ist Home Assistant verbunden?', deps())).toBe('Ja — Home Assistant ist verbunden.')
        expect(answerConnectQuestion('Ist n8n verbunden?', deps())).toMatch(/^n8n ist angefangen, aber noch nicht fertig: Zugang fehlt noch/)
        expect(answerConnectQuestion('Bist du mit Gmail verbunden?', deps())).toMatch(/^Nein — Gmail ist noch nicht verbunden\./)
        expect(answerConnectQuestion('Ist die Hue Bridge verbunden?', deps())).toMatch(/^Nein — Hue Bridge ist noch nicht verbunden\./)
        expect(answerConnectQuestion('Ist SearXNG verbunden?', deps())).toMatch(/^Ja — SearXNG auf diesem Rechner ist schon verbunden/)
    })
    it('unknown target or no device of that kind → normal path (Gegenprobe)', () => {
        expect(answerConnectQuestion('Ist Spotify verbunden?', deps())).toBeNull()
        expect(answerConnectQuestion('Ist der Drucker verbunden?', deps())).toBeNull()
        expect(answerConnectQuestion('Ist das Kabel richtig verbunden mit dem Router?', deps())).toBeNull()
    })
})
