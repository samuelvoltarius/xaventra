import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscoveryProbeClient, discoveryOrigin } from './discovery-probe.js'
import { AI_SERVICE_PROBES } from './ai-scanner.js'

const endpoint = 'http://localhost:8020/api/ready'
const file = () => join(mkdtempSync(join(tmpdir(), 'discovery-')), 'backoff.json')
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('polite service discovery', () => {
    it('backs off a 404 across five-minute scans and process cache reload, then recovers', async () => {
        let now = 1_000_000
        const path = file()
        const request = vi.fn().mockResolvedValueOnce(new Response('private shop page', { status: 404 }))
            .mockResolvedValueOnce(new Response('true'))
            .mockResolvedValueOnce(new Response('true'))
        vi.stubGlobal('fetch', request)
        const client = new DiscoveryProbeClient(path, () => now)
        expect(await client.probe(endpoint)).toBeNull()
        for (let i = 0; i < 5; i++) { now += 5 * 60_000; expect(await client.probe(endpoint)).toBeNull() }
        const restarted = new DiscoveryProbeClient(path, () => now)
        expect(await restarted.probe(endpoint)).toBeNull()
        expect(request).toHaveBeenCalledTimes(1)
        expect(readFileSync(path, 'utf8')).not.toContain('private shop page')
        now += 5 * 60_000
        expect(await restarted.probe(endpoint)).toBe('true')
        expect(await restarted.probe(endpoint)).toBe('true')
        expect(request).toHaveBeenCalledTimes(3)
        expect(JSON.parse(readFileSync(path, 'utf8')).entries).toEqual({})
    })

    it('excludes exact origins including loopback aliases but not other nodes', async () => {
        vi.stubEnv('XAVENTRA_AI_SCAN_EXCLUDE_ENDPOINTS', 'http://127.0.0.1:8020')
        const request = vi.fn().mockResolvedValue(new Response('true'))
        vi.stubGlobal('fetch', request)
        const client = new DiscoveryProbeClient(file())
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
            expect(await client.probe(`http://${host}:8020/api/ready`)).toBeNull()
        }
        expect(request).not.toHaveBeenCalled()
        expect(await client.probe('http://192.0.2.8:8020/api/ready')).toBe('true')
    })

    it('rejects exclusions with credentials, paths, patterns or a different protocol', () => {
        for (const value of ['http://user:secret@localhost:8020', 'http://localhost:8020/api/ready', '*:8020', 'https://localhost:8020', 'http://localhost:8020/?q=1']) {
            expect(() => discoveryOrigin(value)).toThrow()
        }
    })

    it('uses shorter bounded retries for unreachable or temporarily unavailable services', async () => {
        let now = 1_000_000
        const path = file()
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
        const client = new DiscoveryProbeClient(path, () => now)
        for (let i = 0; i < 8; i++) {
            await client.probe(endpoint)
            const entry = Object.values(JSON.parse(readFileSync(path, 'utf8')).entries)[0] as any
            expect(entry.retryAt - now).toBeLessThanOrEqual(15 * 60_000)
            now = entry.retryAt
        }
    })

    it('bounds repeated HTTP negatives at six hours and never permanently suppresses discovery', async () => {
        let now = 1_000_000
        const path = file()
        vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 404 }))))
        const client = new DiscoveryProbeClient(path, () => now)
        for (let i = 0; i < 9; i++) {
            await client.probe(endpoint)
            const entry = Object.values(JSON.parse(readFileSync(path, 'utf8')).entries)[0] as any
            expect(entry.retryAt - now).toBe(Math.min(6 * 60 * 60_000, 30 * 60_000 * 2 ** i))
            now = entry.retryAt
        }
    })

    it('keeps protocol mismatches separate for services sharing one endpoint', () => {
        let now = 1_000_000
        const client = new DiscoveryProbeClient(file(), () => now)
        client.recordService(endpoint, 'coqui', false)
        expect(client.allowsService(endpoint, 'coqui')).toBe(false)
        expect(client.allowsService(endpoint, 'other-provider')).toBe(true)
        now += 30 * 60_000
        expect(client.allowsService(endpoint, 'coqui')).toBe(true)
        client.recordService(endpoint, 'coqui', true)
        expect(client.allowsService(endpoint, 'coqui')).toBe(true)
    })

    it('does not treat HTML mentioning ready or true as XTTS evidence', () => {
        const probe = AI_SERVICE_PROBES.find(p => p.name === 'coqui-xtts')!
        expect(probe.detectFn('<html>Shop ready. Sale=true</html>')).toBe(false)
        expect(probe.detectFn('{"detail":"not ready"}')).toBe(false)
        for (const body of ['true', '"ready"', '{"ready":true}', '{"status":"ready"}']) expect(probe.detectFn(body)).toBe(true)
    })

    it('discards corrupt and future-dated metadata instead of disabling discovery', async () => {
        const path = file()
        writeFileSync(path, '{invalid')
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('true')))
        expect(await new DiscoveryProbeClient(path).probe(endpoint)).toBe('true')
    })

    it('does not follow redirects and bounds response bytes', async () => {
        const request = vi.fn().mockResolvedValue(new Response('a'.repeat(256 * 1024 + 1)))
        vi.stubGlobal('fetch', request)
        expect(await new DiscoveryProbeClient(file()).probe(endpoint)).toBeNull()
        expect(request.mock.calls[0][1].redirect).toBe('error')
        expect(request.mock.calls[0][1].headers['User-Agent']).toBe('Xaventra-AI-Discovery')
    })
})
