import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FailureResearchCase } from '../doctor/failure-research-coordinator.js'
import {
    estimateModelBytes, filterCandidates, fixtureSource, huggingFaceSource, runModelScout,
    type ModelCandidate, type ScoutRunner,
} from './model-scout.js'
import { buildProbeSet, containsPrivateContent } from './probe-set.js'
import { MemoryThoughtSink, parseThinkingSettings, type LoadProbe, type LoadSample } from './ports.js'

const GB = 1024 ** 3
const IDLE: LoadSample = { measured: true, gpuUtilPercent: 2, vllmRunning: 0, vllmWaiting: 0, sources: ['test'] }
const load = (sample: LoadSample = IDLE): LoadProbe => ({ sample: async () => sample })
const settings = (patch: Record<string, unknown> = {}) => parseThinkingSettings({
    enabled: true, scout: { enabled: true, memoryBudgetGB: 96, minImprovementPercent: 5, ...patch },
})
const candidate = (patch: Partial<ModelCandidate>): ModelCandidate => ({
    id: 'org/model-32b', source: 'test', license: 'apache-2.0', paramsB: 32, quant: 'bf16', libraries: ['transformers'], tags: ['safetensors'], ...patch,
})
const listing = (items: ModelCandidate[]) => ({ name: 'test', list: async () => items })
const doctorCase = (id: string, title: string, hypothesis: string): FailureResearchCase => ({
    id, findingId: id, title, stage: 'diagnosed', severity: 'warning', hypothesis, researchQueries: [], requiredEvidence: [], evidenceRefs: [],
    patchGateRequired: true, updatedAt: '2026-10-01T00:00:00Z',
})
function runner(scores: Record<string, number>): ScoutRunner & { calls: string[] } {
    const calls: string[] = []
    return {
        calls,
        async evaluate(model, probes) {
            calls.push(model)
            const total = 20 // fixed so the expected percentages are exact
            return { model, total, passed: Math.round((scores[model] ?? 0) * total), avgLatencyMs: 900, perCase: probes.map(item => ({ id: item.id, ok: true })) }
        },
    }
}

afterEach(() => { delete (globalThis as any).__novaState })

describe('Phase 3 Modell-Scout', () => {
    it('without network and without a fixture it does nothing harmful', async () => {
        const sink = new MemoryThoughtSink()
        const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed: ENOTFOUND huggingface.co') })
        const test = runner({})
        const result = await runModelScout({
            settings: settings(), load: load(), sink, currentModel: 'qwen', runner: test,
            sources: [huggingFaceSource({ fetchImpl: fetchImpl as any }), fixtureSource(join(process.cwd(), 'gibt-es-nicht.json'))],
            probes: [{ id: 'p1', origin: 'alltag', prompt: 'Was ist 2+2?', expect: { kind: 'contains-any', values: ['4'] } }],
            reportPath: join(mkdtempSync(join(process.cwd(), 'scout-')), 'r.json'),
        })
        expect(result.candidates).toHaveLength(0)
        expect(result.sourceErrors.length).toBe(2)
        expect(test.calls).toHaveLength(0)
        expect(sink.thoughts).toHaveLength(0)
    })

    it('reads Hugging Face only with GET and gives up at its time limit', async () => {
        const calls: Array<{ url: string; init: RequestInit }> = []
        const hanging = (url: string, init: RequestInit) => {
            calls.push({ url, init })
            return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
        }
        const source = huggingFaceSource({ fetchImpl: hanging as any, timeoutMs: 50 })
        await expect(source.list(new AbortController().signal)).rejects.toThrow()
        expect(calls).toHaveLength(1)
        expect(calls[0].init.method).toBe('GET')
        expect(calls[0].init.body).toBeUndefined()
        expect(calls[0].url).toMatch(/^https:\/\/huggingface\.co\/api\/models\?/)

        const ok = huggingFaceSource({ fetchImpl: (async () => new Response(JSON.stringify([
            { id: 'org/Neu-14B-Instruct', tags: ['license:apache-2.0', 'safetensors', 'transformers'], library_name: 'transformers', safetensors: { total: 14_700_000_000, parameters: { BF16: 14_700_000_000 } } },
        ]), { status: 200 })) as any })
        const [parsed] = await ok.list(new AbortController().signal)
        expect(parsed).toMatchObject({ id: 'org/Neu-14B-Instruct', license: 'apache-2.0', quant: 'bf16' })
        expect(parsed.paramsB).toBeCloseTo(14.7, 1)
    })

    it('never proposes a model that does not fit the GB10 memory, even if it scores higher', async () => {
        const sink = new MemoryThoughtSink()
        const huge = candidate({ id: 'org/giant-235b', paramsB: 235, quant: 'bf16' })
        expect(estimateModelBytes(huge)!).toBeGreaterThan(96 * GB)
        const result = await runModelScout({
            settings: settings(), load: load(), sink, currentModel: 'qwen', runner: runner({ qwen: 0.5, 'org/giant-235b': 1 }),
            sources: [listing([huge])], probes: buildProbeSet({ doctorCases: [], taskTypeCounts: {} }),
            reportPath: join(mkdtempSync(join(process.cwd(), 'scout-')), 'r.json'),
        })
        expect(result.rejected).toEqual([expect.objectContaining({ id: 'org/giant-235b', reason: expect.stringMatching(/zu groß/) })])
        expect(result.proposal).toBeUndefined()
        expect(sink.thoughts.filter(item => item.stufe === 'fragen')).toHaveLength(0)
    })

    it('filters unknown size, unknown or non-allowed licence and gguf-only (not vLLM)', () => {
        const { fit, rejected } = filterCandidates([
            candidate({ id: 'a/size-unknown', paramsB: undefined }),
            candidate({ id: 'b/no-licence', license: undefined }),
            candidate({ id: 'c/nc', license: 'cc-by-nc-4.0' }),
            candidate({ id: 'd/gguf', libraries: ['gguf'], tags: ['gguf'] }),
            candidate({ id: 'e/ok-awq', paramsB: 70, quant: 'awq' }),
        ], { memoryBudgetBytes: 96 * GB, licenses: parseThinkingSettings({}).scout.licenses })
        expect(fit.map(item => item.id)).toEqual(['e/ok-awq'])
        expect(Object.fromEntries(rejected.map(item => [item.id, item.reason]))).toMatchObject({
            'a/size-unknown': expect.stringMatching(/Größe unbekannt/), 'b/no-licence': expect.stringMatching(/Lizenz/),
            'c/nc': expect.stringMatching(/Lizenz/), 'd/gguf': expect.stringMatching(/vLLM/),
        })
        expect(filterCandidates([candidate({})], { memoryBudgetBytes: 0, licenses: ['apache-2.0'] }).fit).toHaveLength(0)
    })

    it('proposes "Z was X % better" with a test report and never switches by itself', async () => {
        const switchModel = vi.fn(async () => true)
        ;(globalThis as any).__novaState = { llm: { modelId: 'qwen', switchModel } }
        const sink = new MemoryThoughtSink()
        // 2.84.0: measured only when installed; proposed only as a target of the vLLM switch list.
        const test = Object.assign(runner({ qwen: 0.6, 'org/model-32b': 0.75 }), {
            inventory: async () => ({ installed: ['qwen', 'org/model-32b'], targets: [{ target: 'm32', modelId: 'org/model-32b' }] }),
        })
        const result = await runModelScout({
            settings: settings(), load: load(), sink, currentModel: 'qwen', runner: test,
            sources: [listing([candidate({})])], probes: buildProbeSet({ doctorCases: [], taskTypeCounts: { chat: 3 } }),
            reportPath: join(mkdtempSync(join(process.cwd(), 'scout-')), 'r.json'),
        })
        expect(test.calls).toEqual(['qwen', 'org/model-32b'])
        expect(result.proposal?.stufe).toBe('fragen')
        expect(result.proposal?.text).toMatch(/org\/model-32b war 25 % besser als qwen/)
        expect(result.proposal?.proposal).toMatchObject({ action: 'modell-wechsel', params: { modell: 'm32', von: 'qwen' }, autoExecute: false })
        expect(result.report?.results.map(item => item.model)).toEqual(['qwen', 'org/model-32b'])
        expect(switchModel).not.toHaveBeenCalled()
        expect((globalThis as any).__novaState.llm.modelId).toBe('qwen')
    })

    it('does not test while the GPU is busy and proposes nothing when the gain is too small', async () => {
        const busyRunner = runner({ qwen: 0.5, 'org/model-32b': 1 })
        const busy = await runModelScout({
            settings: settings(), load: load({ measured: true, gpuUtilPercent: 85, vllmRunning: 3, vllmWaiting: 0, sources: ['test'] }), sink: new MemoryThoughtSink(),
            currentModel: 'qwen', runner: busyRunner, sources: [listing([candidate({})])], probes: buildProbeSet({ doctorCases: [], taskTypeCounts: {} }),
            reportPath: join(mkdtempSync(join(process.cwd(), 'scout-')), 'r.json'),
        })
        expect(busy.reason).toMatch(/GPU|vLLM/)
        expect(busyRunner.calls).toHaveLength(0)
        const small = await runModelScout({
            settings: settings(), load: load(), sink: new MemoryThoughtSink(), currentModel: 'qwen',
            runner: Object.assign(runner({ qwen: 0.6, 'org/model-32b': 0.62 }), { inventory: async () => ({ installed: ['org/model-32b'], targets: [{ target: 'm32', modelId: 'org/model-32b' }] }) }),
            sources: [listing([candidate({})])], probes: buildProbeSet({ doctorCases: [], taskTypeCounts: {} }),
            reportPath: join(mkdtempSync(join(process.cwd(), 'scout-')), 'r.json'),
        })
        expect(small.proposal).toBeUndefined()
        expect(small.reason).toMatch(/nur \d+ % besser/)
    })

    it('loads candidates from an offline fixture', async () => {
        const path = join(mkdtempSync(join(process.cwd(), 'scout-')), 'fixture.json')
        writeFileSync(path, JSON.stringify([{ id: 'org/fix-8b', tags: ['license:mit', 'safetensors'], library_name: 'transformers', safetensors: { total: 8e9, parameters: { BF16: 8e9 } } }]))
        const items = await fixtureSource(path).list(new AbortController().signal)
        expect(items).toEqual([expect.objectContaining({ id: 'org/fix-8b', license: 'mit' })])
    })
})

describe('Phase 3 Prüfsatz', () => {
    const PRIVATE = [
        doctorCase('a', 'Mail an alfred.aigner@example.com scheitert', 'SMTP antwortet nicht'),
        doctorCase('b', 'Spark 100.86.70.71 antwortet nicht', 'Port 8000 zu'),
        doctorCase('c', 'Datei fehlt', 'C:\\Users\\alf_a\\Documents\\steuer.pdf nicht lesbar'),
        doctorCase('d', 'Login', 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 abgelehnt'),
        doctorCase('e', 'Rückruf', 'Kunde unter +43 664 1234567 erreichen'),
        doctorCase('f', 'Konto', 'IBAN AT61 1904 3002 3457 3201 prüfen'),
        doctorCase('g', 'Link', 'https://intern.example.org/rechnung/77 lädt nicht'),
        doctorCase('h', 'Home', 'Pfad /home/tgbrutus/.ssh/config fehlt'),
    ]
    const CLEAN = doctorCase('z', 'Success rate is 7.0% across 748 traces', 'Werkzeug web_search scheitert in 31 von 40 Fällen')

    it('contains no private content', () => {
        for (const item of PRIVATE) expect(containsPrivateContent(`${item.title} ${item.hypothesis}`), item.id).not.toBeNull()
        const probes = buildProbeSet({ doctorCases: [...PRIVATE, CLEAN], taskTypeCounts: { chat: 10, code: 5, search: 3 } })
        expect(probes.length).toBeGreaterThan(5)
        for (const probe of probes) expect(containsPrivateContent(probe.prompt), probe.prompt).toBeNull()
        const text = JSON.stringify(probes)
        for (const leak of ['alfred', '100.86', 'alf_a', 'ghp_', '664', 'AT61', 'intern.example', 'tgbrutus']) expect(text).not.toContain(leak)
    })

    it('uses real doctor cases with measurements masked', () => {
        const probes = buildProbeSet({ doctorCases: [CLEAN], taskTypeCounts: {} })
        const doctor = probes.filter(item => item.origin === 'doctor')
        expect(doctor).toHaveLength(1)
        expect(doctor[0].prompt).toContain('web_search')
        expect(doctor[0].prompt).not.toMatch(/748|31 von 40/)
    })
})
