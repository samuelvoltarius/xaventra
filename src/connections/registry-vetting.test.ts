import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshDirectory, type CommunityEntry, type DirectoryFetch } from './registry-directory.js'
import { pruefeEintrag, publisherOf, versionsDrift, vorschlaegeFuer } from './registry-vetting.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-vet-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const community = (extra: Partial<CommunityEntry> = {}): CommunityEntry => ({
    name: 'io.github.example/wetter', title: 'Wetter', description: 'Liest das Wetter für einen Ort.', version: '1.2.3',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/wetter', auth: false }], packages: [],
    repository: 'https://github.com/example/wetter', trust: 'community', ...extra,
})

const raw = (name: string, extra: Record<string, unknown> = {}) => ({
    server: { name, title: name.split('/')[1], description: `Dienst ${name}`, version: '1.0.0', repository: { url: `https://github.com/${name.split('/')[0].split('.').slice(2).join('.') || 'example'}/${name.split('/')[1]}` },
        remotes: [{ type: 'streamable-http', url: `https://mcp.example.com/${name.split('/')[1]}` }], ...extra },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
})
const fetchOf = (servers: unknown[]): DirectoryFetch => async () => ({ ok: true, status: 200, json: async () => ({ servers, metadata: {} }) })

describe('registry = discovery, Xaventra decides the trust level', () => {
    it('derives the publisher from the namespace', () => {
        expect(publisherOf('io.github.example/wetter')).toBe('github.com/example')
        expect(publisherOf('com.example/tool')).toBe('example.com')
    })

    it('a clean entry (source, pinned version, https) is community = read only first', () => {
        const result = pruefeEintrag(community())
        expect(result.stufe).toBe('community')
        expect(result.netz).toEqual(['mcp.example.com'])
        expect(result.gepinnt).toBe(true)
        expect(result.verbindbar).toBe(true)
    })

    it('no source, unpinned version, exec hints, squatted source or package only → unbekannt', () => {
        expect(pruefeEintrag(community({ repository: undefined })).stufe).toBe('unbekannt')
        expect(pruefeEintrag(community({ version: 'latest' })).gruende.join(' ')).toMatch(/nicht fest/)
        const exec = pruefeEintrag(community({ description: 'Run arbitrary shell commands on your machine' }))
        expect(exec.stufe).toBe('unbekannt')
        expect(exec.wirkungen).toContain('ausfuehren')
        expect(pruefeEintrag(community({ repository: 'https://github.com/someone-else/wetter' })).gruende.join(' ')).toMatch(/someone-else/)
        const pkg = pruefeEintrag(community({ remotes: [], packages: [{ registryType: 'npm', identifier: 'wetter', version: '1.2.3', transport: 'stdio' }] }))
        expect(pkg).toMatchObject({ stufe: 'unbekannt', verbindbar: false })
    })

    it('an entry of the checked catalog stays geprüft', () => {
        expect(pruefeEintrag(community({ name: 'io.github.github/github-mcp-server', repository: 'https://github.com/github/github-mcp-server' })).stufe).toBe('geprueft')
    })

    it('owner wish → checked catalog first, then the cached directory (offline, cache only)', async () => {
        const dir = tmp()
        const cachePath = join(dir, 'c.json')
        await refreshDirectory({ fetchFn: fetchOf([raw('io.github.example/jellyfin-mcp'), raw('io.github.other/jellyfin-tools', { description: 'Execute shell commands for Jellyfin' })]), baseUrl: 'https://registry.example.com/v0/servers', cachePath, now: 1 })
        const jelly = vorschlaegeFuer('jellyfin', { cachePath })
        expect(jelly.map(item => item.connectorId)).toEqual(['io.github.example/jellyfin-mcp', 'io.github.other/jellyfin-tools'])
        expect(jelly.map(item => item.stufe)).toEqual(['community', 'unbekannt'])
        const github = vorschlaegeFuer('verbinde mich mit github', { cachePath })
        expect(github[0]).toMatchObject({ connectorId: 'github', stufe: 'geprueft' })
        // No cache at all: catalog still answers, nothing throws.
        expect(vorschlaegeFuer('github', { cachePath: join(dir, 'fehlt.json') })[0].connectorId).toBe('github')
        expect(vorschlaegeFuer('', { cachePath })).toEqual([])
    })

    it('a new directory version un-pins a community connection (drift)', async () => {
        const dir = tmp()
        const cachePath = join(dir, 'c.json')
        await refreshDirectory({ fetchFn: fetchOf([raw('io.github.example/wetter', { version: '2.0.0' })]), baseUrl: 'https://registry.example.com/v0/servers', cachePath, now: 1 })
        const records = [
            { id: 'c-io-github-example-wetter', connectorId: 'io.github.example/wetter', title: 'Wetter', trust: 'community', version: '1.0.0', status: 'verbunden' },
            { id: 'c-github', connectorId: 'github', title: 'GitHub', trust: 'geprueft', status: 'verbunden' },
        ]
        expect(versionsDrift(records, cachePath)).toEqual([{ connectionId: 'c-io-github-example-wetter', connectorId: 'io.github.example/wetter', title: 'Wetter', gepinnt: '1.0.0', neu: '2.0.0' }])
        expect(versionsDrift([{ ...records[0], version: '2.0.0' }], cachePath)).toEqual([])
    })
})
