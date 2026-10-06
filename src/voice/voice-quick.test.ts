import { describe, expect, it, vi } from 'vitest'
import { createVoiceAnswerer, quickVoiceAnswer, type VoiceCardView, type VoiceQuickDeps } from './voice-quick.js'

// 2.87 Paket P: einfache Sprachfragen ohne große Modellrunde; ein gesprochenes
// „ja“ gilt nur im authentifizierten Owner-Anruf und nur für genau diese Karte.

const NOW = new Date('2026-10-06T08:30:00Z')

function deps(over: Partial<VoiceQuickDeps> = {}): VoiceQuickDeps {
    return { now: () => NOW, timeZone: 'Europe/Vienna', openCards: () => [], answerCard: vi.fn(async () => ({ ok: true, message: 'Ja: Stehlampe ist an.' })), ...over }
}

describe('quickVoiceAnswer', () => {
    it('Uhrzeit und Datum ohne Modell', async () => {
        expect(await quickVoiceAnswer('Wie spät ist es?', deps())).toBe('Es ist 10:30 Uhr.')
        expect(await quickVoiceAnswer('wieviel uhr haben wir', deps())).toBe('Es ist 10:30 Uhr.')
        expect(await quickVoiceAnswer('Welcher Tag ist heute?', deps())).toBe('Heute ist Dienstag, der 6. Oktober 2026.')
    })
    it('„läuft alles?“ nutzt die kurze Statusquelle', async () => {
        const status = vi.fn(async () => 'Ja, ich laufe. 2 von 2 Rechnern sind erreichbar.')
        expect(await quickVoiceAnswer('Läuft alles?', deps({ status }))).toBe('Ja, ich laufe. 2 von 2 Rechnern sind erreichbar.')
        expect(status).toHaveBeenCalledOnce()
    })
    it('Wetter nur mit vorhandenem Werkzeug, sonst normale Pipeline', async () => {
        expect(await quickVoiceAnswer('Wie wird das Wetter?', deps())).toBeNull()
        expect(await quickVoiceAnswer('Wie ist das Wetter', deps({ weather: async () => 'In Salzburg 14 Grad, bewölkt.' }))).toBe('In Salzburg 14 Grad, bewölkt.')
        expect(await quickVoiceAnswer('Wie wird das Wetter?', deps({ weather: async () => null }))).toBeNull()
    })
    it('alles andere geht an die Pipeline', async () => {
        expect(await quickVoiceAnswer('Erzähl mir was über Salzburg', deps())).toBeNull()
        expect(await quickVoiceAnswer('Wie spät ist es in Tokio und warum?', deps())).toBeNull()
    })
})

const lampCard: VoiceCardView = { id: 'card-1', status: 'offen', art: 'geraet-schalten', titel: 'Stehlampe einschalten?', vorschlag: 'Stehlampe einschalten — nur genau das.', aktion: { kind: 'geraet-schalten', ref: 'p-1' }, expiresAt: '2026-10-06T09:30:00Z' }

describe('createVoiceAnswerer — Gerät schalten per Sprache', () => {
    function setup(ownerAuthenticated: boolean, cards: { list: VoiceCardView[] }) {
        const answerCard = vi.fn(async () => ({ ok: true, message: 'Ja: Stehlampe ist an.' }))
        const pipeline = vi.fn(async (text: string) => {
            if (/stehlampe/i.test(text)) { cards.list = [lampCard]; return 'Ich schalte die Stehlampe ein. Bitte auf der Karte Ja oder Nein.' }
            return 'Pipeline: ' + text
        })
        const answer = createVoiceAnswerer({ pipeline, ownerAuthenticated, quick: deps({ openCards: () => cards.list, answerCard }) })
        return { answer, pipeline, answerCard }
    }
    const signal = new AbortController().signal

    it('Owner-Anruf: Vorschau → gesprochene Rückfrage → „ja“ beantwortet genau diese Karte', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const { answer, answerCard, pipeline } = setup(true, cards)
        expect(await answer('Mach die Stehlampe an', signal)).toBe('Ich schalte die Stehlampe ein. Soll ich das machen? Sag ja.')
        expect(await answer('Ja.', signal)).toBe('Ja: Stehlampe ist an.')
        expect(answerCard).toHaveBeenCalledWith('card-1', 'ja')
        expect(pipeline).toHaveBeenCalledTimes(1)
        // Ein zweites „ja“ hat keine Karte mehr.
        expect(await answer('ja', signal)).toBe('Pipeline: ja')
    })

    it('Telefon (nicht authentifiziert): „ja“ ist keine Freigabe, Karte bleibt in App/Telegram', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const { answer, answerCard } = setup(false, cards)
        expect(await answer('Mach die Stehlampe an', signal)).toBe('Ich schalte die Stehlampe ein. Die Karte zum Bestätigen liegt in der App und in Telegram.')
        expect(await answer('ja', signal)).toContain('gilt am Telefon nicht als Freigabe')
        expect(answerCard).not.toHaveBeenCalled()
    })

    it('hat sich die Karte geändert, zählt das „ja“ nicht', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const { answer, answerCard } = setup(true, cards)
        await answer('Mach die Stehlampe an', signal)
        cards.list = [{ ...lampCard, vorschlag: 'Alle Lampen einschalten.' }]
        expect(await answer('ja', signal)).toContain('hat sich geändert')
        expect(answerCard).not.toHaveBeenCalled()
    })

    it('abgelaufene oder schon beantwortete Karte: kein Schalten', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const { answer, answerCard } = setup(true, cards)
        await answer('Mach die Stehlampe an', signal)
        cards.list = [{ ...lampCard, status: 'ja' }]
        expect(await answer('ja', signal)).toContain('schon beantwortet')
        expect(answerCard).not.toHaveBeenCalled()
    })

    it('mehrere neue Karten (Rückfrage mit Auswahl): kein gesprochenes Ja', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const answerCard = vi.fn()
        const answer = createVoiceAnswerer({
            ownerAuthenticated: true,
            pipeline: async () => { cards.list = [lampCard, { ...lampCard, id: 'card-2' }]; return 'Welches Licht meinst du? Ich habe dir die Knöpfe geschickt.' },
            quick: deps({ openCards: () => cards.list, answerCard: answerCard as any }),
        })
        expect(await answer('Licht an', signal)).toBe('Welches Licht meinst du? Ich habe dir die Knöpfe geschickt.')
        await answer('ja', signal)
        expect(answerCard).not.toHaveBeenCalled()
    })

    it('„nein“ lehnt genau diese Karte ab', async () => {
        const cards = { list: [] as VoiceCardView[] }
        const { answer, answerCard } = setup(true, cards)
        await answer('Mach die Stehlampe an', signal)
        await answer('Nein danke', signal)
        expect(answerCard).toHaveBeenCalledWith('card-1', 'nein')
    })

    it('reicht den Strom an die Pipeline weiter (Kurzantworten brauchen keinen)', async () => {
        const pipeline = vi.fn(async (_text: string, _signal: AbortSignal, stream?: any) => { stream?.onTextDelta('x'); return 'x' })
        const answer = createVoiceAnswerer({ pipeline, ownerAuthenticated: true, quick: deps() })
        const stream = { onTextDelta: vi.fn(), onToolRound: vi.fn() }
        await answer('Erzähl was', signal, stream)
        expect(stream.onTextDelta).toHaveBeenCalledWith('x')
        expect(await answer('wie spät ist es', signal, stream)).toBe('Es ist 10:30 Uhr.')
        expect(pipeline).toHaveBeenCalledTimes(1)
    })
})
