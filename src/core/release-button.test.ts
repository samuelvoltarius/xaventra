import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    answerApprovalCard, cardKeyboard, listApprovalCards, maintainApprovalCards, readThoughts, unregisterCardExecutor,
} from './approval-cards.js'
import {
    CARD_KIND, DISPATCH_TOKEN_ENV, createReleasePromoteExecutor, pushCommand, readReleaseButtonSettings,
    releaseButtonTick, trackPromotion, type ReleaseButtonDeps,
} from './release-button.js'
import { registerCardExecutor } from './approval-cards.js'

const REPO = 'samuelvoltarius/xaventra'
const MAIN = 'a'.repeat(40)
const CAND = 'b'.repeat(40)
const BRANCH = 'claude/release-2.82.0'
const OWNER = '1000001'
const STRANGER = '1000002'
// Not key-like on purpose (repo rule: no key-like literals in tests).
const TOKEN_VALUE = 'release-dispatch-test-value-7'

type Route = { status: number; body?: any }
interface Scenario { routes: Record<string, Route>; calls: Array<{ method: string; url: string; init: any }> }

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')
const file = (value: unknown): Route => ({ status: 200, body: { encoding: 'base64', content: b64(value) } })

function ciRun(over: Record<string, unknown> = {}) {
    return {
        id: 111, head_sha: CAND, head_branch: BRANCH, event: 'push', path: '.github/workflows/ci.yml',
        status: 'completed', conclusion: 'success', head_repository: { full_name: REPO }, ...over,
    }
}
const jobs = (count = 10, over: Record<string, unknown> = {}) => ({
    total_count: count,
    jobs: Array.from({ length: count }, (_, index) => ({ name: `job-${index}`, conclusion: 'success', head_sha: CAND, ...(index === 3 ? over : {}) })),
})

function scenario(): Scenario {
    return {
        calls: [],
        routes: {
            [`/git/matching-refs/heads/claude/release-`]: { status: 200, body: [{ ref: `refs/heads/${BRANCH}`, object: { sha: CAND, type: 'commit' } }] },
            ['/git/ref/heads/main']: { status: 200, body: { object: { sha: MAIN, type: 'commit' } } },
            [`/compare/${MAIN}...${CAND}`]: { status: 200, body: { status: 'ahead', ahead_by: 3, behind_by: 0 } },
            [`/contents/package.json?ref=${CAND}`]: file({ version: '2.82.0' }),
            [`/contents/desktop/package.json?ref=${CAND}`]: file({ version: '2.82.0' }),
            [`/contents/package.json?ref=${MAIN}`]: file({ version: '2.81.0' }),
            [`/contents/CHANGELOG.md?ref=${CAND}`]: file('# Changelog\n\n## [2.82.0] — 2026-10-02\n\n- Release-Knopf in Telegram.\n\n## [2.81.0]\n\n- alt\n'),
            ['/git/ref/tags/v2.82.0']: { status: 404, body: { message: 'Not Found' } },
            ['/releases/tags/v2.82.0']: { status: 404, body: { message: 'Not Found' } },
            [`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`]: { status: 200, body: { workflow_runs: [ciRun()] } },
            ['/actions/runs/111/jobs?per_page=100']: { status: 200, body: jobs() },
            ['/actions/workflows/promote-release.yml/dispatches']: { status: 204 },
        },
    }
}

function fetcherFor(s: Scenario): typeof fetch {
    return (async (input: any, init: any = {}) => {
        const url = String(input)
        s.calls.push({ method: String(init.method || 'GET'), url, init })
        const prefix = `https://api.github.com/repos/${REPO}`
        if (!url.startsWith(prefix)) return new Response('{}', { status: 599 })
        const route = s.routes[url.slice(prefix.length)]
        if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        return new Response(route.status === 204 ? null : JSON.stringify(route.body ?? {}), { status: route.status })
    }) as typeof fetch
}

let dir: string
let s: Scenario
let env: NodeJS.ProcessEnv
let enabled: boolean
const posts = () => s.calls.filter(call => call.method === 'POST')

function deps(over: Partial<ReleaseButtonDeps> = {}): ReleaseButtonDeps {
    return {
        settings: () => ({ enabled, intervalMinutes: 30 }),
        statePath: join(dir, 'release-button.json'),
        cardStore: { dataDir: dir, ledger: null },
        fetcher: fetcherFor(s),
        env,
        trackInBackground: false,
        ...over,
    }
}

async function tickCards() {
    const result = await releaseButtonTick(deps())
    return { result, cards: listApprovalCards({ dataDir: dir }) }
}

async function press(card: any, answer: string, userId = OWNER) {
    const button = card.buttons.find((item: any) => item.answer === answer)
    return answerApprovalCard(`ac:${button.token}`, { userId, ownerIds: [OWNER] }, { dataDir: dir, ledger: null })
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'release-button-'))
    s = scenario()
    env = { [DISPATCH_TOKEN_ENV]: TOKEN_VALUE }
    enabled = true
    registerCardExecutor(createReleasePromoteExecutor(deps()))
})

afterEach(() => {
    unregisterCardExecutor(CARD_KIND)
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
})

describe('Release-Knopf: Standard und Grenzen', () => {
    it('P8: ohne Konfiguration am Main an, am Worker aus; mit enabled:false aus und liest dann nichts', async () => {
        expect(readReleaseButtonSettings({}, {} as NodeJS.ProcessEnv).enabled).toBe(true)
        expect(readReleaseButtonSettings({}, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv).enabled).toBe(false)
        expect(readReleaseButtonSettings({ autonomy: { releaseButton: { enabled: false } } }, {} as NodeJS.ProcessEnv).enabled).toBe(false)
        expect(readReleaseButtonSettings({ autonomy: { releaseButton: { enabled: true } } }, {} as NodeJS.ProcessEnv).enabled).toBe(true)
        enabled = false
        const { result, cards } = await tickCards()
        expect(result.skipped).toMatch(/aus/)
        expect(cards).toHaveLength(0)
        expect(s.calls).toHaveLength(0)
    })

    it('Worker tun nichts: keine Abfrage, keine Karte, kein Auslösen', async () => {
        env.NOVA_NODE_ONLY = 'true'
        const { result, cards } = await tickCards()
        expect(result.skipped).toBe('Worker')
        expect(cards).toHaveLength(0)
        expect(s.calls).toHaveLength(0)
        const executor = createReleasePromoteExecutor(deps())
        const outcome = await executor.execute({ aktion: { kind: CARD_KIND, ref: `2.82.0@${CAND}` } } as any, 'ja', { decidedBy: 'telegram:1', userId: '1' })
        expect(outcome.ok).toBe(false)
        expect(posts()).toHaveLength(0)
    })

    it('ohne Main-/Telegram-Autorität keine Karte', async () => {
        const result = await releaseButtonTick(deps({ hasAuthority: () => false }))
        expect(result.skipped).toMatch(/Autorität/)
        expect(listApprovalCards({ dataDir: dir })).toHaveLength(0)
        expect(s.calls).toHaveLength(0)
    })

    it('liest GitHub nur per GET', async () => {
        await tickCards()
        expect(s.calls.length).toBeGreaterThan(5)
        expect(s.calls.every(call => call.method === 'GET')).toBe(true)
        expect(s.calls.every(call => !JSON.stringify(call.init.headers || {}).toLowerCase().includes('authorization'))).toBe(true)
    })
})

describe('Release-Knopf: Kandidat → Karte', () => {
    it('grüner Kandidat ergibt genau eine Karte mit Belegen, Wirkung extern, ohne „Immer“', async () => {
        const { result, cards } = await tickCards()
        expect(result.created).toHaveLength(1)
        expect(cards).toHaveLength(1)
        const card = cards[0]
        expect(card.titel).toBe('Release 2.82.0 bereit')
        expect(card.wirkung).toBe('extern')
        expect(card.aktion).toEqual({ kind: CARD_KIND, ref: `2.82.0@${CAND}` })
        expect(card.beleg).toContain(CAND.slice(0, 12))
        expect(card.beleg).toContain('CI-Lauf 111 grün')
        expect(card.beleg).toContain('Release-Knopf in Telegram')
        expect(card.vorschlag).toContain('Freigeben?')
        expect(card.buttons.map(item => item.answer)).not.toContain('immer')
        expect(JSON.stringify(cardKeyboard(card))).not.toContain('Immer')
    })

    it('entprellt pro SHA: zweiter Durchlauf erzeugt keine zweite Karte und fragt GitHub nicht erneut ab', async () => {
        await tickCards()
        const before = s.calls.length
        const { result, cards } = await tickCards()
        expect(result.created).toHaveLength(0)
        expect(cards).toHaveLength(1)
        // only the two cheap listing reads (candidate refs + main)
        expect(s.calls.length - before).toBe(2)
    })

    it('abgelaufene, unbeantwortete Karte → neue Karte; nach Nein nie wieder', async () => {
        await tickCards()
        const later = Date.now() + 25 * 60 * 60_000
        maintainApprovalCards({ dataDir: dir, ledger: null, now: () => later })
        const again = await releaseButtonTick(deps({ cardStore: { dataDir: dir, ledger: null, now: () => later } }))
        expect(again.created).toHaveLength(1)
        await press(again.created[0], 'nein')
        const third = await releaseButtonTick(deps({ cardStore: { dataDir: dir, ledger: null, now: () => later + 60_000 } }))
        expect(third.created).toHaveLength(0)
        expect(posts()).toHaveLength(0)
    })

    const noCard: Array<[string, (sc: Scenario) => void, RegExp]> = [
        ['rote CI', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun({ conclusion: 'failure' })] } }, /failure/],
        ['fremde CI (anderer Zweig)', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun({ head_branch: 'claude/other' })] } }, /kein exakter CI-Lauf/],
        ['fremde CI (anderer Commit)', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun({ head_sha: 'c'.repeat(40) })] } }, /kein exakter CI-Lauf/],
        ['fremde CI (anderer Workflow)', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun({ path: '.github/workflows/pages.yml' })] } }, /kein exakter CI-Lauf/],
        ['neuester Lauf rot, älterer grün', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun(), ciRun({ id: 112, conclusion: 'failure' })] } }, /112/],
        ['CI läuft noch', sc => { sc.routes[`/actions/workflows/ci.yml/runs?head_sha=${CAND}&event=push&per_page=50`].body = { workflow_runs: [ciRun({ status: 'in_progress', conclusion: null })] } }, /läuft noch/],
        ['ein Job rot', sc => { sc.routes['/actions/runs/111/jobs?per_page=100'].body = jobs(10, { conclusion: 'failure' }) }, /job-3/],
        ['zu wenige Jobs', sc => { sc.routes['/actions/runs/111/jobs?per_page=100'].body = jobs(4) }, /4 Jobs/],
        ['nicht Fast-Forward (divergiert)', sc => { sc.routes[`/compare/${MAIN}...${CAND}`].body = { status: 'diverged', ahead_by: 3, behind_by: 1 } }, /Fast-Forward/],
        ['nicht Fast-Forward (Status nicht ahead, Zähler unauffällig)', sc => { sc.routes[`/compare/${MAIN}...${CAND}`].body = { status: 'diverged', ahead_by: 3, behind_by: 0 } }, /Fast-Forward/],
        ['nicht Fast-Forward (hinter main)', sc => { sc.routes[`/compare/${MAIN}...${CAND}`].body = { status: 'behind', ahead_by: 0, behind_by: 2 } }, /Fast-Forward/],
        ['Tag existiert', sc => { sc.routes['/git/ref/tags/v2.82.0'] = { status: 200, body: { object: { sha: CAND } } } }, /Tag v2.82.0 existiert/],
        ['Release existiert', sc => { sc.routes['/releases/tags/v2.82.0'] = { status: 200, body: { id: 1 } } }, /Release v2.82.0 existiert/],
        ['Version nicht synchron', sc => { sc.routes[`/contents/desktop/package.json?ref=${CAND}`] = file({ version: '2.81.0' }) }, /nicht synchron/],
        ['Version nicht neuer als main', sc => { sc.routes[`/contents/package.json?ref=${MAIN}`] = file({ version: '2.82.0' }) }, /nicht neuer/],
    ]
    for (const [name, mutate, reason] of noCard) {
        it(`keine Karte: ${name}`, async () => {
            mutate(s)
            const { result, cards } = await tickCards()
            expect(cards).toHaveLength(0)
            if (!/läuft noch|kein exakter/.test(String(reason))) expect(result.rejected[0]?.reason).toMatch(reason)
            else expect(result.rejected).toHaveLength(0)
            expect(posts()).toHaveLength(0)
        })
    }

    it('Gegenprobe: nach Ablehnung genau ein Gedanke pro Grund, nicht bei jedem Durchlauf', async () => {
        s.routes['/git/ref/tags/v2.82.0'] = { status: 200, body: {} }
        await tickCards(); await tickCards()
        const thoughts = readThoughts({ dataDir: dir }).filter(item => item.status === 'verworfen')
        expect(thoughts).toHaveLength(1)
        expect(thoughts[0].text).toMatch(/Tag v2.82.0/)
    })
})

describe('Release-Knopf: Knopfdruck', () => {
    it('Nicht-Owner drückt Ja → nichts ausgelöst, Karte bleibt offen', async () => {
        const { cards } = await tickCards()
        const result = await press(cards[0], 'ja', STRANGER)
        expect(result.code).toBe('kein-owner')
        expect(posts()).toHaveLength(0)
        expect(listApprovalCards({ dataDir: dir })[0].status).toBe('offen')
    })

    it('Owner drückt Ja → genau ein Dispatch mit exaktem SHA; zweiter Druck löst nichts aus', async () => {
        const { cards } = await tickCards()
        const result = await press(cards[0], 'ja')
        expect(result.ok).toBe(true)
        expect(result.card?.result?.ok).toBe(true)
        expect(posts()).toHaveLength(1)
        const post = posts()[0]
        expect(post.url).toBe(`https://api.github.com/repos/${REPO}/actions/workflows/promote-release.yml/dispatches`)
        expect(JSON.parse(post.init.body)).toEqual({ ref: 'main', inputs: { candidate_sha: CAND, version: '2.82.0' } })
        expect(post.init.headers.authorization).toBe(`Bearer ${TOKEN_VALUE}`)
        const again = await press(cards[0], 'ja')
        expect(again.code).toBe('verbraucht')
        expect(posts()).toHaveLength(1)
    })

    it('Gegenprobe: dieselbe SHA wird auch über eine neue Karte nie zweimal ausgelöst', async () => {
        const executor = createReleasePromoteExecutor(deps())
        const card = { aktion: { kind: CARD_KIND, ref: `2.82.0@${CAND}` } } as any
        const ctx = { decidedBy: `telegram:${OWNER}`, userId: OWNER }
        expect((await executor.execute(card, 'ja', ctx)).ok).toBe(true)
        const second = await executor.execute(card, 'ja', ctx)
        expect(second.ok).toBe(false)
        expect(second.message).toMatch(/bereits ausgelöst/)
        expect(posts()).toHaveLength(1)
    })

    it('Nein → kein Dispatch', async () => {
        const { cards } = await tickCards()
        const result = await press(cards[0], 'nein')
        expect(result.ok).toBe(true)
        expect(posts()).toHaveLength(0)
    })

    it('Kandidat hat sich bis zum Druck geändert (Tag inzwischen da) → kein Dispatch', async () => {
        const { cards } = await tickCards()
        s.routes['/git/ref/tags/v2.82.0'] = { status: 200, body: {} }
        const result = await press(cards[0], 'ja')
        expect(result.card?.result?.ok).toBe(false)
        expect(result.card?.result?.message).toMatch(/Erneute Prüfung nicht bestanden/)
        expect(posts()).toHaveLength(0)
    })

    it('ausgeschaltet zwischen Karte und Druck → kein Dispatch', async () => {
        const { cards } = await tickCards()
        enabled = false
        const result = await press(cards[0], 'ja')
        expect(result.card?.result?.ok).toBe(false)
        expect(posts()).toHaveLength(0)
    })

    it('ohne Token: Karte und Antwort zeigen den Befehl statt eines Dispatch', async () => {
        delete env[DISPATCH_TOKEN_ENV]
        const { cards } = await tickCards()
        expect(cards[0].vorschlag).toContain('Token fehlt')
        expect(cards[0].vorschlag).toContain(pushCommand(CAND))
        expect(pushCommand(CAND)).toBe(`git push origin ${CAND}:refs/heads/main`)
        const result = await press(cards[0], 'ja')
        expect(result.card?.result?.ok).toBe(false)
        expect(result.card?.result?.message).toContain(pushCommand(CAND))
        expect(posts()).toHaveLength(0)
    })

    it('Token erscheint nie in Log, Gedanken, Karten oder Zustand — auch nicht bei Fehlern', async () => {
        const logged: string[] = []
        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args.map(String).join(' ')) })
        s.routes['/actions/workflows/promote-release.yml/dispatches'] = { status: 403, body: { message: 'Resource not accessible' } }
        const { cards } = await tickCards()
        const denied = await press(cards[0], 'ja')
        expect(denied.card?.result?.message).toMatch(/HTTP 403/)
        // network failure path
        const executor = createReleasePromoteExecutor(deps({ fetcher: (async (url: any, init: any) => {
            if (init?.method === 'POST') throw new Error(`boom ${init.headers.authorization}`)
            return fetcherFor(s)(url, init)
        }) as typeof fetch }))
        const failed = await executor.execute({ aktion: { kind: CARD_KIND, ref: `2.82.0@${CAND}` } } as any, 'ja', { decidedBy: 'telegram:1', userId: '1' })
        expect(failed.message).not.toContain(TOKEN_VALUE)
        const everything = [
            ...logged,
            JSON.stringify(readThoughts({ dataDir: dir }, 500)),
            JSON.stringify(listApprovalCards({ dataDir: dir })),
            failed.message,
            ...walk(dir).map(path => readFileSync(path, 'utf8')),
        ].join('\n')
        expect(everything).not.toContain(TOKEN_VALUE)
    })
})

function walk(root: string): string[] {
    return readdirSync(root).flatMap(name => {
        const path = join(root, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

describe('Release-Knopf: Rückmeldung', () => {
    const runsKey = '/actions/workflows/promote-release.yml/runs?event=workflow_dispatch&branch=main&per_page=20'
    const promoteRun = (over: Record<string, unknown> = {}) => ({
        id: 900, path: '.github/workflows/promote-release.yml', head_branch: 'main', event: 'workflow_dispatch',
        display_title: `Promote 2.82.0 (${CAND})`, created_at: new Date(Date.now()).toISOString(), status: 'in_progress', conclusion: null, ...over,
    })

    it('meldet läuft und erfolgreich als Gedanke und Telegram-Text', async () => {
        const sent: string[] = []
        s.routes[runsKey] = { status: 200, body: { workflow_runs: [promoteRun()] } }
        s.routes['/actions/runs/900'] = { status: 200, body: promoteRun({ status: 'completed', conclusion: 'success' }) }
        const outcome = await trackPromotion(deps({ notify: async text => { sent.push(text) }, sleep: async () => {}, trackMaxPolls: 5 }), CAND, '2.82.0', Date.now())
        expect(outcome).toBe('erfolgreich')
        const statuses = readThoughts({ dataDir: dir }).map(item => item.status)
        expect(statuses).toEqual(['läuft', 'erfolgreich'])
        expect(sent.join('\n')).toMatch(/Main steht auf bbbbbbbbbbbb/)
        expect(s.calls.every(call => call.method === 'GET')).toBe(true)
    })

    it('meldet abgebrochen mit Grund (fehlgeschlagener Schritt)', async () => {
        s.routes[runsKey] = { status: 200, body: { workflow_runs: [promoteRun({ status: 'completed', conclusion: 'failure' })] } }
        s.routes['/actions/runs/900/jobs?per_page=50'] = { status: 200, body: { jobs: [
            { name: 'verify', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Gitleaks over origin/main..candidate', conclusion: 'failure' }] },
            { name: 'promote', conclusion: 'skipped', steps: [] },
        ] } }
        const outcome = await trackPromotion(deps({ sleep: async () => {}, trackMaxPolls: 3 }), CAND, '2.82.0', Date.now())
        expect(outcome).toBe('abgebrochen')
        const last = readThoughts({ dataDir: dir }).at(-1)!
        expect(last.status).toBe('abgebrochen')
        expect(last.text).toMatch(/Gitleaks/)
    })

    it('fremder Lauf (anderer SHA im Titel) wird nicht als unser Ergebnis gemeldet', async () => {
        s.routes[runsKey] = { status: 200, body: { workflow_runs: [promoteRun({ display_title: `Promote 2.82.0 (${'d'.repeat(40)})`, status: 'completed', conclusion: 'success' })] } }
        const outcome = await trackPromotion(deps({ sleep: async () => {}, trackMaxPolls: 3 }), CAND, '2.82.0', Date.now())
        expect(outcome).toBe('nicht-gefunden')
        expect(readThoughts({ dataDir: dir }).map(item => item.status)).not.toContain('erfolgreich')
    })
})
