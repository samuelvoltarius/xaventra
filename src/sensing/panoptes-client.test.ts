import { describe, expect, it, vi } from 'vitest'
import { assertPanoptesPfad, holeStandbild, lauscheEreignisse, parseEreignis, PanoptesPfadVerweigert, pollKopplung, starteKopplung, erneuereSitzung } from './panoptes-client.js'

// Panoptes-Vertrag (SICHERHEIT_0130_STAND, „Für Xaventra“): Kopplung Art `dienst`, SSE-Ereignisse,
// ein Standbild je ereignisId. Harte Client-Erlaubnisliste; keine Clips, keine Fahrzeug-Endpunkte.
const BASE = 'http://100.64.1.2:8080'
const JPEG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(32)])
const ID = 'a'.repeat(32)
const ANFRAGE = 'd'.repeat(32)
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Erlaubnisliste', () => {
    it.each([
        ['POST', '/auth/kopplung/anfrage'], ['GET', `/auth/kopplung/anfrage/${ANFRAGE}`], ['GET', '/api/ha/v1/ereignisse'],
        ['GET', `/api/waechter/standbild/${ID}`], ['GET', '/api/surveillance/status'], ['POST', '/api/sitzung/erneuern'], ['POST', '/api/sitzung/abmelden'],
    ])('erlaubt %s %s', (method, path) => expect(() => assertPanoptesPfad(method, path)).not.toThrow())
    it.each([
        ['GET', '/video/a.mp4'], ['GET', '/api/recordings'], ['GET', '/thumb/a.jpg?t=x'], ['GET', '/snapshot/1'], ['GET', '/ws'], ['GET', '/h264/1'], ['GET', '/api/stream'],
        ['POST', '/api/ha/v1/aktion'], ['POST', '/api/handy/v1/aktion'], ['GET', '/api/ha/v1/zustand'], ['GET', '/api/kopplungen'], ['GET', '/api/ereignisclip/1'],
        ['DELETE', '/api/sitzung/abmelden'], ['GET', '/auth/kopplung/anfrage/kurz'], ['GET', '/api/waechter/standbild/kurz'], ['GET', `/api/waechter/standbild/${ID}/../../video`], ['GET', '/api/ha/v1/ereignisse?position=1'],
    ])('verweigert %s %s', (method, path) => expect(() => assertPanoptesPfad(method, path)).toThrow(PanoptesPfadVerweigert))
    it('ein verbotener Pfad erreicht das Netz nie', async () => {
        const fetchFn = vi.fn()
        await expect(holeStandbild(BASE, 'jwt', '../../video', { fetchFn: fetchFn as any })).rejects.toBeInstanceOf(PanoptesPfadVerweigert)
        expect(fetchFn).not.toHaveBeenCalled()
    })
})

describe('Kopplung Art dienst', () => {
    it('fragt mit Prüfzahl an, der Besitzer erlaubt am Auto, der JWT kommt zurück', async () => {
        const fetchFn = vi.fn(async (url: any, init: any = {}) => {
            if (String(url).endsWith('/auth/kopplung/anfrage')) { expect(JSON.parse(init.body)).toEqual({ geraet: 'Xaventra', pruefzahl: '1234', art: 'dienst' }); return json({ ok: true, id: ANFRAGE, abfrageAlleMs: 1 }) }
            return fetchFn.mock.calls.length < 3 ? json({ status: 'wartet' }) : json({ status: 'erlaubt', jwt: 'kopplungs-jwt', kopplungId: 'kid-1' })
        })
        const start = await starteKopplung(BASE, '1234', { fetchFn: fetchFn as any })
        expect(start).toEqual({ id: ANFRAGE, abfrageAlleMs: 1 })
        expect(await pollKopplung(BASE, start, { fetchFn: fetchFn as any, sleep: async () => undefined, maxMs: 1000 })).toEqual({ status: 'erlaubt', jwt: 'kopplungs-jwt', kopplungId: 'kid-1' })
    })
    it.each(['abgelehnt', 'abgelaufen', 'abgeholt'])('Zustand %s endet ohne zweiten Versuch', async status => {
        const fetchFn = vi.fn(async () => json({ status }))
        expect(await pollKopplung(BASE, { id: ANFRAGE, abfrageAlleMs: 1 }, { fetchFn: fetchFn as any, sleep: async () => undefined, maxMs: 1000 })).toEqual({ status })
        expect(fetchFn).toHaveBeenCalledOnce()
    })
    it('404 unbekannt endet ebenso; ein Netzfehler beim Abfragen fragt weiter', async () => {
        const gone = vi.fn(async () => json({ status: 'unbekannt' }, 404))
        expect(await pollKopplung(BASE, { id: ANFRAGE, abfrageAlleMs: 1 }, { fetchFn: gone as any, sleep: async () => undefined, maxMs: 1000 })).toEqual({ status: 'unbekannt' })
        const answers: Array<() => Promise<Response>> = [async () => { throw new Error('offline') }, async () => json({ status: 'erlaubt', jwt: 'j', kopplungId: 'k' })]
        const flaky = vi.fn(async () => answers.shift()!())
        expect(await pollKopplung(BASE, { id: ANFRAGE, abfrageAlleMs: 1 }, { fetchFn: flaky as any, sleep: async () => undefined, maxMs: 1000 })).toMatchObject({ status: 'erlaubt' })
    })
    it('eine abgewiesene Anfrage (400 pruefzahl, 429 ratenlimit) wirft mit Grund', async () => {
        await expect(starteKopplung(BASE, '12', { fetchFn: (async () => json({ ok: false, grund: 'pruefzahl' }, 400)) as any })).rejects.toThrow(/pruefzahl/)
        await expect(starteKopplung(BASE, '1234', { fetchFn: (async () => json({ ok: false, grund: 'ratenlimit' }, 429)) as any })).rejects.toThrow(/ratenlimit/)
    })
    it('eine Ablehnung und das Zeitlimit enden ehrlich, ohne JWT', async () => {
        const denied = vi.fn(async () => json({ status: 'abgelehnt' }))
        expect(await pollKopplung(BASE, { id: ANFRAGE, abfrageAlleMs: 1 }, { fetchFn: denied as any, sleep: async () => undefined, maxMs: 1000 })).toEqual({ status: 'abgelehnt' })
        let clock = 0
        const waiting = vi.fn(async () => json({ status: 'wartet' }))
        expect(await pollKopplung(BASE, { id: ANFRAGE, abfrageAlleMs: 1 }, { fetchFn: waiting as any, sleep: async () => { clock += 1000 }, now: () => clock, maxMs: 2000 })).toEqual({ status: 'zeitlimit' })
    })
    it('erneuert die Sitzung und bekommt einen frischen JWT', async () => {
        const fetchFn = vi.fn(async (_url: any, init: any) => { expect(init.headers.Authorization).toBe('Bearer alt'); return json({ jwt: 'neu' }) })
        expect(await erneuereSitzung(BASE, 'alt', { fetchFn: fetchFn as any })).toBe('neu')
    })
})

describe('Ereignisse', () => {
    it('liest nur art, zeit, ereignisId; Koordinaten fallen weg', () => {
        expect(parseEreignis('ereignis', JSON.stringify({ art: 'person', zeit: 1761818100000, ereignisId: ID, lat: 47.8, lon: 13.0, ort: 'Hausweg 1' })))
            .toEqual({ art: 'person', zeit: 1761818100000, ereignisId: ID })
    })
    it.each([['zustand', '{"art":"person"}'], ['ankunft', '{}'], ['waechter', '{}']])('ignoriert andere Arten: %s', (event, data) => expect(parseEreignis(event, data)).toBeNull())
    it('fehlt die ereignisId, wird das gemeldet, nichts geraten', () => {
        expect(parseEreignis('ereignis', JSON.stringify({ art: 'bewegung', zeit: 1 }))).toEqual({ art: 'bewegung', zeit: 1, ohneId: true })
        expect(parseEreignis('ereignis', JSON.stringify({ art: 'bewegung', zeit: 1, ereignisId: 'kurz' }))).toEqual({ art: 'bewegung', zeit: 1, ohneId: true })
    })
    it('unbekannte Art oder kaputtes JSON ist kein Ereignis', () => {
        expect(parseEreignis('ereignis', JSON.stringify({ art: 'unfall', zeit: 1, ereignisId: ID }))).toBeNull()
        expect(parseEreignis('ereignis', '{kaputt')).toBeNull()
    })
    it('liest den SSE-Strom samt Ping und meldet jedes Ereignis', async () => {
        const text = `: ping\n\nevent: zustand\ndata: {"art":"x"}\n\nevent: ereignis\ndata: {"art":"person","zeit":5,"ereignisId":"${ID}"}\n\n`
        const fetchFn = vi.fn(async (_url: any, init: any) => { expect(init.headers.Authorization).toBe('Bearer jwt'); return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }) })
        const seen: unknown[] = []
        expect(await lauscheEreignisse(BASE, 'jwt', { fetchFn: fetchFn as any, signal: new AbortController().signal, onEreignis: event => { seen.push(event) } })).toEqual({ status: 200 })
        expect(seen).toEqual([{ art: 'person', zeit: 5, ereignisId: ID }])
    })
})

describe('Standbild', () => {
    const wait = vi.fn(async () => undefined)
    it('200 liefert das JPEG', async () => {
        const fetchFn = vi.fn(async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }))
        const result = await holeStandbild(BASE, 'jwt', ID, { fetchFn: fetchFn as any, sleep: wait })
        expect(result.ok).toBe(true)
        expect((fetchFn.mock.calls[0] as any)[0]).toBe(`${BASE}/api/waechter/standbild/${ID}`)
        expect((fetchFn.mock.calls[0] as any)[1].redirect).toBe('error')
    })
    it('202 wartet wie verlangt und holt erneut', async () => {
        const answers = [json({ ok: false, grund: 'noch_nicht', erneutInSekunden: 3 }, 202), new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })]
        const sleep = vi.fn(async () => undefined)
        expect((await holeStandbild(BASE, 'jwt', ID, { fetchFn: (async () => answers.shift()!) as any, sleep })).ok).toBe(true)
        expect(sleep).toHaveBeenCalledWith(3000)
    })
    it('202 gibt nach rund zwei Minuten auf', async () => {
        let clock = 0
        const result = await holeStandbild(BASE, 'jwt', ID, { fetchFn: (async () => json({ ok: false, grund: 'noch_nicht', erneutInSekunden: 3 }, 202)) as any, sleep: async ms => { clock += ms }, now: () => clock })
        expect(result).toEqual({ ok: false, grund: 'noch_nicht' })
        expect(clock).toBeLessThanOrEqual(125_000)
    })
    it.each([[403, 'nicht_erlaubt'], [404, 'nicht_gefunden'], [410, 'zu_alt'], [429, 'zu_oft']])('%i endet sofort als %s, ohne zweiten Abruf', async (status, grund) => {
        const fetchFn = vi.fn(async () => json({ ok: false, grund }, status))
        expect(await holeStandbild(BASE, 'jwt', ID, { fetchFn: fetchFn as any, sleep: wait })).toEqual({ ok: false, grund })
        expect(fetchFn).toHaveBeenCalledOnce()
    })
    it('nur JPEG: alles andere ist kein Standbild', async () => {
        const fetchFn = vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))
        expect(await holeStandbild(BASE, 'jwt', ID, { fetchFn: fetchFn as any, sleep: wait })).toEqual({ ok: false, grund: 'kein_bild' })
    })
})
