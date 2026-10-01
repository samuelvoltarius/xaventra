import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claimTicketOnce, signTicket, ticketBytes, verifyTicketEnvelope, type TicketDomain } from './signed-ticket.js'
import { installTicketBytes, issueInstallTicket, verifyInstallTicket } from './install-ticket.js'
import { issueVllmTicket, verifyVllmTicket, vllmTicketBytes } from './vllm-ticket.js'
import { getInstallCatalog } from './install-catalog.js'

// P9 Gruppe 4: install-ticket.ts and vllm-ticket.ts carried the same signing,
// expiry and envelope code twice. One core now: signature, timing, exact
// fields, node binding and single use — each ticket type adds only its own rules.

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const DOMAIN: TicketDomain = { label: 'xaventra-test-ticket', idPrefix: 'test', ttlMs: 5 * 60_000 }
const fields = { nodeId: 'spark', clientId: 'main', op: 'x' }
const KEYS = ['clientId', 'expiresAt', 'id', 'issuedAt', 'nodeId', 'op']
const ctx = (now = Date.now()) => ({ publicKey, keys: () => KEYS, nodeId: 'spark', clientId: 'main', now })

describe('signed ticket core', () => {
    it('issues id, issuedAt and expiry by code and verifies the exact envelope', () => {
        const signed = signTicket(DOMAIN, { ...fields, id: 'evil', expiresAt: 1 } as any, privateKey)
        expect(signed.payload.id).toMatch(/^test-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
        expect(signed.payload.expiresAt - signed.payload.issuedAt).toBe(DOMAIN.ttlMs)
        expect(verifyTicketEnvelope(DOMAIN, signed, ctx())).toMatchObject(fields)
    })
    it('rejects foreign fields, other nodes, expired and over-long tickets, and other domains', () => {
        const signed = signTicket(DOMAIN, fields, privateKey)
        expect(() => verifyTicketEnvelope(DOMAIN, { ...signed, extra: 1 }, ctx())).toThrow(/unbekannte Felder/)
        expect(() => verifyTicketEnvelope(DOMAIN, signed, { ...ctx(), nodeId: 'other' })).toThrow(/anderen Knoten/)
        expect(() => verifyTicketEnvelope(DOMAIN, signed, ctx(Date.now() + DOMAIN.ttlMs + 1))).toThrow(/abgelaufen/)
        expect(() => verifyTicketEnvelope({ ...DOMAIN, label: 'xaventra-other-ticket' }, signed, ctx())).toThrow(/Signatur/)
        expect(ticketBytes(DOMAIN, signed.payload).toString()).toMatch(/^xaventra-test-ticket:/)
    })
    it('single use: a ticket id can be claimed exactly once', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ticket-once-'))
        claimTicketOnce(join(dir, 't1.json'), { at: 1 })
        expect(() => claimTicketOnce(join(dir, 't1.json'), { at: 2 })).toThrow()
        expect(JSON.parse(readFileSync(join(dir, 't1.json'), 'utf8'))).toEqual({ at: 1 })
    })
    it('install and vLLM tickets are domain-separated (same key, still not interchangeable)', () => {
        const install = issueInstallTicket({ nodeId: 'spark', clientId: 'main', catalogId: 'ffmpeg', approval: 'fragen', approvedBy: 'owner:alfred' }, privateKey, getInstallCatalog())
        const vllm = issueVllmTicket({ operation: 'markieren', purpose: 'wechsel', nodeId: 'spark', clientId: 'main', planId: 'v0123456789ab', target: 'coder', approvedBy: 'owner:alfred', targets: ['coder'] }, privateKey)
        expect(verifyInstallTicket(install, { nodeId: 'spark', clientId: 'main', publicKey, catalog: getInstallCatalog() }).id).toBe(install.payload.id)
        expect(verifyVllmTicket(vllm, { nodeId: 'spark', clientId: 'main', publicKey, targets: ['coder'] }).id).toBe(vllm.payload.id)
        expect(installTicketBytes(install.payload).toString()).toMatch(/^xaventra-install-ticket:/)
        expect(vllmTicketBytes(vllm.payload).toString()).toMatch(/^xaventra-vllm-ticket:/)
        expect(() => verifyVllmTicket({ payload: vllm.payload, signature: install.signature }, { nodeId: 'spark', clientId: 'main', publicKey, targets: ['coder'] })).toThrow()
    })
    it('both ticket modules and both host agents use the core (no second copy)', () => {
        const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
        for (const path of ['./install-ticket.ts', './vllm-ticket.ts']) {
            const source = read(path)
            expect(source).toContain("from './signed-ticket.js'")
            expect(source).not.toMatch(/from 'node:crypto'/)
        }
        for (const path of ['../host/install-agent.ts', '../host/vllm-agent.ts']) expect(read(path)).toContain('claimTicketOnce')
    })
})
