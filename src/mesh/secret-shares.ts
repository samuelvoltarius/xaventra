/**
 * 2.86 package K — secrets on every node, unlockable only with a majority.
 *
 * The secret bundle (Telegram token and other channel/provider secrets) is
 * encrypted once with a random data key. That data key is split k-of-n
 * (Shamir over GF(256)); each node receives exactly one share, sealed to its
 * own X25519 key. Every node therefore stores the full ciphertext but can
 * decrypt nothing alone. A node that won the majority lease asks the other
 * holders for their shares; a holder re-seals its share for the requester
 * only after it verified the claim itself (live majority lease for exactly
 * that node and term, or an owner emergency code bound to that node).
 * Plaintext secrets exist only in memory (UnlockedSecrets), are redacted in
 * JSON/inspect/String and can be wiped on step-down.
 */

import {
    createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID,
    type KeyObject,
} from 'node:crypto'
import { inspect } from 'node:util'
import type { EmergencyReleaseGate } from './emergency-release.js'

// ---------- Shamir secret sharing over GF(256) ----------

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
    let x = 1
    for (let i = 0; i < 255; i++) {
        EXP[i] = x
        LOG[x] = i
        // multiply by generator 3 = x ^ xtime(x), reduction polynomial 0x11b
        x = x ^ (((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff)
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
const gfDiv = (a: number, b: number) => {
    if (b === 0) throw new Error('division by zero in GF(256)')
    return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255]
}

const SHARE_PREFIX = 'xvs1'

function encodeShare(x: number, y: Buffer): string {
    return `${SHARE_PREFIX}.${x}.${y.toString('base64url')}`
}

function decodeShare(share: string): { x: number; y: Buffer } {
    const [prefix, xText, yText] = String(share).split('.')
    const x = Number(xText)
    if (prefix !== SHARE_PREFIX || !Number.isInteger(x) || x < 1 || x > 255 || !yText) throw new Error('invalid secret share')
    return { x, y: Buffer.from(yText, 'base64url') }
}

/** Split `secret` into n shares; any k of them reconstruct it, k-1 reveal nothing. */
export function splitSecret(secret: Buffer, n: number, k: number): string[] {
    if (!Number.isInteger(k) || k < 2) throw new Error('secret sharing needs k >= 2')
    if (!Number.isInteger(n) || n < k || n > 255) throw new Error('secret sharing needs k <= n <= 255')
    const ys = Array.from({ length: n }, () => Buffer.alloc(secret.length))
    for (let byte = 0; byte < secret.length; byte++) {
        const coefficients = [secret[byte], ...randomBytes(k - 1)]
        for (let share = 0; share < n; share++) {
            const x = share + 1
            let y = 0
            for (let c = coefficients.length - 1; c >= 0; c--) y = gfMul(y, x) ^ coefficients[c]
            ys[share][byte] = y
        }
    }
    return ys.map((y, index) => encodeShare(index + 1, y))
}

/** Lagrange interpolation at x = 0. With fewer than k shares the result is meaningless. */
export function combineShares(shares: string[]): Buffer {
    const decoded = shares.map(decodeShare)
    if (decoded.length < 2) throw new Error('at least two shares are required')
    if (new Set(decoded.map(item => item.x)).size !== decoded.length) throw new Error('duplicate secret share')
    const length = decoded[0].y.length
    if (decoded.some(item => item.y.length !== length)) throw new Error('secret shares differ in length')
    const out = Buffer.alloc(length)
    for (let byte = 0; byte < length; byte++) {
        let value = 0
        for (let j = 0; j < decoded.length; j++) {
            let basis = 1
            for (let m = 0; m < decoded.length; m++) {
                if (m === j) continue
                basis = gfMul(basis, gfDiv(decoded[m].x, decoded[m].x ^ decoded[j].x))
            }
            value ^= gfMul(decoded[j].y[byte], basis)
        }
        out[byte] = value
    }
    return out
}

// ---------- sealing to a node key (X25519 + HKDF + AES-256-GCM) ----------

export interface ShareKeyPair { publicKey: string; privateKey: KeyObject }

export function createShareKeyPair(): ShareKeyPair {
    const pair = generateKeyPairSync('x25519')
    return { publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey }
}

export interface SealedShare {
    v: 1
    vaultId: string
    recipient: string
    epk: string
    iv: string
    tag: string
    data: string
}

function boxKey(shared: Buffer, epk: string, context: string): Buffer {
    return Buffer.from(hkdfSync('sha256', shared, Buffer.from(epk), `xaventra-share|${context}`, 32))
}

function sealShare(share: string, vaultId: string, recipient: string, recipientPublicKey: string): SealedShare {
    const eph = generateKeyPairSync('x25519')
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey(recipientPublicKey) })
    const epk = eph.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const context = `${vaultId}|${recipient}`
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', boxKey(shared, epk, context), iv)
    cipher.setAAD(Buffer.from(context))
    const data = Buffer.concat([cipher.update(share, 'utf8'), cipher.final()])
    return { v: 1, vaultId, recipient, epk, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/** Opens a share sealed to `keyPair`; throws for any other key or tampering. */
export function openSealedShare(sealed: SealedShare, keyPair: ShareKeyPair): string {
    const shared = diffieHellman({ privateKey: keyPair.privateKey, publicKey: createPublicKey(sealed.epk) })
    const context = `${sealed.vaultId}|${sealed.recipient}`
    const decipher = createDecipheriv('aes-256-gcm', boxKey(shared, sealed.epk, context), Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const share = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
    decodeShare(share)
    return share
}

// ---------- the vault ----------

export interface SealedVault {
    v: 1
    id: string
    k: number
    n: number
    nodes: string[]
    ownerShare: boolean
    iv: string
    tag: string
    data: string
}

export function sealSecretVault(
    secrets: Record<string, string>,
    recipients: Array<{ nodeId: string; publicKey: string }>,
    k: number,
    options: { ownerShare?: boolean } = {},
): { vault: SealedVault; sealedShares: Record<string, SealedShare>; ownerRecoveryShare?: string } {
    if (new Set(recipients.map(item => item.nodeId)).size !== recipients.length) throw new Error('vault recipients must be unique')
    const id = randomUUID()
    const dataKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
    cipher.setAAD(Buffer.from(`vault|${id}`))
    const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
    const total = recipients.length + (options.ownerShare ? 1 : 0)
    const shares = splitSecret(dataKey, total, k)
    dataKey.fill(0)
    const sealedShares = Object.fromEntries(recipients.map((recipient, index) => [recipient.nodeId, sealShare(shares[index], id, recipient.nodeId, recipient.publicKey)]))
    return {
        vault: {
            v: 1, id, k, n: total, nodes: recipients.map(item => item.nodeId), ownerShare: Boolean(options.ownerShare),
            iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
        },
        sealedShares,
        // Shown once to the owner (offline/password manager); never stored by a node.
        ownerRecoveryShare: options.ownerShare ? shares[total - 1] : undefined,
    }
}

const REDACTED = '[UnlockedSecrets: redacted]'

/** Plaintext secrets in memory only; redacted in every serialization path. */
export class UnlockedSecrets {
    #values: Map<string, string>

    constructor(values: Record<string, string>) {
        this.#values = new Map(Object.entries(values))
    }

    get(name: string): string | undefined { return this.#values.get(name) }
    has(name: string): boolean { return this.#values.has(name) }
    names(): string[] { return [...this.#values.keys()] }
    wipe(): void { this.#values.clear() }
    toJSON(): { redacted: true; names: string[] } { return { redacted: true, names: this.names() } }
    toString(): string { return REDACTED }
    [inspect.custom](): string { return `${REDACTED} (${this.names().join(', ')})` }
}

export function unlockSecretVault(vault: SealedVault, shares: string[]): UnlockedSecrets {
    const unique = [...new Map(shares.map(share => [decodeShare(share).x, share])).values()]
    if (unique.length < vault.k) throw new Error(`vault unlock needs ${vault.k} distinct shares, got ${unique.length}`)
    const dataKey = combineShares(unique.slice(0, vault.k))
    try {
        const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(vault.iv, 'base64'))
        decipher.setAAD(Buffer.from(`vault|${vault.id}`))
        decipher.setAuthTag(Buffer.from(vault.tag, 'base64'))
        const plain = Buffer.concat([decipher.update(Buffer.from(vault.data, 'base64')), decipher.final()]).toString('utf8')
        return new UnlockedSecrets(JSON.parse(plain) as Record<string, string>)
    } catch {
        throw new Error('vault unlock failed: shares do not match this vault')
    } finally {
        dataKey.fill(0)
    }
}

// ---------- share holders ----------

export interface ShareRequest {
    requester: string
    requesterPublicKey: string
    /** Majority term the requester claims to hold. */
    epoch?: number
    /** Owner emergency code (only without majority). */
    emergencyCode?: string
}

export interface ShareRelease { ok: boolean; share?: SealedShare; reason?: string }

export class ShareHolder {
    constructor(private readonly options: {
        nodeId: string
        keyPair: ShareKeyPair
        sealedShare: SealedShare
        /** Must check the holder's OWN view (its witnesses), never trust the request. */
        verifyMainClaim: (claim: { requester: string; epoch: number }) => boolean | Promise<boolean>
        emergencyGate?: EmergencyReleaseGate
    }) {}

    get nodeId(): string { return this.options.nodeId }

    ownShare(): string {
        return openSealedShare(this.options.sealedShare, this.options.keyPair)
    }

    async release(request: ShareRequest): Promise<ShareRelease> {
        if (!request?.requester || request.requester === this.options.nodeId || !request.requesterPublicKey) {
            return { ok: false, reason: 'invalid share request' }
        }
        let allowed = false
        if (request.emergencyCode) {
            allowed = Boolean(this.options.emergencyGate?.verify({ code: request.emergencyCode, nodeId: request.requester }).ok)
        } else if (Number.isSafeInteger(request.epoch) && Number(request.epoch) > 0) {
            allowed = await this.options.verifyMainClaim({ requester: request.requester, epoch: Number(request.epoch) })
        }
        if (!allowed) return { ok: false, reason: 'claim not verified by this holder' }
        const share = this.ownShare()
        return { ok: true, share: sealShare(share, this.options.sealedShare.vaultId, request.requester, request.requesterPublicKey) }
    }
}
