import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import { peerStateWithCapabilities } from '../mesh/mesh-transport-runtime.js'
import { getLeaseCoordinatorFailures, noteLeaseUnavailable } from '../mesh/leader-election.js'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { endpointSwitchHold, FAILOVER_HOLD_MS, formatSelfHealOverview, handleSelfHealSwitch, resetSelfHealTrigger, runSelfHealCycle, SELF_HEAL_MIN_GAP_MS, setSelfHealConfig, triggerSelfHeal } from './self-heal-runtime.js'

let root: string
const previousRoot = process.env.NOVA_RUNTIME_ROOT

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'self-heal-runtime-'))
    process.env.NOVA_RUNTIME_ROOT = root
    mkdirSync(join(root, '.nova-data'), { recursive: true })
})

afterEach(() => {
    resetSelfHealTrigger()
    setSelfHealConfig(undefined)
    if (previousRoot === undefined) delete process.env.NOVA_RUNTIME_ROOT
    else process.env.NOVA_RUNTIME_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
})

describe('Selbstheilung runtime wiring (Stufe 3)', () => {
    it('does nothing at all while autonomy.selfHeal.enabled is not true', async () => {
        setSelfHealConfig({ enabled: false })
        writeFileSync(join(root, '.nova-data', 'subagent-audit.jsonl'), 'x'.repeat(2 * 1024 * 1024))
        expect(await runSelfHealCycle({ isMain: true })).toEqual([])
        expect(existsSync(join(root, '.nova-data', 'self-heal'))).toBe(false)
    })

    it('a worker heals its own log but gets no owner-bound checks back', async () => {
        setSelfHealConfig({ enabled: true, logRotateBytes: 1024 * 1024 })
        writeFileSync(join(root, '.nova-data', 'subagent-audit.jsonl'), 'x'.repeat(2 * 1024 * 1024))
        expect(await runSelfHealCycle({ isMain: false })).toEqual([])
        expect(existsSync(join(root, '.nova-data', 'subagent-audit.jsonl'))).toBe(false)
        const journal = readFileSync(join(root, '.nova-data', 'self-heal', 'journal', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
        expect(journal).toMatch(/"ergebnis":"geheilt"/)
        expect(journal).toMatch(/enforce fehlt/)
    })

    it('/selbstheilung aus|an switches the Not-Aus and /heilung shows it', async () => {
        setSelfHealConfig({ enabled: true })
        expect(handleSelfHealSwitch('aus')).toMatch(/Not-Aus gesetzt/)
        expect(await formatSelfHealOverview()).toMatch(/Selbstheilung: AUS \(Not-Aus/)
        expect(handleSelfHealSwitch('an')).toMatch(/aufgehoben/)
        expect(await formatSelfHealOverview()).toMatch(/Selbstheilung: AN/)
        expect(handleSelfHealSwitch('vielleicht')).toMatch(/Nutzung/)
    })

    // 2.82.0: one trigger for loop, Wächter-L1, mission step and owner Ja.
    it('triggerSelfHeal: one run at a time, then at most one cycle per 5 minutes', async () => {
        setSelfHealConfig({ enabled: true, logRotateBytes: 1024 * 1024 })
        let now = Date.parse('2026-10-01T10:00:00Z')
        const [a, b] = await Promise.all([
            triggerSelfHeal({ isMain: false, reason: 'autonomie-schleife', now: () => now }),
            triggerSelfHeal({ isMain: false, reason: 'waechter', now: () => now }),
        ])
        expect(a.ran && b.ran).toBe(true)
        expect(b.note).toMatch(/läuft bereits \(Anstoß: autonomie-schleife\)/)
        now += 60_000
        const soon = await triggerSelfHeal({ isMain: true, reason: 'mission', now: () => now })
        expect(soon).toMatchObject({ ran: false, checks: [] })
        expect(soon.note).toMatch(/vor 1 min gelaufen \(Anstoß: autonomie-schleife\)/)
        now += SELF_HEAL_MIN_GAP_MS
        expect((await triggerSelfHeal({ isMain: false, reason: 'owner-ja', now: () => now })).ran).toBe(true)
        setSelfHealConfig({ enabled: false })
        expect((await triggerSelfHeal({ isMain: true, reason: 'x' })).note).toMatch(/aus/)
    })

    it('nur self-heal-runtime.ts ruft runSelfHealCycle; alle anderen nehmen triggerSelfHeal', () => {
        const src = fileURLToPath(new URL('..', import.meta.url))
        const offenders: string[] = []
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name)
                if (statSync(path).isDirectory()) { walk(path); continue }
                if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'self-heal-runtime.ts') continue
                if (/runSelfHealCycle\(/.test(readFileSync(path, 'utf8'))) offenders.push(path)
            }
        }
        walk(src)
        expect(offenders).toEqual([])
    })

    it('endpointSwitchHold: vLLM-Wechsel, Wartungsmarke und LLM-Failover halten die Umschaltung an', async () => {
        const now = Date.parse('2026-10-01T10:00:00Z')
        const free = { plans: () => [], hostState: async () => null, lastFailoverAt: () => 0, now: () => now }
        expect(await endpointSwitchHold(free)).toBeNull()
        expect(await endpointSwitchHold({ ...free, plans: () => [{ id: 'v1', status: 'laeuft' }] })).toMatch(/vLLM-Wechsel v1 läuft/)
        expect(await endpointSwitchHold({ ...free, plans: () => [{ id: 'v1', status: 'ausgefuehrt' }] })).toBeNull()
        expect(await endpointSwitchHold({ ...free, hostState: async () => ({ maintenance: true }) })).toMatch(/Wartungsmarke/)
        expect(await endpointSwitchHold({ ...free, hostState: async () => ({ switchRunning: true }) })).toMatch(/Wechsel läuft am Host/)
        expect(await endpointSwitchHold({ ...free, lastFailoverAt: () => now - 60_000 })).toMatch(/LLM-Failover vor 1 min/)
        expect(await endpointSwitchHold({ ...free, lastFailoverAt: () => now - FAILOVER_HOLD_MS - 1 })).toBeNull()
    })

    it('owner-only commands', () => {
        expect(getCommandMinimumRole('heilung')).toBe('owner')
        expect(getCommandMinimumRole('selbstheilung')).toBe('owner')
    })

    it('exposes lease refusals read-only for the report recipe', () => {
        noteLeaseUnavailable('self-heal-test-service', 403)
        expect(getLeaseCoordinatorFailures()).toEqual(expect.arrayContaining([{ service: 'self-heal-test-service', status: 403, failures: 1 }]))
    })

    it('keeps a peer self-heal summary across capability messages without one', () => {
        const summary = { schema: 1, enabled: true, killSwitch: false, reports: [{ id: 'a', at: 't', recipe: 'platte-voll-melden', level: 'vorschlag', ergebnis: 'vorschlag', message: 'Platte', notify: true }] }
        const first = peerStateWithCapabilities(undefined, 'xaventra-ns2', { runtimes: [], capabilities: [], selfHeal: summary }, 'fp', 1_000)
        expect(first.selfHeal?.reports[0].recipe).toBe('platte-voll-melden')
        const later = peerStateWithCapabilities(first, 'xaventra-ns2', { runtimes: [], capabilities: [] }, 'fp', 31_000)
        expect(later.selfHeal?.reports).toHaveLength(1)
        expect(later.selfHealSeen).toBe(1_000)
        const bad = peerStateWithCapabilities(undefined, 'xaventra-ns2', { runtimes: [], capabilities: [], selfHeal: { schema: 9 } }, 'fp', 1_000)
        expect(bad.selfHeal).toBeUndefined()
    })
})
