import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const path = fileURLToPath(new URL('../../.github/workflows/promote-release.yml', import.meta.url))
const text = readFileSync(path, 'utf8')
const workflow = parse(text)
const jobs = workflow.jobs as Record<string, any>
const steps = (job: string) => (jobs[job]?.steps || []) as any[]
const allSteps = Object.keys(jobs).flatMap(steps)
const scripts = allSteps.map(step => `${step.run || ''}\n${step.with?.script || ''}`).join('\n')

describe('promote-release.yml (statisch)', () => {
    it('wird nur per workflow_dispatch mit SHA und Version ausgelöst', () => {
        expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
        const inputs = workflow.on.workflow_dispatch.inputs
        expect(inputs.candidate_sha.required).toBe(true)
        expect(inputs.version.required).toBe(true)
        expect(String(workflow['run-name'])).toContain('inputs.candidate_sha')
    })

    it('hat minimale Berechtigungen: global keine, contents: write nur im Push-Job', () => {
        expect(workflow.permissions).toEqual({})
        for (const [name, job] of Object.entries(jobs)) {
            const perms = job.permissions || {}
            for (const [scope, level] of Object.entries(perms)) {
                if (level === 'write') expect(`${name}:${scope}`).toBe('promote:contents')
                else expect(['read', 'none']).toContain(level)
            }
            expect(Object.keys(perms).sort()).toEqual(name === 'promote' ? ['actions', 'contents'] : ['actions', 'contents'])
        }
        expect(jobs.promote.permissions).toEqual({ contents: 'write', actions: 'read' })
        expect(jobs.verify.permissions).toEqual({ contents: 'read', actions: 'read' })
    })

    it('Push-Job läuft in der geschützten Environment release-promotion und braucht verify', () => {
        const env = jobs.promote.environment
        expect(typeof env === 'string' ? env : env?.name).toBe('release-promotion')
        expect([jobs.promote.needs].flat()).toContain('verify')
    })

    it('kein Force, kein Überschreiben; Push genau SHA → refs/heads/main', () => {
        expect(text).not.toMatch(/--force|force-with-lease|\s-f\s|\+refs\/|\+\$|--mirror|--delete|reset --hard/)
        const pushes = scripts.split('\n').filter(line => /git push/.test(line))
        expect(pushes).toHaveLength(1)
        expect(pushes[0].trim()).toBe('git push origin "$CANDIDATE_SHA:refs/heads/main"')
        expect(steps('verify').some(step => step.with && step.with['persist-credentials'] === false)).toBe(true)
    })

    it('nutzt keine Secrets außer GITHUB_TOKEN', () => {
        const secrets = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(match => match[1])
        expect(secrets.every(name => name === 'GITHUB_TOKEN')).toBe(true)
    })

    it('Eingaben gelangen nie direkt in Skripte (nur über env)', () => {
        expect(scripts).not.toMatch(/\$\{\{\s*(inputs|github\.event)\./)
    })

    it('enthält alle Prüfschritte', () => {
        // only main's workflow definition may promote
        expect(scripts).toMatch(/refs\/heads\/main/)
        // input shape
        expect(scripts).toMatch(/\[a-f0-9\]\{40\}/)
        // fast-forward: GitHub compare + local ancestry in both jobs
        expect(scripts).toMatch(/compareCommits/)
        expect(scripts).toMatch(/behind_by/)
        expect((scripts.match(/merge-base --is-ancestor/g) || []).length).toBeGreaterThanOrEqual(2)
        // exact candidate CI: headSha AND headBranch, all jobs
        expect(scripts).toMatch(/\.github\/workflows\/ci\.yml/)
        expect(scripts).toMatch(/head_sha\s*!==\s*sha/)
        expect(scripts).toMatch(/head_branch/)
        expect(scripts).toMatch(/claude\/release-/)
        expect(scripts).toMatch(/listJobsForWorkflowRun/)
        expect(scripts).toMatch(/MIN_JOBS\s*=\s*10/)
        // synchronized version + tag/release must not exist
        expect(scripts).toMatch(/desktop\/package\.json/)
        expect(scripts).toMatch(/tags\/v\$\{version\}/)
        expect(scripts).toMatch(/getReleaseByTag/)
        // main must not move between verification and push
        expect(steps('promote').map(step => step.run || '').join('\n')).toMatch(/VERIFIED_MAIN/)
        // gitleaks over origin/main..SHA with pinned checksum
        const leaks = steps('verify').map(step => step.run || '').join('\n')
        expect(leaks).toMatch(/gitleaks_8\.30\.1_linux_x64\.tar\.gz/)
        expect(leaks).toMatch(/551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/)
        expect(leaks).toMatch(/sha256sum -c/)
        expect(leaks).toMatch(/origin\/main\.\.\$CANDIDATE_SHA/)
        // readback after push
        expect(steps('promote').map(step => step.run || '').join('\n')).toMatch(/ls-remote/)
    })

    it('Aktionen sind auf Hauptversionen wie im Repo üblich gebunden, keine fremden Aktionen', () => {
        const uses = allSteps.map(step => step.uses).filter(Boolean)
        for (const name of uses) expect(name).toMatch(/^actions\/(checkout|github-script)@v\d+$/)
    })

    it('läuft nie parallel (eine Promotion zur Zeit, nichts wird abgebrochen)', () => {
        expect(workflow.concurrency).toEqual({ group: 'promote-release', 'cancel-in-progress': false })
    })
})

describe('promote-release.yml Prüfskript (ausgeführt gegen gemockte GitHub-API)', () => {
    const SHA = 'b'.repeat(40), MAIN = 'a'.repeat(40), BRANCH = 'claude/release-2.82.0', REPO = { owner: 'samuelvoltarius', repo: 'xaventra' }
    const gate = steps('verify').find(step => step.id === 'gate')
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor
    const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })
    const file = (value: unknown) => ({ data: { content: Buffer.from(JSON.stringify(value)).toString('base64') } })

    function api(over: Record<string, any> = {}) {
        const o = {
            ref: 'refs/heads/main', compare: { status: 'ahead', ahead_by: 2, behind_by: 0 },
            refs: [{ ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: SHA } }],
            runs: [{ id: 7, head_sha: SHA, head_branch: BRANCH, path: '.github/workflows/ci.yml', event: 'push', head_repository: { full_name: 'samuelvoltarius/xaventra' }, status: 'completed', conclusion: 'success' }],
            jobs: Array.from({ length: 10 }, (_, i) => ({ name: `j${i}`, conclusion: 'success', head_sha: SHA })),
            core: '2.82.0', desktop: '2.82.0', main: '2.81.0', tag: false, release: false, ...over,
        }
        const outputs: Record<string, string> = {}
        const github = {
            paginate: async () => o.jobs,
            rest: {
                repos: {
                    getBranch: async () => ({ data: { commit: { sha: MAIN } } }),
                    compareCommits: async () => ({ data: o.compare }),
                    getContent: async ({ path, ref }: any) => file({ version: path === 'desktop/package.json' ? o.desktop : ref === MAIN ? o.main : o.core }),
                    getReleaseByTag: async () => { if (o.release) return { data: {} }; throw notFound() },
                },
                git: {
                    listMatchingRefs: async () => ({ data: o.refs }),
                    getRef: async () => { if (o.tag) return { data: {} }; throw notFound() },
                },
                actions: {
                    listWorkflowRuns: async () => ({ data: { workflow_runs: o.runs } }),
                    listJobsForWorkflowRun: async () => ({ data: { jobs: o.jobs } }),
                },
            },
        }
        const context = { repo: REPO, ref: o.ref, eventName: 'workflow_dispatch' }
        const core = { setOutput: (k: string, v: string) => { outputs[k] = v }, summary: { addRaw: () => ({ write: async () => undefined }) } }
        return { github, context, core, outputs }
    }

    async function runGate(over: Record<string, any> = {}, env: Record<string, string> = { CANDIDATE_SHA: SHA, CANDIDATE_VERSION: '2.82.0' }) {
        const { github, context, core, outputs } = api(over)
        const saved = { ...process.env }
        Object.assign(process.env, env)
        try {
            await new AsyncFunction('github', 'context', 'core', gate.with.script)(github, context, core)
        } finally {
            for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
        }
        return outputs
    }

    it('grüner Kandidat: Ausgaben main_sha, branch, ci_run', async () => {
        expect(await runGate()).toEqual({ main_sha: MAIN, branch: BRANCH, ci_run: '7' })
    })

    const refusals: Array<[string, Record<string, any>, RegExp, Record<string, string>?]> = [
        ['nicht von main ausgelöst', { ref: 'refs/heads/claude/x' }, /dispatched from main/],
        ['SHA ungültig', {}, /40-hex/, { CANDIDATE_SHA: 'main', CANDIDATE_VERSION: '2.82.0' }],
        ['nicht Fast-Forward', { compare: { status: 'diverged', ahead_by: 2, behind_by: 1 } }, /fast-forward/],
        ['nicht Fast-Forward (nur Status verrät es)', { compare: { status: 'diverged', ahead_by: 2, behind_by: 0 } }, /fast-forward/],
        ['kein Kandidaten-Zweig', { refs: [] }, /claude\/release-/],
        ['CI auf anderem Zweig', { runs: [{ id: 7, head_sha: SHA, head_branch: 'claude/other', path: '.github/workflows/ci.yml', event: 'push', head_repository: { full_name: 'samuelvoltarius/xaventra' }, status: 'completed', conclusion: 'success' }] }, /No exact candidate CI/],
        ['neuester CI-Lauf rot', { runs: [
            { id: 7, head_sha: SHA, head_branch: BRANCH, path: '.github/workflows/ci.yml', event: 'push', head_repository: { full_name: 'samuelvoltarius/xaventra' }, status: 'completed', conclusion: 'success' },
            { id: 8, head_sha: SHA, head_branch: BRANCH, path: '.github/workflows/ci.yml', event: 'push', head_repository: { full_name: 'samuelvoltarius/xaventra' }, status: 'completed', conclusion: 'failure' },
        ] }, /run 8/],
        ['ein Job rot', { jobs: Array.from({ length: 10 }, (_, i) => ({ name: `j${i}`, conclusion: i === 4 ? 'failure' : 'success', head_sha: SHA })) }, /j4/],
        ['zu wenige Jobs', { jobs: [{ name: 'j', conclusion: 'success', head_sha: SHA }] }, /at least 10/],
        ['Version nicht synchron', { desktop: '2.81.0' }, /not synchronized/],
        ['Version nicht neuer', { main: '2.82.0' }, /not newer/],
        ['rc nicht neuer als finale Version', { core: '2.82.0-rc.1', desktop: '2.82.0-rc.1', main: '2.82.0' }, /not newer/, { CANDIDATE_SHA: SHA, CANDIDATE_VERSION: '2.82.0-rc.1' }],
        ['Tag existiert', { tag: true }, /Tag v2.82.0 already exists/],
        ['Release existiert', { release: true }, /Release v2.82.0 already exists/],
    ]
    for (const [name, over, reason, env] of refusals) {
        it(`bricht ab: ${name}`, async () => {
            await expect(runGate(over, env)).rejects.toThrow(reason)
        })
    }
})
