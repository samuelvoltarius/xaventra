/**
 * Main succession (2.88): secrets on every node, usable only by a legitimate Main.
 *
 * The secret bundle (Telegram token, connector tokens, ...) is encrypted once
 * with a random data key. Every node stores the same ciphertext, but no node
 * can open it alone:
 *
 *  - Majority path: the data key is split k-of-n (Shamir over GF(256), k =
 *    majority of all nodes) and each node keeps exactly one share, sealed to
 *    its own X25519 key. A node that legitimately became Main asks the other
 *    nodes for their shares; each holder re-seals its share for the requester
 *    only after it checked the claim against its OWN view of the lease
 *    coordinator (live lease for exactly that node and epoch) and against its
 *    fence high-water mark (never for an older epoch).
 *  - Owner path: the data key is additionally wrapped with a key derived from
 *    the owner emergency code, so an owner-confirmed emergency Main (safe
 *    mode, no majority) can open the vault with the code.
 *
 * Plaintext secrets exist only in memory (UnlockedSecrets): redacted in JSON,
 * String and inspect, wiped when the node stops being Main.
 */

import {
    createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomUUID,
    type KeyObject,
} from 'node:crypto'
import { inspect } from 'node:util'
import { deriveEmergencyWrapKey } from './emergency-code.js'

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

/** Split `secret` into n shares; any k reconstruct it, k-1 reveal nothing. */
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

/** Shares needed: majority of all share holders, never fewer than two. */
export function shareThreshold(holders: number): number {
    return Math.max(2, Math.floor(holders / 2) + 1)
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

export function sealShare(share: string, vaultId: string, recipient: string, recipientPublicKey: string): SealedShare {
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

export interface OwnerWrap { salt: string; iv: string; tag: string; data: string }

export interface SealedVault {
    v: 1
    id: string
    /** Shares needed (0 = majority path disabled, owner code only). */
    k: number
    nodes: string[]
    names: string[]
    iv: string
    tag: string
    data: string
    ownerWrap?: OwnerWrap
}

function wrapWithCode(dataKey: Buffer, code: string, vaultId: string): OwnerWrap {
    const salt = randomBytes(16)
    const key = deriveEmergencyWrapKey(code, salt)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`owner-wrap|${vaultId}`))
    const data = Buffer.concat([cipher.update(dataKey), cipher.final()])
    key.fill(0)
    return { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

/**
 * Seal the bundle for all nodes. With fewer than three holders a majority
 * share split would let a single node decrypt, so the majority path is then
 * disabled and only the owner code opens the vault.
 */
export function sealSecretVault(
    secrets: Record<string, string>,
    holders: Array<{ nodeId: string; publicKey: string }>,
    options: { ownerCode?: string } = {},
): { vault: SealedVault; sealedShares: Record<string, SealedShare> } {
    if (new Set(holders.map(item => item.nodeId)).size !== holders.length) throw new Error('vault holders must be unique')
    const majorityPath = holders.length >= 3
    if (!majorityPath && !options.ownerCode) throw new Error('fewer than three nodes: the vault needs the owner emergency code')
    const id = randomUUID()
    const dataKey = randomBytes(32)
    try {
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
        cipher.setAAD(Buffer.from(`vault|${id}`))
        const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
        const k = majorityPath ? shareThreshold(holders.length) : 0
        const shares = majorityPath ? splitSecret(dataKey, holders.length, k) : []
        const sealedShares = majorityPath
            ? Object.fromEntries(holders.map((holder, index) => [holder.nodeId, sealShare(shares[index], id, holder.nodeId, holder.publicKey)]))
            : {}
        return {
            vault: {
                v: 1, id, k, nodes: holders.map(item => item.nodeId), names: Object.keys(secrets).sort(),
                iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
                ownerWrap: options.ownerCode ? wrapWithCode(dataKey, options.ownerCode, id) : undefined,
            },
            sealedShares,
        }
    } finally {
        dataKey.fill(0)
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

function openVault(vault: SealedVault, dataKey: Buffer): UnlockedSecrets {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(vault.iv, 'base64'))
    decipher.setAAD(Buffer.from(`vault|${vault.id}`))
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(vault.data, 'base64')), decipher.final()]).toString('utf8')
    return new UnlockedSecrets(JSON.parse(plain) as Record<string, string>)
}

export function unlockVaultWithShares(vault: SealedVault, shares: string[]): UnlockedSecrets {
    if (!vault.k) throw new Error('this vault opens only with the owner emergency code')
    const unique = [...new Map(shares.map(share => [decodeShare(share).x, share])).values()]
    if (unique.length < vault.k) throw new Error(`vault unlock needs ${vault.k} distinct shares, got ${unique.length}`)
    const dataKey = combineShares(unique.slice(0, vault.k))
    try {
        return openVault(vault, dataKey)
    } catch {
        throw new Error('vault unlock failed: shares do not match this vault')
    } finally {
        dataKey.fill(0)
    }
}

/** Owner path; the error never contains the code. */
export function unlockVaultWithOwnerCode(vault: SealedVault, code: string): UnlockedSecrets {
    if (!vault.ownerWrap) throw new Error('this vault has no owner wrap')
    const key = deriveEmergencyWrapKey(code, Buffer.from(vault.ownerWrap.salt, 'base64'))
    let dataKey: Buffer | null = null
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.ownerWrap.iv, 'base64'))
        decipher.setAAD(Buffer.from(`owner-wrap|${vault.id}`))
        decipher.setAuthTag(Buffer.from(vault.ownerWrap.tag, 'base64'))
        dataKey = Buffer.concat([decipher.update(Buffer.from(vault.ownerWrap.data, 'base64')), decipher.final()])
        return openVault(vault, dataKey)
    } catch {
        throw new Error('vault unlock failed: owner code does not match')
    } finally {
        key.fill(0)
        dataKey?.fill(0)
    }
}

// ---------- share holders ----------

export interface ShareRequest {
    requester: string
    requesterPublicKey: string
    /** Main term the requester claims to hold. */
    epoch: number
}

export interface ShareRelease { ok: boolean; share?: SealedShare; reason?: string }

export class ShareHolder {
    constructor(private readonly options: {
        nodeId: string
        keyPair: ShareKeyPair
        sealedShare: SealedShare
        /** Must ask the holder's OWN coordinator view; never trust the request. */
        verifyMainClaim: (claim: { requester: string; epoch: number }) => boolean | Promise<boolean>
        /** Highest Main epoch this holder has seen (fence high-water). */
        highWater?: () => number
    }) {}

    get nodeId(): string { return this.options.nodeId }

    ownShare(): string {
        return openSealedShare(this.options.sealedShare, this.options.keyPair)
    }

    async release(request: ShareRequest): Promise<ShareRelease> {
        if (!request?.requester || request.requester === this.options.nodeId || !request.requesterPublicKey
            || !Number.isSafeInteger(request.epoch) || request.epoch < 1) {
            return { ok: false, reason: 'invalid share request' }
        }
        const mark = this.options.highWater?.() || 0
        if (request.epoch < mark) return { ok: false, reason: `stale epoch ${request.epoch} < ${mark}` }
        let verified = false
        try { verified = await this.options.verifyMainClaim({ requester: request.requester, epoch: request.epoch }) } catch { verified = false }
        if (!verified) return { ok: false, reason: 'Main claim not confirmed by this holder' }
        return { ok: true, share: sealShare(this.ownShare(), this.options.sealedShare.vaultId, request.requester, request.requesterPublicKey) }
    }
}
