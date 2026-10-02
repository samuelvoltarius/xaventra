/**
 * Phase 4 self-update watcher: read-only discovery of signed GitHub releases.
 *
 * Reads the release listing, the signed manifest, SHA256SUMS and the small
 * per-architecture descriptors (a few hundred bytes each), verifies them with
 * the existing functions against the PINNED publisher key and emits one
 * "fragen" thought per release. It never downloads program archives or images,
 * never stages, extracts, activates or restarts anything. Default off
 * (`autonomy.selfUpdate.enabled`).
 */

import { createHash, createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
    MANIFEST_ASSET, UPDATE_REPOSITORY, compareUpdateVersions, fetchUpdateResource, verifyUpstreamManifest,
    type GitHubUpdatePolicy, type SignedUpstreamManifest,
} from '../github-update.js'
import { decodeUpdatePackage, upstreamReleaseId } from '../update-package.js'
import { atomicWriteJson } from '../atomic-storage.js'
import { makeThought, plainText, type Thought, type ThoughtSink } from './thought-sink.js'

/** Production publisher (runbook 3.2). Private key lives only in the protected GitHub job. */
export const PINNED_PUBLISHER_KEY_ID = 'xaventra-update-20260910'
export const PINNED_PUBLISHER_SPKI_SHA256 = '12c9322618387537b605f9241619a87e48c8cc9f0df6a7bdc5f44438f2af887a'
export const CHECKSUM_ASSET = 'SHA256SUMS'
/** Container descriptors are < 1 KiB. Anything larger is a program/image and needs approval. */
export const MAX_DESCRIPTOR_BYTES = 64 * 1024

const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100`
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/
type Fetch = typeof fetch

export interface SelfUpdateSettings {
    enabled: boolean
    intervalMinutes: number
    /** stable: tags without -rc (the publisher marks every signed preview as GitHub prerelease). */
    channel: 'stable' | 'rc'
    /** Operator-enrolled public keys (PEM). Only the pinned key id/fingerprint is ever used. */
    publisherKeys: Record<string, string>
}

export function readSelfUpdateSettings(config: any): SelfUpdateSettings {
    const raw = config?.autonomy?.selfUpdate || {}
    const interval = Number(raw.intervalMinutes)
    const keys: Record<string, string> = {}
    const source = raw.publisherKeys && typeof raw.publisherKeys === 'object' ? raw.publisherKeys : config?.mesh?.update?.github?.publisherKeys
    for (const [id, value] of Object.entries(source && typeof source === 'object' ? source : {})) if (typeof value === 'string') keys[id] = value
    return {
        enabled: raw.enabled === true,
        intervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(30, Math.round(interval))) : 360,
        channel: raw.channel === 'rc' ? 'rc' : 'stable',
        publisherKeys: keys,
    }
}

export interface VerifiedArtifact { arch: 'x64' | 'arm64'; name: string; size: number; sha256: string; image: string }
export interface VerifiedRelease {
    version: string; tag: string; releaseId: string; commit: string; publisherKeyId: string
    artifacts: VerifiedArtifact[]; notes: string; checkedAt: string
}
export type ReleaseInspection =
    | { state: 'verified'; release: VerifiedRelease }
    | { state: 'none'; reason: string }
    | { state: 'rejected'; reason: string; version?: string }

export interface PublisherPin { keyId: string; spkiSha256: string }
export interface InspectOptions {
    settings: SelfUpdateSettings
    currentVersion: string
    fetcher?: Fetch
    /** Tests only; production uses the constants above. */
    pin?: PublisherPin
    now?: () => number
}

interface Asset { name: string; state: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; body?: string; assets: Asset[] }

/** Policy holding exactly the pinned key, or a reason why the enrollment is not trusted. */
export function pinnedPublisherPolicy(keys: Record<string, string>, pin: PublisherPin): GitHubUpdatePolicy | string {
    const text = keys[pin.keyId]
    if (!text) return `Publisher-Schlüssel ${pin.keyId} nicht eingeschrieben`
    try {
        const key = createPublicKey(text)
        const spki = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
        if (spki !== pin.spkiSha256) return 'Eingeschriebener Publisher-Schlüssel entspricht nicht dem gepinnten Fingerabdruck'
    } catch { return 'Publisher-Schlüssel unlesbar' }
    return { channel: 'rc', publisherKeys: { [pin.keyId]: text } }
}

async function readBytes(url: string, max: number, fetcher: Fetch): Promise<Buffer> {
    const chunks: Uint8Array[] = []
    await fetchUpdateResource(url, max, async chunk => { chunks.push(chunk) }, fetcher)
    return Buffer.concat(chunks)
}

function assetUrl(release: Release, name: string): string {
    const matches = (release.assets || []).filter(a => a.name === name && a.state === 'uploaded')
    const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${release.tag_name}/${name}`
    if (matches.length !== 1 || matches[0].browser_download_url !== expected) throw Error(`Release-Asset ${name} fehlt, doppelt oder fremd`)
    return expected
}

function parseChecksums(text: string): Map<string, string> {
    const sums = new Map<string, string>()
    for (const line of text.split('\n').filter(Boolean)) {
        const match = /^([a-f0-9]{64}) {2}(xaventra-[a-z0-9.-]+\.tar\.gz)$/.exec(line)
        if (!match || sums.has(match[2])) throw Error('SHA256SUMS ungültig')
        sums.set(match[2], match[1])
    }
    return sums
}

function safeReason(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return /https?:|BEGIN |token|password/i.test(message) ? 'Prüfung fehlgeschlagen' : message.slice(0, 200)
}

/** One read-only inspection. Never writes, stages or executes. */
export async function inspectLatestRelease(options: InspectOptions): Promise<ReleaseInspection> {
    const pin = options.pin || { keyId: PINNED_PUBLISHER_KEY_ID, spkiSha256: PINNED_PUBLISHER_SPKI_SHA256 }
    const fetcher = options.fetcher || fetch
    const policy = pinnedPublisherPolicy(options.settings.publisherKeys, pin)
    if (typeof policy === 'string') return { state: 'rejected', reason: policy }
    let version: string | undefined
    try {
        const listing = JSON.parse((await readBytes(RELEASES_API, 2 * 1024 * 1024, fetcher)).toString('utf8'))
        if (!Array.isArray(listing) || listing.length >= 100) throw Error('Release-Liste unvollständig oder ungültig')
        const candidates = (listing as Release[]).filter(r => r && !r.draft && typeof r.tag_name === 'string'
            && /^v/.test(r.tag_name) && SEMVER.test(r.tag_name.slice(1))
            && (options.settings.channel === 'rc' || !r.tag_name.includes('-'))
            && compareUpdateVersions(r.tag_name.slice(1), options.currentVersion) > 0)
            .sort((a, b) => compareUpdateVersions(b.tag_name.slice(1), a.tag_name.slice(1)))
        if (!candidates.length) return { state: 'none', reason: `keine neuere signierte Release als ${options.currentVersion}` }
        const release = candidates[0]
        version = release.tag_name.slice(1)
        const signed: SignedUpstreamManifest = JSON.parse((await readBytes(assetUrl(release, MANIFEST_ASSET), 64 * 1024, fetcher)).toString('utf8'))
        const manifest = verifyUpstreamManifest(signed, policy, version, options.currentVersion)
        const sums = parseChecksums((await readBytes(assetUrl(release, CHECKSUM_ASSET), 16 * 1024, fetcher)).toString('utf8'))
        if (sums.size !== manifest.artifacts.length || manifest.artifacts.some(a => sums.get(a.name) !== a.sha256)) throw Error('SHA256SUMS weicht vom signierten Manifest ab')
        const artifacts: VerifiedArtifact[] = []
        for (const artifact of manifest.artifacts) {
            if (artifact.size > MAX_DESCRIPTOR_BYTES) throw Error(`Artefakt ${artifact.name} ist kein kleiner Deskriptor; Download nur nach Freigabe`)
            const bytes = await readBytes(assetUrl(release, artifact.name), artifact.size, fetcher)
            if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw Error(`Hash-Abweichung bei ${artifact.name}`)
            const descriptor = decodeUpdatePackage(bytes, manifest, artifact.arch)
            artifacts.push({ arch: descriptor.arch, name: artifact.name, size: artifact.size, sha256: artifact.sha256, image: descriptor.image })
        }
        return {
            state: 'verified',
            release: {
                version, tag: release.tag_name, releaseId: upstreamReleaseId(manifest), commit: manifest.commit,
                publisherKeyId: signed.keyId, artifacts, notes: plainText(release.body, 400),
                checkedAt: new Date((options.now || Date.now)()).toISOString(),
            },
        }
    } catch (error) {
        return { state: 'rejected', reason: safeReason(error), version }
    }
}

export interface ProposalPlan { planHash: string; summary: string }

export function createUpdateProposal(release: VerifiedRelease, plan?: ProposalPlan | null, now = Date.now()): Thought {
    const arches = release.artifacts.map(a => a.arch).sort().join('/')
    const text = `${release.version} verfügbar, geprüft (Signatur ${release.publisherKeyId}, SHA256SUMS, Deskriptoren ${arches}). `
        + `Änderungen: ${release.notes || 'keine Release-Notizen'} (Commit ${release.commit.slice(0, 12)}, siehe CHANGELOG [${release.version}]). `
        + `${plan ? `Plan: ${plan.summary}. ` : ''}Verfügbar; rollt Claude aus.`
    // 2.86 Punkt 5: no executor activates a release yet (host agent not wired for it),
    // so the proposal is a report entry, not a card whose Ja does nothing.
    return makeThought({
        source: 'self-update', kind: 'update-proposal', importance: 'normal', permission: 'selbst',
        title: `Xaventra ${release.version} verfügbar`, text,
        evidence: [
            `release ${release.tag}`, `releaseId ${release.releaseId}`, `commit ${release.commit}`,
            `publisher ${release.publisherKeyId} (gepinnt)`, ...release.artifacts.map(a => `${a.arch} ${a.sha256} ${a.image}`),
        ],
        proposal: { action: 'self-update.activate', params: { version: release.version, releaseId: release.releaseId, commit: release.commit, ...(plan ? { planHash: plan.planHash } : {}) } },
        dedupeKey: `self-update:${release.releaseId}`,
    }, now)
}

interface WatchState { proposed: Record<string, string>; rejected: Record<string, string> }

export interface SelfUpdateWatchDeps extends InspectOptions {
    sink: ThoughtSink
    statePath: string
    /** Optional: attach an activation plan (computed as data) to the proposal. */
    planFor?: (release: VerifiedRelease) => ProposalPlan | null
}

/** Debounced watcher: at most one thought per release id (and per rejection reason). */
export class SelfUpdateWatch {
    private running: Promise<{ inspection: ReleaseInspection; emitted: Thought | null }> | undefined
    constructor(private deps: SelfUpdateWatchDeps) {}

    tick(): Promise<{ inspection: ReleaseInspection; emitted: Thought | null }> {
        if (this.running) return this.running.then(result => ({ inspection: result.inspection, emitted: null }))
        this.running = this.run().finally(() => { this.running = undefined })
        return this.running
    }

    private async state(): Promise<WatchState> {
        try {
            const value = JSON.parse(await readFile(this.deps.statePath, 'utf8'))
            return { proposed: value?.proposed || {}, rejected: value?.rejected || {} }
        } catch { return { proposed: {}, rejected: {} } }
    }

    private async run(): Promise<{ inspection: ReleaseInspection; emitted: Thought | null }> {
        if (!this.deps.settings.enabled) return { inspection: { state: 'none', reason: 'autonomy.selfUpdate.enabled ist aus' }, emitted: null }
        const inspection = await inspectLatestRelease(this.deps)
        const now = (this.deps.now || Date.now)()
        const state = await this.state()
        let thought: Thought | null = null
        if (inspection.state === 'verified') {
            if (state.proposed[inspection.release.releaseId]) return { inspection, emitted: null }
            thought = createUpdateProposal(inspection.release, this.deps.planFor?.(inspection.release) || null, now)
            await this.deps.sink.emit(thought)
            state.proposed[inspection.release.releaseId] = thought.at
        } else if (inspection.state === 'rejected') {
            const key = `${inspection.version || '?'}|${inspection.reason}`
            if (state.rejected[key]) return { inspection, emitted: null }
            thought = makeThought({
                source: 'self-update', kind: 'update-rejected', importance: 'hoch', permission: 'selbst',
                title: inspection.version ? `Update ${inspection.version} nicht vorgeschlagen` : 'Update nicht vorgeschlagen',
                text: `Release ${inspection.version || 'unbekannt'} abgelehnt: ${inspection.reason}. Kein Download, keine Installation.`,
                evidence: [`grund ${inspection.reason}`], dedupeKey: `self-update-rejected:${key}`,
            }, now)
            await this.deps.sink.emit(thought)
            state.rejected[key] = thought.at
        } else return { inspection, emitted: null }
        await atomicWriteJson(this.deps.statePath, state)
        return { inspection, emitted: thought }
    }
}

let activeWatch: SelfUpdateWatch | null = null

/** True while the Release-Wächter runs; other release checks then defer to it (2.82.0). */
export function isSelfUpdateWatchRunning(): boolean { return activeWatch !== null }

/** Periodic read-only check. Returns null (no timer, no I/O) while disabled. */
export function startSelfUpdateWatch(deps: SelfUpdateWatchDeps): { watch: SelfUpdateWatch; stop: () => void } | null {
    if (!deps.settings.enabled) return null
    const watch = new SelfUpdateWatch(deps)
    activeWatch = watch
    const run = () => { watch.tick().catch(() => undefined) }
    const first = setTimeout(run, 60_000)
    const timer = setInterval(run, deps.settings.intervalMinutes * 60_000)
    first.unref?.(); timer.unref?.()
    return { watch, stop: () => { clearTimeout(first); clearInterval(timer); if (activeWatch === watch) activeWatch = null } }
}

// ---------------------------------------------------------------------------
// The one release lookup (2.82.0 Aufräumen „Release-Prüfungen bündeln“)
// ---------------------------------------------------------------------------

export type ReleaseTagState = 'veroeffentlicht' | 'entwurf' | 'fehlt' | 'unbekannt'
export interface ReleaseTagLookup { state: ReleaseTagState; status: number | null; publishedAt?: string; detail: string }

export const RELEASE_LOOKUP_MAX_AGE_MS = 10 * 60_000
const lookupCaches = new WeakMap<object, Map<string, { at: number; value: ReleaseTagLookup }>>()
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/**
 * Does release `tag` exist on GitHub (published, not a draft)? Delegation's
 * `release-tag` criterion and the auto-reminders' re-check of an unconfirmed
 * release both ask here: a published release is answered from one request for
 * 10 minutes (missing/draft is asked again — it may flip any minute). Signature
 * and content are judged only by the Release-Wächter above.
 */
export async function lookupReleaseTag(tag: string, options: { repo?: string; fetcher?: Fetch; maxAgeMs?: number; now?: () => number } = {}): Promise<ReleaseTagLookup> {
    const repo = options.repo && REPO_PATTERN.test(options.repo) ? options.repo : UPDATE_REPOSITORY
    const fetcher = options.fetcher || fetch
    const now = (options.now || Date.now)()
    let cache = lookupCaches.get(fetcher)
    if (!cache) { cache = new Map(); lookupCaches.set(fetcher, cache) }
    const key = `${repo}@${tag}`
    const hit = cache.get(key)
    if (hit && now - hit.at < (options.maxAgeMs ?? RELEASE_LOOKUP_MAX_AGE_MS)) return hit.value
    let value: ReleaseTagLookup
    try {
        const response = await fetcher(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(String(tag))}`, {
            method: 'GET', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'xaventra-release-watch' }, redirect: 'error',
        } as any)
        if (response.status === 404) value = { state: 'fehlt', status: 404, detail: `Release ${tag} gibt es nicht (GitHub 404)` }
        else if (!response.ok) value = { state: 'unbekannt', status: response.status, detail: `GitHub HTTP ${response.status}` }
        else {
            const body: any = await response.json()
            value = body?.draft === true
                ? { state: 'entwurf', status: response.status, detail: `Release ${tag} ist nur ein Entwurf` }
                : { state: 'veroeffentlicht', status: response.status, ...(body?.published_at ? { publishedAt: String(body.published_at) } : {}), detail: `Release ${tag} existiert${body?.published_at ? ` (veröffentlicht ${String(body.published_at).slice(0, 16)})` : ''}` }
        }
    } catch (error) {
        value = { state: 'unbekannt', status: null, detail: `GitHub nicht erreichbar: ${safeReason(error)}` }
    }
    // Only a published release is stable; "fehlt"/"Entwurf" may flip any minute, so they are asked again.
    if (value.state === 'veroeffentlicht') cache.set(key, { at: now, value })
    return value
}
