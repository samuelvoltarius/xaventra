import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
    ShareHolder, combineShares, createShareKeyPair, openSealedShare, sealSecretVault, splitSecret, unlockSecretVault,
    type ShareKeyPair,
} from './secret-shares.js'

const names = ['spark', 'ns1', 'lab', 'ns2', 'nas']
// Test values are generated at runtime; nothing secret-like is committed.
const fakeToken = () => `test-${randomBytes(12).toString('hex')}`

describe('k-of-n secret sharing', () => {
    it('reconstructs with any k shares and not with k-1', () => {
        const secret = randomBytes(32)
        const shares = splitSecret(secret, 5, 3)
        expect(combineShares([shares[0], shares[2], shares[4]]).equals(secret)).toBe(true)
        expect(combineShares([shares[4], shares[1], shares[3]]).equals(secret)).toBe(true)
        expect(combineShares([shares[0], shares[1]]).equals(secret)).toBe(false)
        expect(() => splitSecret(secret, 5, 1)).toThrow(/k/)
        expect(() => splitSecret(secret, 2, 3)).toThrow(/k/)
    })

    it('seals the vault for all nodes and unlocks only with k released shares', () => {
        const keys: Record<string, ShareKeyPair> = Object.fromEntries(names.map(name => [name, createShareKeyPair()]))
        const token = fakeToken()
        const sealed = sealSecretVault({ TELEGRAM_BOT_TOKEN: token }, names.map(nodeId => ({ nodeId, publicKey: keys[nodeId].publicKey })), 3, { ownerShare: true })
        expect(JSON.stringify(sealed.vault)).not.toContain(token)
        for (const name of names) expect(JSON.stringify(sealed.sealedShares[name])).not.toContain(token)
        expect(sealed.ownerRecoveryShare).toMatch(/^xvs1\./)

        const own = (name: string) => openSealedShare(sealed.sealedShares[name], keys[name])
        expect(() => unlockSecretVault(sealed.vault, [own('spark'), own('ns1')])).toThrow(/3/)
        const secrets = unlockSecretVault(sealed.vault, [own('spark'), own('ns1'), own('nas')])
        expect(secrets.get('TELEGRAM_BOT_TOKEN')).toBe(token)
        expect(JSON.stringify(secrets)).not.toContain(token)
        expect(inspect(secrets)).not.toContain(token)
        expect(String(secrets)).not.toContain(token)
        secrets.wipe()
        expect(secrets.get('TELEGRAM_BOT_TOKEN')).toBeUndefined()

        // Owner recovery share counts as one of k.
        const withOwner = unlockSecretVault(sealed.vault, [own('ns2'), own('nas'), sealed.ownerRecoveryShare!])
        expect(withOwner.get('TELEGRAM_BOT_TOKEN')).toBe(token)
    })

    it('a share opened with the wrong node key fails', () => {
        const keys: Record<string, ShareKeyPair> = Object.fromEntries(names.map(name => [name, createShareKeyPair()]))
        const sealed = sealSecretVault({ A: fakeToken() }, names.map(nodeId => ({ nodeId, publicKey: keys[nodeId].publicKey })), 3)
        expect(() => openSealedShare(sealed.sealedShares.spark, keys.ns1)).toThrow()
    })

    it('a holder releases its share only to a verified main, re-sealed for the requester', async () => {
        const keys: Record<string, ShareKeyPair> = Object.fromEntries(names.map(name => [name, createShareKeyPair()]))
        const sealed = sealSecretVault({ A: fakeToken() }, names.map(nodeId => ({ nodeId, publicKey: keys[nodeId].publicKey })), 3)
        let legit = false
        const holder = new ShareHolder({
            nodeId: 'nas', keyPair: keys.nas, sealedShare: sealed.sealedShares.nas,
            verifyMainClaim: claim => legit && claim.requester === 'ns1' && claim.epoch === 4,
        })
        const request = { requester: 'ns1', requesterPublicKey: keys.ns1.publicKey, epoch: 4 }
        expect((await holder.release(request)).ok).toBe(false)
        legit = true
        const released = await holder.release(request)
        expect(released.ok).toBe(true)
        expect(() => openSealedShare(released.share!, keys.lab)).toThrow()
        const share = openSealedShare(released.share!, keys.ns1)
        expect(share).toMatch(/^xvs1\./)
        expect((await holder.release({ ...request, requester: 'lab', requesterPublicKey: keys.lab.publicKey })).ok).toBe(false)
    })
})
