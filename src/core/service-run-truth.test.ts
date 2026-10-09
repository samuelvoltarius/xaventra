/**
 * 2.89.4: „Läuft“ nur mit Beleg — Labels und Dienst-Korrekturen.
 * Kein Netz; Sonden werden per fetchImpl gesteuert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    detectServiceStateCorrection, formatServiceCorrectionReply, formatServiceStatus,
    getServiceProbeEvidence, liveCheckServices, recordServiceProbe, resetServiceProbeEvidence,
    serviceRunClaim, serviceRunLabel,
} from './service-run-truth.js'
import { detectDeterministicCommand } from './deterministic-query.js'

beforeEach(() => {
    resetServiceProbeEvidence()
    vi.stubEnv('NOVA_SKIP_MODEL_RESOLVER_INIT', '1')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('2.89.4: „läuft“ nur mit Sondenbeleg in diesem Lauf', () => {
    it('ohne Sonde: nicht geprüft — auch wenn der Bestand „running“ behauptet', () => {
        expect(serviceRunClaim('ollama')).toBe('nicht-geprueft')
        expect(serviceRunLabel('ollama', true)).toBe('nicht geprüft')
        expect(formatServiceStatus('ollama', { claimedRunning: true })).toContain('nicht geprüft')
    })

    it('erfolgreiche Sonde: läuft; fehlgeschlagene: nicht erreichbar', () => {
        recordServiceProbe('ollama', true, '/api/tags')
        expect(serviceRunLabel('ollama', true)).toBe('läuft')
        expect(formatServiceStatus('ollama')).toMatch(/läuft \(geprüft\)/)
        recordServiceProbe('whisper', false, 'ECONNREFUSED')
        expect(serviceRunLabel('whisper', true)).toBe('nicht erreichbar')
        expect(getServiceProbeEvidence('whisper')?.ok).toBe(false)
    })

    it('reset vergisst jeden Beleg (neuer Lauf)', () => {
        recordServiceProbe('ollama', true)
        expect(serviceRunLabel('ollama')).toBe('läuft')
        resetServiceProbeEvidence()
        expect(serviceRunLabel('ollama')).toBe('nicht geprüft')
    })
})

describe('2.89.4: Nutzer-Korrekturen zu Diensten erkennen', () => {
    it.each([
        ['Der Sprachdienst läuft doch schon.', true],
        ['Whisper läuft schon.', true],
        ['Das läuft doch bereits.', true],
        ['Du solltest doch schon verbunden sein.', true],
        ['Du solltest schon verbunden sein.', true],
        ['Ollama ist doch schon online.', true],
        ['Du bist doch schon verbunden.', true],
        ['Warum bist du noch nicht verbunden?', true],
        ['Pocket-TTS läuft wieder.', true],
    ])('%s → Korrektur', text => {
        const found = detectServiceStateCorrection(text)
        expect(found).not.toBeNull()
    })

    it.each([
        'Läuft alles?',
        'Was läuft gerade?',
        'Wo läuft vLLM im Mesh?',
        'Mach eine Inventur der Dienste.',
        'Der Update-Lauf ist fertig.',
        'Welche Nova Version ist installiert?',
        // 2.89.4: a named subject with its own status tools is never this live-check
        // („homeassit sollte schon laufen“ stays with hass_status, not speech/model).
        'homeassit sollte schon laufen',
        'Home Assistant sollte schon laufen',
        'Proxmox läuft doch schon',
    ])('%s → keine Korrektur', text => {
        expect(detectServiceStateCorrection(text)).toBeNull()
    })

    it('erkennt auch die Gegenkorrektur „läuft nicht“', () => {
        const found = detectServiceStateCorrection('Nein, Whisper läuft nicht.')
        expect(found).toMatchObject({ claimRunning: false })
    })

    it('der Schnellweg leitet auf den Live-Check, nicht auf ein anderes Thema', () => {
        expect(detectDeterministicCommand('Der Sprachdienst läuft doch schon.')).toMatchObject({
            command: 'dienste', args: 'live-check', reason: 'service-live-check',
        })
    })
})

describe('2.89.4: Prüfergebnis ehrlich melden', () => {
    it('ohne antwortende Sonde wird die Behauptung nicht übernommen', async () => {
        const down = vi.fn(async () => { throw new Error('ECONNREFUSED') })
        const check = await liveCheckServices({ fetchImpl: down as any })
        expect(check.anyOk).toBe(false)
        const reply = formatServiceCorrectionReply(check, detectServiceStateCorrection('läuft doch schon'), 'läuft doch schon')
        expect(reply).toContain('nicht ungeprüft')
        expect(reply).toMatch(/nicht erreichbar|nicht geprüft/)
        expect(reply).toMatch(/nicht bestätigen/)
        expect(reply).not.toMatch(/ja, stimmt|du hattest recht/)
        expect(reply).toContain('läuft doch schon')
    })

    it('antwortende Sonde wird verbunden und als läuft geführt', async () => {
        vi.stubEnv('XAVENTRA_STT_BASE_URL', 'http://127.0.0.1:8018')
        vi.stubEnv('XAVENTRA_TTS_BASE_URL', 'http://127.0.0.1:5002')
        const fetchImpl = vi.fn(async (url: any) => {
            const text = String(url)
            if (text.includes(':8018') || text.includes(':5002')) {
                return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
            }
            return new Response('nope', { status: 404 })
        })
        const check = await liveCheckServices({ fetchImpl: fetchImpl as any })
        expect(check.anyOk).toBe(true)
        expect(serviceRunLabel('Spracherkennung (STT)')).toBe('läuft')
        const reply = formatServiceCorrectionReply(check, detectServiceStateCorrection('solltest du schon verbunden sein'), 'solltest du schon verbunden sein')
        expect(reply).toContain('läuft (geprüft)')
        expect(reply).toMatch(/Verbunden/)
        expect(reply).toMatch(/recht/)
    })
})
