import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { SessionContinuityStore } from '../memory/session-summarizer.js'
import { OwnerAccountRegistry, _resetOwnerAmbiguityWarningForTest, confirmOwnerAccountIfTrusted, setOwnerAccountRegistry } from './owner-accounts.js'
import { migrateLegacyOwnerScopes } from './owner-identity-migration.js'
import { resolveCanonicalOwner } from './owner-identity.js'

const config = { channels: { telegram: { allowFrom: ['1001'] } } }
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'owner-mig-'))
    return {
        dir,
        governance: new MemoryGovernanceCoordinator(join(dir, 'gov')),
        sessions: new SessionContinuityStore(join(dir, 'sessions.json')),
        registry: new OwnerAccountRegistry(join(dir, 'owner-accounts.json')),
    }
}
const propose = (g: MemoryGovernanceCoordinator, scope: string, content: string) =>
    g.propose({ content, kind: 'fact', scope, source: 'test', evidence: 'manual', confidence: 1, verified: true })!

describe('owner identity (U6)', () => {
    it('resolves one canonical owner: explicit > env > single allowFrom; several owners are ambiguous', () => {
        expect(resolveCanonicalOwner(config, {})).toEqual({ principal: '1001', ambiguous: false })
        expect(resolveCanonicalOwner({ channels: { telegram: { allowFrom: ['1', '2'] } } }, {})).toEqual({ principal: null, ambiguous: true })
        expect(resolveCanonicalOwner({ channels: { telegram: { allowFrom: ['1', '2'] } } }, { NOVA_DESKTOP_TELEGRAM_OWNER_ID: '2' } as any).principal).toBe('2')
        expect(resolveCanonicalOwner({ ownerPrincipal: 'owner-sample', channels: { telegram: { allowFrom: ['1', '2'] } } }, {}).principal).toBe('owner-sample')
    })

    it('moves legacy desktop memories to the canonical owner, once, with a backup, keeping other principals', () => {
        const f = fixture()
        const legacy = propose(f.governance, 'user:desktop-owner', 'Mein Hund Bello trägt ein graues Halsband und mag Spaziergänge.')
        const dupOld = propose(f.governance, 'user:desktop:desktop-owner', 'Meine Katze Mizzi ist eine weiße Perserkatze mit blauen Augen.')
        propose(f.governance, 'user:1001', 'Meine Katze Mizzi ist eine weiße Perserkatze mit blauen Augen.')
        const probe = propose(f.governance, 'user:rest-api:probe', 'Der Probe-Nutzer hat ein geheimes Passwortmuster nicht.')
        f.sessions.setProjectContext('desktop-owner', 'Gartenprojekt')
        f.registry.confirm('desktop', 'desktop:desktop-owner', 'vertrauter-zugang', 'desktop-owner')

        const first = migrateLegacyOwnerScopes({ config, ...f })
        expect(first).toMatchObject({ rescoped: 1, duplicatesRetired: 1, sessionsAdopted: 1, registryRepointed: true })
        expect(f.governance.get(legacy.id)?.scope).toBe('user:1001')
        expect(f.governance.get(dupOld.id)?.status).toBe('rejected') // kept, not deleted
        expect(f.governance.get(probe.id)?.scope).toBe('user:rest-api:probe')
        expect(f.sessions.getSummary('1001')?.projectContext).toBe('Gartenprojekt')
        expect(f.registry.canonical()).toBe('1001')
        expect(readdirSync(f.dir).some(name => name.startsWith('owner-identity-backup-'))).toBe(true)

        const second = migrateLegacyOwnerScopes({ config, ...f })
        expect(second.skipped).toBe('nothing-to-do')
        expect(second.rescoped).toBe(0)
        expect(readdirSync(f.dir).filter(name => name.startsWith('owner-identity-backup-'))).toHaveLength(1)
    })

    it('ambiguous config: no merge, clear warning, nothing moves', () => {
        const f = fixture()
        const legacy = propose(f.governance, 'user:desktop-owner', 'Mein Hund Bello trägt ein graues Halsband und mag Spaziergänge.')
        const ambiguous = { channels: { telegram: { allowFrom: ['1001', '2002'] } } }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        expect(migrateLegacyOwnerScopes({ config: ambiguous, ...f }).skipped).toBe('ambiguous')
        expect(f.governance.get(legacy.id)?.scope).toBe('user:desktop-owner')
        expect(warn.mock.calls.flat().join(' ')).toMatch(/not merged|nothing merged/i)

        _resetOwnerAmbiguityWarningForTest()
        setOwnerAccountRegistry(f.registry)
        try {
            expect(confirmOwnerAccountIfTrusted({ config: ambiguous, channel: 'desktop', rawUserId: 'desktop:owner', permission: 'owner', isGroup: false })).toBeNull()
            expect(confirmOwnerAccountIfTrusted({ config: ambiguous, channel: 'telegram', rawUserId: '1001', permission: 'owner', permissionSource: 'configured', isGroup: false })).toBeNull()
        } finally { setOwnerAccountRegistry(null); warn.mockRestore() }
    })

    it('the Even G2 HUD owner joins the canonical principal; a non-owner never does', () => {
        const registry = new OwnerAccountRegistry(join(mkdtempSync(join(tmpdir(), 'owner-g2-')), 'owner-accounts.json'))
        setOwnerAccountRegistry(registry)
        try {
            expect(confirmOwnerAccountIfTrusted({ config, channel: 'even-g2', rawUserId: 'even-g2:owner', permission: 'owner', isGroup: false })).toBe('1001')
            expect(confirmOwnerAccountIfTrusted({ config, channel: 'even-g2', rawUserId: 'even-g2:guest', permission: 'user', isGroup: false })).toBeNull()
            expect(confirmOwnerAccountIfTrusted({ config, channel: 'telefon', rawUserId: 'telefon:+4312345', permission: 'owner', isGroup: false })).toBeNull()
        } finally { setOwnerAccountRegistry(null) }
    })
})
