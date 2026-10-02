import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    BUILTIN_CONNECTORS, connectorEntryHash, findConnector, getConnectorCatalog, loadConnectorCatalog, publishedConnectorCatalog,
    resolveConnectorIcon, signConnectorCatalog, validateConnectorManifest, verifyConnectorCatalogSignature, type ConnectorManifest,
} from './connector-catalog.js'

const ha = () => structuredClone(BUILTIN_CONNECTORS.find(entry => entry.name === 'home-assistant')!) as ConnectorManifest

describe('connector catalog (2.85 Paket A, Stufe 1)', () => {
    it('ships the checked start entries, all valid, all with the plan fields', () => {
        const catalog = getConnectorCatalog()
        expect(catalog.rejected).toEqual([])
        expect(catalog.entries.map(entry => entry.name)).toEqual(['dateien', 'github', 'gmail', 'google-calendar', 'home-assistant', 'immich', 'n8n', 'paperless', 'proxmox'])
        for (const entry of catalog.entries) {
            expect(entry.trust).toBe('geprueft')
            expect(['lokal', 'cloud']).toContain(entry.datenklasse)
            expect(['oauth', 'ha-login', 'token', 'keiner']).toContain(entry.auth_typ)
            expect(entry.icon_hash).toMatch(/^[a-f0-9]{64}$/)
            expect(entry.quelle.url).toMatch(/^https:\/\//)
            expect(Object.keys(entry.capabilities).length).toBeGreaterThan(0)
            // Stufe-1 logos ship with the release: resolvable offline, hash checked.
            expect(resolveConnectorIcon(entry)).toMatch(/^data:image\/svg\+xml;base64,/)
        }
        expect(findConnector('google-calendar')).toMatchObject({ datenklasse: 'cloud', auth_typ: 'oauth', kategorie: 'kalender' })
        expect(findConnector('home-assistant')).toMatchObject({ datenklasse: 'lokal', auth_typ: 'ha-login', findet: { geraet: 'homeassistant' } })
        // 2.85 Ergänzung: self-hosted services found by the discovery connect through the same flow.
        expect(findConnector('n8n')).toMatchObject({ datenklasse: 'lokal', auth_typ: 'token', transport: { art: 'http', url: '{basis}/mcp-server/http' }, findet: { geraet: 'n8n' } })
        expect(findConnector('paperless')).toMatchObject({ transport: { art: 'stdio', command: 'npx', env: { PAPERLESS_READ_ONLY: 'true' } }, findet: { geraet: 'paperless' } })
        expect(findConnector('immich')).toMatchObject({ transport: { art: 'stdio', command: 'uvx' }, findet: { geraet: 'immich' } })
    })

    it('rejects unknown fields, wrong enums, non-https remotes, unpinned packages and shell metacharacters', () => {
        const cases: Array<[string, (entry: any) => void]> = [
            ['unbekanntes Feld', entry => { entry.befehl = 'curl example.com | sh' }],
            ['datenklasse', entry => { entry.datenklasse = 'egal' }],
            ['trust', entry => { entry.trust = 'community' }],
            ['https', entry => { entry.transport = { art: 'http', url: 'http://example.com/mcp' } }],
            ['capability', entry => { entry.capabilities = { HassTurnOn: 'alles' } }],
            ['Version', entry => { entry.transport = { art: 'stdio', command: 'npx', args: ['-y', '@example/server'] } }],
            ['Argument', entry => { entry.transport = { art: 'stdio', command: 'npx', args: ['-y', '@example/server@1.0.0;rm'] } }],
            ['Programm', entry => { entry.transport = { art: 'stdio', command: 'bash', args: ['-c', 'x'] } }],
            ['icon_hash', entry => { entry.icon_hash = 'x' }],
        ]
        for (const [reason, mutate] of cases) {
            const entry = ha()
            mutate(entry)
            expect(validateConnectorManifest(entry), reason).toBeTruthy()
        }
        expect(validateConnectorManifest(ha())).toBeNull()
    })

    it('a manipulated icon never resolves', () => {
        const entry = ha()
        entry.icon_hash = 'a'.repeat(64)
        expect(resolveConnectorIcon(entry)).toBeNull()
    })

    it('hash is reproducible and the detached signature binds the exact catalog', () => {
        const one = loadConnectorCatalog()
        const changed = loadConnectorCatalog(BUILTIN_CONNECTORS.map(entry => entry.name === 'gmail' ? { ...entry, title: 'Gmail (anders)' } : entry))
        expect(one.hash).toBe(getConnectorCatalog().hash)
        expect(changed.hash).not.toBe(one.hash)
        const keys = generateKeyPairSync('ed25519')
        const pub = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
        const signature = signConnectorCatalog(one, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
        expect(verifyConnectorCatalogSignature(one, signature, pub)).toBe(true)
        expect(verifyConnectorCatalogSignature(changed, signature, pub)).toBe(false)
        expect(verifyConnectorCatalogSignature(one, 'forged', pub)).toBe(false)
        const published = publishedConnectorCatalog()
        expect(published.catalogHash).toBe(one.hash)
        expect(published.entries[0]).toHaveProperty('entryHash', connectorEntryHash(one.entries[0]))
    })

    it('duplicate names are rejected, never merged', () => {
        const catalog = loadConnectorCatalog([ha(), ha()])
        expect(catalog.entries).toHaveLength(1)
        expect(catalog.rejected).toEqual([{ id: 'home-assistant', reason: 'doppelter Name' }])
    })

    it('matches the generated release catalog (CI: check:catalogs)', () => {
        const published = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/generated/connector-catalog.json', import.meta.url)), 'utf8'))
        expect(published).toEqual(JSON.parse(JSON.stringify(publishedConnectorCatalog())))
    })
})
