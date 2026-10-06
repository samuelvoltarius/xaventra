import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    VOICE_BUNDLE, installVoiceBundle, removeVoiceBundle, validateVoicePart, verifyVoiceBundle, voiceBundleLayout,
    type VoicePart,
} from './voice-artifacts.js'

// Paket O: der Sprachdienst kommt wie das eigene Embedding-Modell nur aus fest
// eingetragenen Dateien (Quelle, Lizenz, Größe, sha256). Kein Netz im Test.

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tempDir() { const dir = mkdtempSync(join(tmpdir(), 'xaventra-voice-')); dirs.push(dir); return dir }

describe('fest eingetragene Sprach-Bausteine', () => {
    it('jeder Baustein hat https-Quelle, Lizenz, Herkunft, Größe und sha256', () => {
        expect(VOICE_BUNDLE.parts.length).toBeGreaterThanOrEqual(5)
        for (const part of VOICE_BUNDLE.parts) {
            expect(() => validateVoicePart(part)).not.toThrow()
            expect(part.license).toBeTruthy()
            expect(part.source).toMatch(/^https:\/\//)
        }
        const names = VOICE_BUNDLE.parts.map(part => part.name)
        // Stack aus den Messungen (Voice-Lab, 03.10.2026)
        expect(names).toEqual(expect.arrayContaining(['silero-vad', 'nemotron-de-560ms', 'piper-ramona', 'piper-thorsten', 'sherpa-onnx-node']))
    })
    it('lehnt Bausteine ohne sha256 oder mit http ab', () => {
        const good = VOICE_BUNDLE.parts[0]
        expect(() => validateVoicePart({ ...good, sha256: 'abc' })).toThrow()
        expect(() => validateVoicePart({ ...good, url: good.url.replace('https', 'http') })).toThrow()
        expect(() => validateVoicePart({ ...good, license: '' })).toThrow()
    })
})

function fakePart(name: string, body: string, kind: VoicePart['kind'] = 'file'): VoicePart {
    return {
        name, kind, url: `https://example.com/${name}.bin`, filename: `${name}.bin`, sizeBytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'), license: 'MIT', source: 'https://example.com/',
        target: kind === 'file' ? `models/${name}.bin` : `models/${name}`, markers: kind === 'file' ? [] : ['marker.txt'],
    }
}

function fakeFetch(bodies: Record<string, string>) {
    return vi.fn(async (url: string) => {
        const body = bodies[url]
        if (body === undefined) return new Response('nope', { status: 404 })
        return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
}

const extract = async (_archive: string, into: string) => {
    mkdirSync(join(into, 'top'), { recursive: true })
    writeFileSync(join(into, 'top', 'marker.txt'), 'ok')
}

describe('installVoiceBundle / verify / remove', () => {
    it('installiert nur nach passender sha256, verify bestätigt, remove räumt alles weg', async () => {
        const dir = tempDir()
        const parts = [fakePart('a', 'AAAA'), fakePart('b', 'BBBB', 'tar-bz2')]
        const bundle = { name: 'test', parts }
        const fetchImpl = fakeFetch({ 'https://example.com/a.bin': 'AAAA', 'https://example.com/b.bin': 'BBBB' })
        const result = await installVoiceBundle(bundle, { dir, fetchImpl, extract, arch: 'x64' })
        expect(result.status).toBe('installiert')
        expect(readFileSync(join(dir, 'models', 'a.bin'), 'utf8')).toBe('AAAA')
        expect(existsSync(join(dir, 'models', 'b', 'marker.txt'))).toBe(true)
        await expect(verifyVoiceBundle(bundle, dir, 'x64')).resolves.toBeUndefined()
        // zweiter Lauf: schon da, kein Download
        const again = await installVoiceBundle(bundle, { dir, fetchImpl, extract, arch: 'x64' })
        expect(again.status).toBe('vorhanden')
        await removeVoiceBundle(bundle, dir)
        expect(existsSync(join(dir, 'models'))).toBe(false)
        await expect(verifyVoiceBundle(bundle, dir, 'x64')).rejects.toThrow()
    })

    it('falsche Prüfsumme: Abbruch, keine Datei bleibt liegen', async () => {
        const dir = tempDir()
        const bundle = { name: 'test', parts: [fakePart('a', 'AAAA')] }
        const fetchImpl = fakeFetch({ 'https://example.com/a.bin': 'XXXX' })
        await expect(installVoiceBundle(bundle, { dir, fetchImpl, extract, arch: 'x64' })).rejects.toThrow(/sha256 stimmt nicht/)
        expect(existsSync(join(dir, 'models', 'a.bin'))).toBe(false)
        expect(existsSync(join(dir, 'receipt.json'))).toBe(false)
    })

    it('Bausteine für eine andere Architektur werden übersprungen', async () => {
        const dir = tempDir()
        const arm = { ...fakePart('arm', 'ARM'), arch: 'arm64' as const }
        const bundle = { name: 'test', parts: [fakePart('a', 'AAAA'), arm] }
        const fetchImpl = fakeFetch({ 'https://example.com/a.bin': 'AAAA' })
        await installVoiceBundle(bundle, { dir, fetchImpl, extract, arch: 'x64' })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
        await expect(verifyVoiceBundle(bundle, dir, 'x64')).resolves.toBeUndefined()
    })

    it('Layout zeigt auf Nemotron, Silero und beide Piper-Stimmen (Ramona Standard)', () => {
        const layout = voiceBundleLayout('/srv/x/voice')
        expect(layout.asr.encoder).toMatch(/nemotron-de-560ms[\\/]encoder\.int8\.onnx$/)
        expect(layout.vad).toMatch(/silero_vad\.int8\.onnx$/)
        expect(layout.voices.female.model).toMatch(/de_DE-ramona-low\.onnx$/)
        expect(layout.voices.male.model).toMatch(/de_DE-thorsten-medium\.onnx$/)
    })
})
