/**
 * Release-Knopf (Autonomie-Plan Phase 6a).
 *
 * Instead of Alfred typing `git push origin <sha>:refs/heads/main`, the Main
 * recognises a release candidate and asks with a Knopf-Karte:
 *
 *   candidate  = branch `claude/release-*` whose exact CI run (ci.yml, push,
 *                headSha AND headBranch) is completed and every job (>= 10)
 *                succeeded, is a pure fast-forward of main, has synchronized
 *                package.json/desktop versions above main, and whose tag
 *                `v<version>` and release do not exist yet.
 *   card       = kind `release-promote`, impact `extern` (never "Immer").
 *   Ja         = re-verify, then exactly one `workflow_dispatch` of
 *                `.github/workflows/promote-release.yml` (inputs: SHA, version)
 *                with the narrow token from XAVENTRA_RELEASE_DISPATCH_TOKEN.
 *                The workflow re-checks everything itself inside the protected
 *                environment `release-promotion` and pushes without force.
 *   no token   = nothing is dispatched; the card and the answer show the
 *                git command for Alfred instead.
 *   follow-up  = the promotion run is followed read-only and reported as a
 *                thought (+ Telegram text when the Main has authority).
 *
 * Fixed rules: GitHub is only READ (GET) except the single dispatch POST;
 * the repository and workflow names are constants; the token is read from the
 * environment at press time, sent only as Authorization header of that POST,
 * never logged, stored or put into a card/thought. Main only (a worker,
 * `NOVA_NODE_ONLY=true`, does nothing). Off until
 * `autonomy.releaseButton.enabled=true`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { getNovaDataDir } from './data-root.js'
import { compareUpdateVersions, UPDATE_REPOSITORY } from './github-update.js'
import {
    createApprovalCard, listApprovalCards, noteThought, registerCardExecutor, type ApprovalCard, type CardExecutor, type CardStoreOptions,
} from './approval-cards.js'

export const RELEASE_REPOSITORY = UPDATE_REPOSITORY
export const CANDIDATE_BRANCH_PREFIX = 'claude/release-'
export const PROMOTE_WORKFLOW = 'promote-release.yml'
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
export const RELEASE_ENVIRONMENT = 'release-promotion'
export const DISPATCH_TOKEN_ENV = 'XAVENTRA_RELEASE_DISPATCH_TOKEN'
/** The candidate CI has 10 jobs today (runbook 3.1 step 6); fewer means a different or broken run. */
export const MIN_CI_JOBS = 10
export const CARD_KIND = 'release-promote'

const API = 'https://api.github.com'
const SHA = /^[a-f0-9]{40}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/
const BRANCH = /^claude\/release-[A-Za-z0-9._-]{1,60}$/
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_CANDIDATES = 5
const DAY_MS = 24 * 60 * 60_000
type Fetch = typeof fetch

export interface ReleaseButtonSettings { enabled: boolean; intervalMinutes: number }

export function readReleaseButtonSettings(config: any): ReleaseButtonSettings {
    const raw = config?.autonomy?.releaseButton || {}
    const interval = Number(raw.intervalMinutes)
    return {
        enabled: raw.enabled === true,
        intervalMinutes: Number.isFinite(interval) ? Math.min(1440, Math.max(10, Math.round(interval))) : 30,
    }
}

export interface ReleaseButtonDeps {
    settings: () => ReleaseButtonSettings
    statePath: string
    cardStore?: CardStoreOptions
    fetcher?: Fetch
    env?: NodeJS.ProcessEnv
    now?: () => number
    /** Main + live Telegram authority (fence). Missing = assume allowed (tests). */
    hasAuthority?: () => Promise<boolean> | boolean
    /** Plain-text report to Alfred (Telegram). Thoughts are always written. */
    notify?: (text: string) => Promise<void>
    sleep?: (ms: number) => Promise<void>
    /** Default true; tests call trackPromotion directly. */
    trackInBackground?: boolean
    trackPollMs?: number
    trackMaxPolls?: number
}

export interface ReleaseCandidate {
    branch: string; sha: string; version: string; mainSha: string; mainVersion: string; aheadBy: number
    ciRunId: number; ciJobs: number; changelog: string
}
export type CandidateCheck =
    | { state: 'candidate'; candidate: ReleaseCandidate }
    | { state: 'pending'; branch: string; sha: string; reason: string }
    | { state: 'rejected'; branch: string; sha: string; reason: string; version?: string }

class Reject extends Error {}
class Pending extends Error {}

// ---------------------------------------------------------------------------
// GitHub (read-only)
// ---------------------------------------------------------------------------

const isWorker = (env: NodeJS.ProcessEnv) => String(env.NOVA_NODE_ONLY || '').toLowerCase() === 'true'
const short = (value: unknown, max = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const repoPath = (path: string) => `/repos/${RELEASE_REPOSITORY}${path}`

async function ghGet(deps: ReleaseButtonDeps, path: string): Promise<{ status: number; body: any }> {
    const fetcher = deps.fetcher || fetch
    const response = await fetcher(`${API}${repoPath(path)}`, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'xaventra-release-button' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) throw new Reject('GitHub-Antwort zu groß')
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { body = null }
    return { status: response.status, body }
}

async function ghJson(deps: ReleaseButtonDeps, path: string): Promise<any> {
    const result = await ghGet(deps, path)
    if (result.status !== 200 || !result.body) throw new Pending(`GitHub ${result.status} bei ${path.split('?')[0]}`)
    return result.body
}

async function readFileAt(deps: ReleaseButtonDeps, file: string, ref: string): Promise<string> {
    const body = await ghJson(deps, `/contents/${file}?ref=${ref}`)
    if (body.encoding !== 'base64' || typeof body.content !== 'string') throw new Reject(`${file} nicht lesbar`)
    return Buffer.from(body.content, 'base64').toString('utf8')
}

async function versionAt(deps: ReleaseButtonDeps, file: string, ref: string): Promise<string> {
    try { return String(JSON.parse(await readFileAt(deps, file, ref)).version || '') } catch (error) {
        if (error instanceof Pending) throw error
        throw new Reject(`${file} ungültig`)
    }
}

/** The CHANGELOG section `## [<version>]` as plain text (untrusted, shortened). */
export function changelogExcerpt(changelog: string, version: string, max = 500): string {
    const lines = changelog.split(/\r?\n/)
    const start = lines.findIndex(line => line.startsWith(`## [${version}]`))
    if (start < 0) return ''
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## ['))
    const text = short(lines.slice(start + 1, end < 0 ? undefined : end).join(' '), 4000)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function exactCandidateCi(deps: ReleaseButtonDeps, branch: string, sha: string): Promise<{ runId: number; jobs: number }> {
    const listing = await ghJson(deps, `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=50`)
    const runs = (Array.isArray(listing.workflow_runs) ? listing.workflow_runs : []).filter((run: any) =>
        run?.head_sha === sha && run?.head_branch === branch && run?.path === CI_WORKFLOW_PATH && run?.event === 'push'
        && run?.head_repository?.full_name === RELEASE_REPOSITORY)
    if (!runs.length) throw new Pending('noch kein exakter CI-Lauf für Commit und Zweig')
    const latest = runs.sort((a: any, b: any) => Number(b.id) - Number(a.id))[0]
    if (latest.status !== 'completed') throw new Pending(`CI-Lauf ${latest.id} läuft noch`)
    if (latest.conclusion !== 'success') throw new Reject(`CI-Lauf ${latest.id} ist ${short(latest.conclusion, 40) || 'nicht grün'}`)
    const jobs = await ghJson(deps, `/actions/runs/${Number(latest.id)}/jobs?per_page=100`)
    const list = Array.isArray(jobs.jobs) ? jobs.jobs : []
    if (list.length < MIN_CI_JOBS || Number(jobs.total_count) !== list.length) throw new Reject(`CI-Lauf ${latest.id}: ${list.length} Jobs statt mindestens ${MIN_CI_JOBS}`)
    const bad = list.find((job: any) => job?.conclusion !== 'success' || job?.head_sha !== sha)
    if (bad) throw new Reject(`CI-Lauf ${latest.id}: Job „${short(bad.name, 80)}“ ist ${short(bad.conclusion, 40) || 'nicht grün'}`)
    return { runId: Number(latest.id), jobs: list.length }
}

/** All checks for one candidate. Never writes anything. */
export async function checkCandidate(deps: ReleaseButtonDeps, branch: string, sha: string, mainSha: string): Promise<CandidateCheck> {
    let version: string | undefined
    try {
        if (!BRANCH.test(branch) || !SHA.test(sha) || !SHA.test(mainSha)) throw new Reject('Zweig oder Commit ungültig')
        const compare = await ghJson(deps, `/compare/${mainSha}...${sha}`)
        if (compare.status !== 'ahead' || Number(compare.behind_by) !== 0 || !(Number(compare.ahead_by) > 0)) {
            throw new Reject(`kein reiner Fast-Forward von main (${short(compare.status, 20)}, ${Number(compare.behind_by) || 0} zurück)`)
        }
        version = await versionAt(deps, 'package.json', sha)
        const desktop = await versionAt(deps, 'desktop/package.json', sha)
        if (!VERSION.test(version) || version !== desktop) throw new Reject(`Version nicht synchron (core ${short(version, 30)}, desktop ${short(desktop, 30)})`)
        const mainVersion = await versionAt(deps, 'package.json', mainSha)
        if (VERSION.test(mainVersion) && compareUpdateVersions(version, mainVersion) <= 0) throw new Reject(`Version ${version} ist nicht neuer als main ${mainVersion}`)
        const tag = await ghGet(deps, `/git/ref/tags/v${version}`)
        if (tag.status !== 404) throw tag.status === 200 ? new Reject(`Tag v${version} existiert bereits`) : new Pending(`Tag-Prüfung GitHub ${tag.status}`)
        const release = await ghGet(deps, `/releases/tags/v${version}`)
        if (release.status !== 404) throw release.status === 200 ? new Reject(`Release v${version} existiert bereits`) : new Pending(`Release-Prüfung GitHub ${release.status}`)
        const ci = await exactCandidateCi(deps, branch, sha)
        let changelog = ''
        try { changelog = changelogExcerpt(await readFileAt(deps, 'CHANGELOG.md', sha), version) } catch { changelog = '' }
        return {
            state: 'candidate',
            candidate: { branch, sha, version, mainSha, mainVersion, aheadBy: Number(compare.ahead_by), ciRunId: ci.runId, ciJobs: ci.jobs, changelog },
        }
    } catch (error) {
        if (error instanceof Reject) return { state: 'rejected', branch, sha, reason: error.message, version }
        return { state: 'pending', branch, sha, reason: error instanceof Pending ? error.message : 'GitHub nicht erreichbar' }
    }
}

async function mainHead(deps: ReleaseButtonDeps): Promise<string> {
    const ref = await ghJson(deps, '/git/ref/heads/main')
    const sha = String(ref?.object?.sha || '')
    if (!SHA.test(sha)) throw new Pending('main nicht lesbar')
    return sha
}

async function candidateRefs(deps: ReleaseButtonDeps): Promise<Array<{ branch: string; sha: string }>> {
    const refs = await ghJson(deps, `/git/matching-refs/heads/${CANDIDATE_BRANCH_PREFIX}`)
    return (Array.isArray(refs) ? refs : []).flatMap((ref: any) => {
        const branch = String(ref?.ref || '').replace(/^refs\/heads\//, '')
        const sha = String(ref?.object?.sha || '')
        return ref?.object?.type === 'commit' && BRANCH.test(branch) && SHA.test(sha) ? [{ branch, sha }] : []
    }).slice(0, MAX_CANDIDATES)
}

// ---------------------------------------------------------------------------
// state (debounce per SHA)
// ---------------------------------------------------------------------------

interface DispatchRecord { at: string; version: string; runId?: number; result?: string }
interface WatchState { carded: Record<string, string>; noted: Record<string, string>; dispatched: Record<string, DispatchRecord> }

function loadState(path: string): WatchState {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        return { carded: raw?.carded || {}, noted: raw?.noted || {}, dispatched: raw?.dispatched || {} }
    } catch { return { carded: {}, noted: {}, dispatched: {} } }
}

function saveState(path: string, state: WatchState): void {
    const trim = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).slice(-200))
    atomicWriteJsonSync(path, { carded: trim(state.carded), noted: trim(state.noted), dispatched: trim(state.dispatched) })
}

// ---------------------------------------------------------------------------
// card
// ---------------------------------------------------------------------------

export function pushCommand(sha: string): string {
    return `git push origin ${sha}:refs/heads/main`
}

const hasToken = (env: NodeJS.ProcessEnv) => {
    const value = String(env[DISPATCH_TOKEN_ENV] || '')
    return value.length > 0 && value.length <= 512 && !/\s/.test(value)
}

export function createReleaseCard(candidate: ReleaseCandidate, deps: Pick<ReleaseButtonDeps, 'env' | 'cardStore'>): ReturnType<typeof createApprovalCard> {
    const env = deps.env || process.env
    const sha12 = candidate.sha.slice(0, 12)
    const tokenNote = hasToken(env) ? '' : ` Token fehlt (${DISPATCH_TOKEN_ENV}) — ich kann nichts auslösen. Befehl zum Selbstausführen: ${pushCommand(candidate.sha)}`
    return createApprovalCard({
        art: 'release',
        titel: `Release ${candidate.version} bereit`,
        beleg: `Commit ${sha12} auf ${candidate.branch}, CI-Lauf ${candidate.ciRunId} grün (${candidate.ciJobs} Jobs, exakter Commit und Zweig), `
            + `Fast-Forward von main ${candidate.mainSha.slice(0, 12)} (${candidate.mainVersion}, +${candidate.aheadBy} Commits), Tag v${candidate.version} existiert nicht. `
            + `Änderungen: ${candidate.changelog || 'kein CHANGELOG-Abschnitt gefunden'}`,
        vorschlag: `Main per Fast-Forward auf ${sha12} setzen: Workflow ${PROMOTE_WORKFLOW} prüft alles erneut in der Environment ${RELEASE_ENVIRONMENT} und pusht ohne Force. Freigeben?${tokenNote}`,
        aktion: { kind: CARD_KIND, ref: `${candidate.version}@${candidate.sha}` },
        wirkung: 'extern',
        dedupeKey: `release:${candidate.sha}`,
        quelle: 'release',
        ablaufMs: DAY_MS,
    }, deps.cardStore || {})
}

function lastCardExpired(sha: string, store: CardStoreOptions): boolean {
    const last = listApprovalCards(store).filter(card => card.dedupeKey === `release:${sha}`).at(-1)
    return last?.status === 'abgelaufen'
}

export interface WatchResult { created: ApprovalCard[]; rejected: Array<{ sha: string; reason: string }>; skipped?: string }

/** One read-only pass. Creates at most one card per SHA and one thought per (SHA, reason). */
export async function releaseButtonTick(deps: ReleaseButtonDeps): Promise<WatchResult> {
    const env = deps.env || process.env
    if (!deps.settings().enabled) return { created: [], rejected: [], skipped: 'autonomy.releaseButton.enabled ist aus' }
    if (isWorker(env)) return { created: [], rejected: [], skipped: 'Worker' }
    if (deps.hasAuthority && !(await deps.hasAuthority())) return { created: [], rejected: [], skipped: 'keine Main-/Telegram-Autorität' }
    const state = loadState(deps.statePath)
    const result: WatchResult = { created: [], rejected: [] }
    let changed = false
    let refs: Array<{ branch: string; sha: string }>
    let main: string
    try {
        refs = await candidateRefs(deps)
        if (!refs.length) return result
        main = await mainHead(deps)
    } catch { return { ...result, skipped: 'GitHub nicht lesbar' } }
    const now = new Date((deps.now || Date.now)()).toISOString()
    for (const ref of refs) {
        if (state.dispatched[ref.sha]) continue
        // One card per SHA; only an unanswered, expired card may be asked again (never after Nein).
        if (state.carded[ref.sha] && !lastCardExpired(ref.sha, deps.cardStore || {})) continue
        const check = await checkCandidate(deps, ref.branch, ref.sha, main)
        if (check.state === 'candidate') {
            const card = createReleaseCard(check.candidate, deps)
            if (card.ok === true) {
                state.carded[ref.sha] = now
                changed = true
                if (card.created) result.created.push(card.card)
            }
        } else if (check.state === 'rejected') {
            result.rejected.push({ sha: ref.sha, reason: check.reason })
            const key = `${ref.sha}|${check.reason}`
            if (!state.noted[key]) {
                noteThought({ quelle: 'release', titel: `Release-Kandidat ${ref.sha.slice(0, 12)} (${ref.branch}) nicht vorgeschlagen`, status: 'verworfen', text: `${check.reason} — keine Karte.` }, deps.cardStore || {})
                state.noted[key] = now
                changed = true
            }
        }
    }
    if (changed) saveState(deps.statePath, state)
    return result
}

// ---------------------------------------------------------------------------
// executor: Ja -> exactly one workflow_dispatch
// ---------------------------------------------------------------------------

function parseRef(ref: string): { version: string; sha: string } | null {
    const match = /^([0-9][0-9A-Za-z.-]{0,40})@([a-f0-9]{40})$/.exec(String(ref || ''))
    return match && VERSION.test(match[1]) ? { version: match[1], sha: match[2] } : null
}

async function report(deps: ReleaseButtonDeps, titel: string, status: string, text: string): Promise<void> {
    noteThought({ quelle: 'release', titel, status, text }, deps.cardStore || {})
    try { await deps.notify?.(`${titel}\n${text}`) } catch { /* the thought is the record */ }
}

/** Promotion run created by our dispatch: the run-name carries version and SHA. */
async function findPromotionRun(deps: ReleaseButtonDeps, sha: string, notBefore: number): Promise<any | null> {
    const listing = await ghJson(deps, `/actions/workflows/${PROMOTE_WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=20`)
    const runs = (Array.isArray(listing.workflow_runs) ? listing.workflow_runs : []).filter((run: any) =>
        run?.path === `.github/workflows/${PROMOTE_WORKFLOW}` && run?.head_branch === 'main' && run?.event === 'workflow_dispatch'
        && String(run?.display_title || '').includes(sha) && Date.parse(String(run?.created_at)) >= notBefore - 120_000)
    return runs.sort((a: any, b: any) => Number(b.id) - Number(a.id))[0] || null
}

async function failureReason(deps: ReleaseButtonDeps, runId: number): Promise<string> {
    try {
        const jobs = await ghJson(deps, `/actions/runs/${runId}/jobs?per_page=50`)
        const job = (jobs.jobs || []).find((item: any) => item?.conclusion && item.conclusion !== 'success' && item.conclusion !== 'skipped')
        if (!job) return 'kein fehlgeschlagener Schritt gemeldet'
        const step = (job.steps || []).find((item: any) => item?.conclusion === 'failure')
        return `Job „${short(job.name, 60)}“${step ? `, Schritt „${short(step.name, 100)}“` : ''} (${short(job.conclusion, 20)})`
    } catch { return 'Grund nicht lesbar' }
}

export type PromotionOutcome = 'erfolgreich' | 'abgebrochen' | 'nicht-gefunden' | 'zeitueberschreitung'

/** Follow the dispatched run read-only and report läuft / erfolgreich / abgebrochen. */
export async function trackPromotion(deps: ReleaseButtonDeps, sha: string, version: string, dispatchedAt: number): Promise<PromotionOutcome> {
    const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()))
    const pollMs = deps.trackPollMs ?? 30_000
    const maxPolls = deps.trackMaxPolls ?? 90
    const titel = `Release ${version}`
    let run: any = null
    let announced = false
    for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) await sleep(pollMs)
        try {
            if (!run) run = await findPromotionRun(deps, sha, dispatchedAt)
            else run = (await ghJson(deps, `/actions/runs/${Number(run.id)}`)) || run
        } catch { continue }
        if (!run) { if (poll >= 10) break; continue }
        if (!announced) {
            announced = true
            await report(deps, titel, 'läuft', `Promotion-Lauf ${run.id} gestartet (${PROMOTE_WORKFLOW}, Commit ${sha.slice(0, 12)}).`)
        }
        if (run.status !== 'completed') continue
        const state = loadState(deps.statePath)
        if (run.conclusion === 'success') {
            if (state.dispatched[sha]) { state.dispatched[sha] = { ...state.dispatched[sha], runId: Number(run.id), result: 'erfolgreich' }; saveState(deps.statePath, state) }
            await report(deps, titel, 'erfolgreich', `Main steht auf ${sha.slice(0, 12)} (Lauf ${run.id}). Main-CI und Signierung starten wie bei einem normalen Push (Deploy-Key).`)
            return 'erfolgreich'
        }
        const reason = await failureReason(deps, Number(run.id))
        if (state.dispatched[sha]) { state.dispatched[sha] = { ...state.dispatched[sha], runId: Number(run.id), result: 'abgebrochen' }; saveState(deps.statePath, state) }
        await report(deps, titel, 'abgebrochen', `Promotion-Lauf ${run.id} ${short(run.conclusion, 20)}: ${reason}. Main unverändert, sofern der Push-Schritt nicht erreicht wurde.`)
        return 'abgebrochen'
    }
    if (!run) {
        await report(deps, titel, 'unklar', `Kein Promotion-Lauf für ${sha.slice(0, 12)} gefunden. Bitte unter Actions → ${PROMOTE_WORKFLOW} nachsehen; ich löse nichts erneut aus.`)
        return 'nicht-gefunden'
    }
    await report(deps, titel, 'unklar', `Promotion-Lauf ${run.id} nach Ablauf der Beobachtung noch nicht fertig; ich löse nichts erneut aus.`)
    return 'zeitueberschreitung'
}

async function verifyForDispatch(deps: ReleaseButtonDeps, sha: string, version: string): Promise<CandidateCheck> {
    const refs = await candidateRefs(deps)
    const ref = refs.find(item => item.sha === sha)
    if (!ref) return { state: 'rejected', branch: '', sha, reason: 'kein claude/release-*-Zweig zeigt mehr auf diesen Commit' }
    const check = await checkCandidate(deps, ref.branch, sha, await mainHead(deps))
    if (check.state === 'candidate' && check.candidate.version !== version) return { state: 'rejected', branch: ref.branch, sha, reason: `Version jetzt ${check.candidate.version} statt ${version}` }
    return check
}

export function createReleasePromoteExecutor(deps: ReleaseButtonDeps): CardExecutor {
    return {
        kind: CARD_KIND,
        impact: 'extern',
        allowAlways: () => false,
        async execute(card, answer) {
            const env = deps.env || process.env
            if (answer !== 'ja') return { ok: false, message: '„Immer erlauben“ gibt es für Releases nicht — nichts ausgelöst.' }
            if (isWorker(env)) return { ok: false, message: 'Worker lösen keine Releases aus.' }
            if (!deps.settings().enabled) return { ok: false, message: 'Release-Knopf ist ausgeschaltet (autonomy.releaseButton.enabled) — nichts ausgelöst.' }
            const target = parseRef(card.aktion.ref)
            if (!target) return { ok: false, message: 'Karte ohne gültigen Commit/Version — nichts ausgelöst.' }
            const state = loadState(deps.statePath)
            if (state.dispatched[target.sha]) return { ok: false, message: `Für ${target.sha.slice(0, 12)} wurde bereits ausgelöst (${state.dispatched[target.sha].at}) — kein zweites Mal.` }
            if (!hasToken(env)) {
                return { ok: false, message: `Token fehlt (${DISPATCH_TOKEN_ENV}) — nichts ausgelöst. Befehl zum Selbstausführen: ${pushCommand(target.sha)}` }
            }
            let check: CandidateCheck
            try { check = await verifyForDispatch(deps, target.sha, target.version) } catch { check = { state: 'pending', branch: '', sha: target.sha, reason: 'GitHub nicht lesbar' } }
            if (check.state !== 'candidate') return { ok: false, message: `Erneute Prüfung nicht bestanden: ${check.reason} — nichts ausgelöst.` }
            const fetcher = deps.fetcher || fetch
            const dispatchedAt = (deps.now || Date.now)()
            let status = 0
            try {
                const response = await fetcher(`${API}${repoPath(`/actions/workflows/${PROMOTE_WORKFLOW}/dispatches`)}`, {
                    method: 'POST',
                    headers: {
                        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'xaventra-release-button',
                        'content-type': 'application/json', authorization: `Bearer ${String(env[DISPATCH_TOKEN_ENV])}`,
                    },
                    body: JSON.stringify({ ref: 'main', inputs: { candidate_sha: target.sha, version: target.version } }),
                    redirect: 'error',
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                })
                status = response.status
                await response.text().catch(() => '')
            } catch {
                // Unknown outcome: record it so nothing is ever dispatched twice for this SHA.
                state.dispatched[target.sha] = { at: new Date(dispatchedAt).toISOString(), version: target.version, result: 'unklar' }
                saveState(deps.statePath, state)
                return { ok: false, message: `Auslösen ohne Antwort (Netz/Zeitlimit) — Ergebnis unklar, ich wiederhole nicht. Unter Actions → ${PROMOTE_WORKFLOW} nachsehen.` }
            }
            if (status !== 204 && status !== 200) {
                return { ok: false, message: `GitHub hat das Auslösen abgelehnt (HTTP ${status}) — nichts ausgelöst. Token-Berechtigung (Actions: write nur auf ${RELEASE_REPOSITORY}) prüfen.` }
            }
            state.dispatched[target.sha] = { at: new Date(dispatchedAt).toISOString(), version: target.version }
            saveState(deps.statePath, state)
            if (deps.trackInBackground !== false) void trackPromotion(deps, target.sha, target.version, dispatchedAt).catch(() => undefined)
            return { ok: true, message: `Ausgelöst: ${PROMOTE_WORKFLOW} für ${target.version} @ ${target.sha.slice(0, 12)} (Environment ${RELEASE_ENVIRONMENT}). Ich melde das Ergebnis.` }
        },
        async reject() {
            return { ok: true, message: 'Abgelehnt — nichts ausgelöst.' }
        },
    }
}

// ---------------------------------------------------------------------------
// production wiring
// ---------------------------------------------------------------------------

let currentSettings: ReleaseButtonSettings = { enabled: false, intervalMinutes: 30 }
let timer: ReturnType<typeof setInterval> | null = null
let executorRegistered = false

function productionDeps(): ReleaseButtonDeps {
    const telegram = async () => {
        try { const { getTelegramAdapter } = await import('../channels/telegram.js'); return getTelegramAdapter() } catch { return null }
    }
    return {
        settings: () => currentSettings,
        statePath: join(getNovaDataDir(), 'release-button.json'),
        async hasAuthority() { const tg = await telegram(); return Boolean(tg && await tg.hasCardAuthority()) },
        async notify(text) {
            const tg = await telegram()
            if (!tg || !(await tg.hasCardAuthority())) return
            for (const chatId of tg.getOwnerChatIds().slice(0, 3)) await tg.sendApprovalCard(chatId, text, [])
        },
    }
}

/** Registered with the other card executors (idempotent). Refuses while disabled. */
export function registerReleaseButtonExecutor(deps: ReleaseButtonDeps = productionDeps()): void {
    if (executorRegistered) return
    registerCardExecutor(createReleasePromoteExecutor(deps))
    executorRegistered = true
}

/** Main only, off by default. Returns whether the watcher runs. */
export function startReleaseButton(config: any, env: NodeJS.ProcessEnv = process.env): { started: boolean; reason: string } {
    currentSettings = readReleaseButtonSettings(config)
    if (!currentSettings.enabled) return { started: false, reason: 'autonomy.releaseButton.enabled ist aus' }
    if (isWorker(env)) return { started: false, reason: 'Worker' }
    if (timer) return { started: true, reason: 'läuft bereits' }
    const deps = productionDeps()
    registerReleaseButtonExecutor(deps)
    const run = () => { void releaseButtonTick(deps).catch(() => undefined) }
    const first = setTimeout(run, 90_000)
    first.unref?.()
    timer = setInterval(run, currentSettings.intervalMinutes * 60_000)
    timer.unref?.()
    return { started: true, reason: `alle ${currentSettings.intervalMinutes} min, Token ${hasToken(env) ? 'vorhanden' : 'fehlt'}` }
}

export function stopReleaseButton(): void {
    if (timer) clearInterval(timer)
    timer = null
}
