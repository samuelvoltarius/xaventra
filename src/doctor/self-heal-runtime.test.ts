import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getCommandMinimumRole } from '../core/slash-commands.js'
import { peerStateWithCapabilities } from '../mesh/mesh-transport-runtime.js'
import { getLeaseCoordinatorFailures, noteLeaseUnavailable } from '../mesh/leader-election.js'
import { formatSelfHealOverview, handleSelfHealSwitch, runSelfHealCycle, setSelfHealConfig } from './self-heal-runtime.js'

let root: string
const previousRoot = process.env.NOVA_RUNTIME_ROOT

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'self-heal-runtime-'))
    process.env.NOVA_RUNTIME_ROOT = root
    mkdirSync(join(root, '.nova-data'), { recursive: true })
})

afterEach(() => {
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
