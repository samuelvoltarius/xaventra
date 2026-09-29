import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { checkUrl, checkUrlResolved, fetchWithSsrfGuard, filterUrls, validateWebhookUrl } from './ssrf-guard.js'

// H5 regression: the guard that fetch_url actually uses. Every case here must
// be blocked without any network access.

const BLOCKED = [
    'http://localhost/', 'http://LOCALHOST:8080/x', 'http://foo.localhost/', 'http://localhost./',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://0x7f.0.0.1/',
    'http://0.0.0.0/', 'http://0/',
    'http://[::1]/', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/',
    'http://[fd00::1]/', 'http://[fc00::1]/', 'http://[fd00::ec2:254]/', 'http://[fe80::1]/', 'http://[fec0::1]/', 'http://[ff02::1]/',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/',
    'http://100.64.0.1/', 'http://100.86.70.71/', 'http://100.127.255.255/',
    'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://metadata.azure.com/',
    'http://224.0.0.1/', 'http://255.255.255.255/',
    'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'not a url',
]

const ALLOWED = ['https://example.com/', 'http://93.184.216.34/', 'http://100.63.255.255/', 'http://100.128.0.1/', 'http://172.32.0.1/', 'https://[2606:4700:4700::1111]/']

describe('resilience SSRF guard (H5)', () => {
    it.each(BLOCKED)('blocks %s', url => {
        expect(checkUrl(url).allowed).toBe(false)
        expect(() => validateWebhookUrl(url)).toThrow(/SSRF/)
    })

    it.each(ALLOWED)('allows public %s', url => {
        expect(checkUrl(url).allowed).toBe(true)
    })

    it('filterUrls separates blocked URLs', () => {
        const result = filterUrls(['https://example.com/', 'http://[::1]/'])
        expect(result.allowed).toEqual(['https://example.com/'])
        expect(result.blocked).toHaveLength(1)
    })

    it('checks every resolved DNS address', async () => {
        const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])
        const result = await checkUrlResolved('https://rebind.example/', { lookup })
        expect(result.allowed).toBe(false)
        expect(lookup).toHaveBeenCalledWith('rebind.example')
        const ok = await checkUrlResolved('https://public.example/', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
        expect(ok.allowed).toBe(true)
        expect(ok.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    })

    it('blocks names that resolve to IPv4-mapped or Tailscale addresses', async () => {
        for (const address of ['::ffff:10.0.0.1', '100.86.70.71', 'fd7a:115c:a1e0::1']) {
            const result = await checkUrlResolved('https://name.example/', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }] })
            expect(result.allowed, address).toBe(false)
        }
    })

    it('fails closed when DNS resolution fails', async () => {
        const result = await checkUrlResolved('https://nx.example/', { lookup: async () => { throw new Error('ENOTFOUND') } })
        expect(result.allowed).toBe(false)
    })
})

describe('resilience SSRF guard redirects (H5)', () => {
    let server: Server | undefined
    afterEach(async () => {
        if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
    })

    async function start() {
        server = createServer((req, res) => {
            const port = (server!.address() as any).port
            if (req.url === '/ok') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello'); return }
            if (req.url === '/to-private') { res.writeHead(302, { Location: `http://127.0.0.2:${port}/ok` }); res.end(); return }
            if (req.url === '/to-localhost') { res.writeHead(301, { Location: `http://localhost:${port}/ok` }); res.end(); return }
            if (req.url === '/to-ok') { res.writeHead(307, { Location: '/ok' }); res.end(); return }
            if (req.url?.startsWith('/loop')) { res.writeHead(302, { Location: `/loop${Math.random()}` }); res.end(); return }
            res.writeHead(404); res.end()
        })
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
        return (server.address() as any).port as number
    }

    // "public.test" is pinned to the loopback test server through an explicit
    // operator allowlist; everything else keeps the default policy.
    const guard = (lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }])) => ({ lookup, allowedAddresses: ['127.0.0.1'] })

    it('fetches through the pinned, validated address', async () => {
        const port = await start()
        const options = guard()
        const response = await fetchWithSsrfGuard(`http://public.test:${port}/ok`, undefined, options)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('hello')
        expect(options.lookup).toHaveBeenCalledTimes(1)
    })

    it('re-checks every redirect hop', async () => {
        const port = await start()
        await expect(fetchWithSsrfGuard(`http://public.test:${port}/to-private`, undefined, guard())).rejects.toThrow(/SSRF/)
        await expect(fetchWithSsrfGuard(`http://public.test:${port}/to-localhost`, undefined, guard())).rejects.toThrow(/SSRF/)
        const followed = await fetchWithSsrfGuard(`http://public.test:${port}/to-ok`, undefined, guard())
        expect(await followed.text()).toBe('hello')
    })

    it('stops after five redirects', async () => {
        const port = await start()
        await expect(fetchWithSsrfGuard(`http://public.test:${port}/loop`, undefined, guard())).rejects.toThrow(/redirect/i)
    })

    it('refuses loopback without an explicit allowlist entry', async () => {
        const port = await start()
        await expect(fetchWithSsrfGuard(`http://127.0.0.1:${port}/ok`)).rejects.toThrow(/SSRF/)
    })
})
