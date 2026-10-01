import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createResponsibilityRuntime, formatArbeit, parseResponsibilitySettings } from './responsibility-runtime.js'
import type { ResponsibilitySignals } from './responsibilities.js'

// Phase 6b: Takt + /arbeit. Default off; Main only.

const NOW = Date.parse('2026-10-01T10:00:00Z')
const signals = (disk: 'ok' | 'crit' = 'ok'): ResponsibilitySignals => ({
    now: NOW, localNodeId: 'main-a',
    nodes: [{ nodeId: 'main-a', lastSeen: NOW, profile: { version: '2.81.0', role: 'main', selfCheck: { status: disk, items: [] } } }],
    nightwatch: null, devices: [], release: null, ownerRequests: [],
})

const EXECUTORS = [{ kind: 'diagnose', async run() { return { ok: true, message: 'gemessen' } } }]
const selfHeal = (enabled: boolean) => ({ kind: 'self-heal-zyklus', available: () => enabled, async run() { return { ok: true, message: 'geheilt' } } })

function runtime(overrides: Record<string, unknown> = {}) {
    const collect = vi.fn(async () => signals('crit'))
    const thoughts: any[] = []
    const rt = createResponsibilityRuntime({
        dataDir: mkdtempSync(join(tmpdir(), 'resp-runtime-')),
        now: () => NOW,
        localNodeId: 'main-a',
        isMain: () => true,
        collectSignals: collect,
        executors: EXECUTORS,
        ports: { thoughts: { add: (input: any) => { thoughts.push(input) } }, cards: { create: () => ({ ok: false, reason: 'test' }) } },
        settings: parseResponsibilitySettings({ responsibilities: { enabled: true } }),
        ...overrides,
    })
    return { rt, collect, thoughts }
}

describe('responsibility runtime', () => {
    it('P8: on at the Main without config, off on a worker; enabled:false does nothing', async () => {
        expect(parseResponsibilitySettings(undefined, {} as NodeJS.ProcessEnv).enabled).toBe(true)
        expect(parseResponsibilitySettings(undefined, { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv).enabled).toBe(false)
        expect(parseResponsibilitySettings({ responsibilities: { enabled: false } }, {} as NodeJS.ProcessEnv).enabled).toBe(false)
        const { rt, collect } = runtime({ settings: parseResponsibilitySettings({ responsibilities: { enabled: false } }) })
        const result = await rt.tick('test')
        expect(result.active).toBe(false)
        expect(collect).not.toHaveBeenCalled()
        expect(rt.responsibilities.list()).toHaveLength(0)
    })

    it('a worker never derives, checks or acts', async () => {
        const { rt, collect } = runtime({ isMain: () => false })
        const result = await rt.tick('test')
        expect(result.active).toBe(false)
        expect(collect).not.toHaveBeenCalled()
        expect(rt.missions.list()).toHaveLength(0)
    })

    it('on the Main: derive -> check -> mission in one tick; events trigger a tick', async () => {
        const { rt, collect, thoughts } = runtime({ executors: [...EXECUTORS, selfHeal(true)] })
        const result = await rt.tick('test')
        expect(result.active).toBe(true)
        expect(rt.responsibilities.get('knoten-gesund:main-a')!.status).toBe('aktiv')
        expect(rt.missions.list().length).toBe(1)
        expect(thoughts.some(item => String(item.title).startsWith('Ich kümmere mich ab jetzt um'))).toBe(true)
        expect(collect).toHaveBeenCalled() // tick + fresh measurement after each step
        expect(rt.shouldTickForEvent({ severity: 'warning', kind: 'printer.error' })).toBe(true)
        expect(rt.shouldTickForEvent({ severity: 'info', kind: 'mail.new' })).toBe(false)
    })

    // 2.82.0: Platte/RAM/Knoten-weg meldet schon Weg A (L0/L21). Ohne Ausführer
    // (Selbstheilung aus, entfernter Knoten) keine Mission, die nur „Brauche dich“ meldet.
    it('knoten-gesund without a usable executor starts no mission and only notes a quiet info thought', async () => {
        const { rt, thoughts } = runtime({ executors: [...EXECUTORS, selfHeal(false)] })
        for (let i = 0; i < 4; i++) await rt.tick('test')
        expect(rt.missions.list()).toHaveLength(0)
        expect(thoughts.filter(item => /Brauche dich/.test(String(item.title)))).toEqual([])
        const quiet = thoughts.filter(item => item.signature === 'verantwortung:knoten-gesund:main-a:nur-melden')
        expect(quiet.length).toBeGreaterThan(0)
        expect(quiet.every(item => item.severity === 'info')).toBe(true)
        expect(thoughts.filter(item => item.severity === 'warning' || item.severity === 'critical')).toEqual([])
    })

    it('a silent remote node (no executor besides diagnose) starts no mission either', async () => {
        const remote = (): ResponsibilitySignals => ({
            ...signals('ok'),
            nodes: [...signals('ok').nodes, { nodeId: 'worker-b', lastSeen: NOW - 3 * 60 * 60_000, profile: { version: '2.81.0', role: 'worker', selfCheck: { status: 'ok', items: [] } } }],
        })
        const { rt, thoughts } = runtime({ collectSignals: vi.fn(async () => remote()) })
        const result = await rt.tick('test')
        expect(result.verletzt).toBe(1)
        expect(result.gestartet).toBe(0)
        expect(rt.missions.list()).toHaveLength(0)
        expect(thoughts.some(item => item.signature === 'verantwortung:knoten-gesund:worker-b:nur-melden' && item.severity === 'info')).toBe(true)
    })

    it('/arbeit shows missions by state and active responsibilities with fulfilled/violated', async () => {
        const { rt } = runtime()
        await rt.tick('test')
        const text = formatArbeit(rt.missions.list(), rt.responsibilities.list())
        for (const section of ['In Arbeit', 'Geplant', 'Wartet auf Alfred', 'Blockiert', 'Abgeschlossen', 'Verantwortungen']) expect(text).toContain(section)
        expect(text).toContain('knoten-gesund:main-a')
        expect(text).toMatch(/verletzt|erfüllt/)
    })
})
