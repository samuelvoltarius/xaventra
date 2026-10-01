import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BUILTIN_INSTALL_CATALOG, getInstallCatalog, loadInstallCatalog } from './install-catalog.js'
import { INSTALL_TICKET_TTL_MS, installTicketBytes, issueInstallTicket, verifyInstallTicket, type InstallTicket } from './install-ticket.js'

const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
const pem = (k: any, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }).toString()
const publicKey = pem(keys.publicKey, 'spki'), privateKey = pem(keys.privateKey, 'pkcs8')
const catalog = getInstallCatalog()
const ctx = { nodeId: 'spark', clientId: 'xaventra-main', publicKey, catalog }
const issue = (overrides: Partial<Parameters<typeof issueInstallTicket>[0]> = {}, now = Date.now()) =>
    issueInstallTicket({ nodeId: 'spark', clientId: 'xaventra-main', catalogId: 'ffmpeg', approval: 'fragen', approvedBy: 'owner:alfred', ...overrides }, privateKey, catalog, now)
const resign = (payload: InstallTicket, key = privateKey) => ({ payload, signature: sign(null, installTicketBytes(payload), key).toString('base64') })

describe('install tickets (S2.2)', () => {
    it('are issued by code: id, expiry and hashes are never taken from the caller', () => {
        const signed = issue({ id: 'evil-id', expiresAt: Date.now() + 86_400_000, entryHash: '0'.repeat(64) } as any)
        expect(signed.payload.id).toMatch(/^inst-[a-f0-9-]{36}$/)
        expect(signed.payload.expiresAt - signed.payload.issuedAt).toBe(INSTALL_TICKET_TTL_MS)
        expect(signed.payload.entryHash).not.toBe('0'.repeat(64))
        expect(verifyInstallTicket(signed, ctx)).toMatchObject({ catalogId: 'ffmpeg', nodeId: 'spark', approvedBy: 'owner:alfred' })
        expect(issue().payload.id).not.toBe(signed.payload.id)
    })

    it('are never issued for ids outside the catalog or for model-originated approvals', () => {
        expect(() => issue({ catalogId: 'htop' })).toThrow()
        expect(() => issue({ catalogId: 'ffmpeg;rm -rf /' })).toThrow()
        expect(() => issue({ approvedBy: 'model:qwen' })).toThrow()
        expect(() => issue({ approvedBy: 'policy:erlauben', approval: 'fragen' })).toThrow()
        expect(() => issue({ approvedBy: '' })).toThrow()
    })

    it('rejects missing, forged, tampered, expired and foreign tickets', () => {
        const good = issue()
        const bad: unknown[] = [
            undefined, {}, { payload: good.payload }, { ...good, signature: 'AAAA' },
            resign(good.payload, pem(other.privateKey, 'pkcs8')),
            { payload: { ...good.payload, catalogId: 'xfce-workstation' }, signature: good.signature },
            issue({}, Date.now() - INSTALL_TICKET_TTL_MS - 1),
            resign({ ...good.payload, expiresAt: Date.now() + 60 * 60_000 }),
            issue({ nodeId: 'xaventra-ns1' }), issue({ clientId: 'someone-else' }),
            resign({ ...good.payload, id: 'model-chosen-id-123456' }),
            resign({ ...good.payload, approvedBy: 'model:qwen' }),
            resign({ ...good.payload, catalogId: 'htop' }),
            resign({ ...good.payload, command: 'apt-get install htop' } as any),
            { ...good, extra: true },
        ]
        for (const value of bad) expect(() => verifyInstallTicket(value, ctx)).toThrow()
    })

    it('is bound to the entry hash: a changed catalog entry invalidates the ticket', () => {
        const signed = issue()
        const changed = loadInstallCatalog(BUILTIN_INSTALL_CATALOG.map(entry => entry.id === 'ffmpeg' ? { ...entry, sizeMb: 999 } : entry))
        expect(() => verifyInstallTicket(signed, { ...ctx, catalog: changed })).toThrow(/Hash/)
    })
})
