import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findCatalogEntry, OLLAMA_CHAT_MODELS } from '../install/install-catalog.js'
import { chooseFirstStartModel, runAndStoreFirstStartDoctor, runFirstStartDoctor, type FirstStartDoctorDeps } from './first-start-doctor.js'
import { ensureFirstStartConfig, readOnboardingState } from './first-start.js'

type Calls = { proposed: string[]; applied: string[]; cases: Array<{ key: string; title: string }> }
function fakeDeps(overrides: Partial<FirstStartDoctorDeps> = {}): { deps: FirstStartDoctorDeps; calls: Calls } {
    const calls: Calls = { proposed: [], applied: [], cases: [] }
    const deps: FirstStartDoctorDeps = {
        hardware: async () => ({ platform: 'linux', arch: 'x64', cpus: 8, memoryGb: 16, gpu: null }),
        runDoctor: async () => ({ findings: 0, titles: [] }),
        scan: async () => ({ actions: [] }),
        detectLocalModels: async () => [],
        applyCatalogAction: async id => { calls.applied.push(id); return { success: false, message: `${id} wartet auf Freigabe (Knopf-Karte)` } },
        proposeInstall: async id => { calls.proposed.push(id); return { ok: true, status: 'queued', proposalId: 'iq-000000000001', message: 'wartet auf Freigabe (Knopf-Karte)' } },
        openCase: input => { calls.cases.push({ key: input.key, title: input.title }); return `case-${calls.cases.length}` },
        now: () => new Date('2026-10-02T08:00:00.000Z'),
        ...overrides,
    }
    return { deps, calls }
}

describe('Erster Start: Doctor + Selbsteinrichtung zuerst (2.85 Paket B, Punkt 2)', () => {
    it('ships small local chat models in the signed install catalog (ticket path, fixed commands)', () => {
        for (const name of Object.keys(OLLAMA_CHAT_MODELS)) {
            expect(findCatalogEntry(`ollama-model:${name}`)).toMatchObject({ kind: 'ollama-model', approval: 'fragen', runAs: 'service' })
        }
    })

    it('chooses a model that fits the memory of this computer, or none', () => {
        expect(chooseFirstStartModel({ memoryGb: 32 })).toBe('ollama-model:qwen3')
        expect(chooseFirstStartModel({ memoryGb: 16 })).toBe('ollama-model:qwen3')
        expect(chooseFirstStartModel({ memoryGb: 8 })).toBe('ollama-model:llama3.2')
        expect(chooseFirstStartModel({ memoryGb: 3 })).toBeNull()
        for (const memoryGb of [6, 8, 14, 64]) expect(findCatalogEntry(chooseFirstStartModel({ memoryGb }))).toBeTruthy()
    })

    it('reports a found local model and proposes nothing', async () => {
        const { deps, calls } = fakeDeps({
            detectLocalModels: async () => [{ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: ['nomic-embed-text', 'qwen3:8b'] }],
        })
        const report = await runFirstStartDoctor(deps)
        expect(report.localModel).toEqual({ provider: 'Ollama', model: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434' })
        expect(report.items.find(item => item.step === 'modell')).toMatchObject({ status: 'ok' })
        expect(calls.proposed).toEqual([])
        expect(calls.cases).toEqual([])
    })

    it('an embedding-only server is not a chat model', async () => {
        const { deps, calls } = fakeDeps({
            detectLocalModels: async () => [{ name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: ['nomic-embed-text'] }],
        })
        const report = await runFirstStartDoctor(deps)
        expect(report.localModel).toBeNull()
        expect(calls.proposed).toEqual(['ollama-model:qwen3'])
    })

    it('without a model it proposes a fitting catalog model as a card (never installs itself)', async () => {
        const { deps, calls } = fakeDeps({ hardware: async () => ({ platform: 'linux', arch: 'arm64', cpus: 4, memoryGb: 8, gpu: null }) })
        const report = await runFirstStartDoctor(deps)
        expect(calls.proposed).toEqual(['ollama-model:llama3.2'])
        expect(report.items.find(item => item.step === 'modell')).toMatchObject({
            status: 'vorgeschlagen', catalogId: 'ollama-model:llama3.2', proposalId: 'iq-000000000001',
        })
    })

    it('a refused install route becomes a Doctor case she follows', async () => {
        const { deps, calls } = fakeDeps({
            proposeInstall: async id => { calls.proposed.push(id); return { ok: false, status: 'refused', message: 'Kein freigegebener Installationsweg auf diesem Knoten' } },
        })
        const report = await runFirstStartDoctor(deps)
        expect(calls.cases.map(item => item.key)).toEqual(['first-start:modell'])
        expect(report.items.find(item => item.step === 'modell')).toMatchObject({ status: 'gescheitert', caseId: 'case-1' })
    })

    it('too little memory for any catalog model becomes a Doctor case, without a proposal', async () => {
        const { deps, calls } = fakeDeps({ hardware: async () => ({ platform: 'win32', arch: 'x64', cpus: 2, memoryGb: 3, gpu: null }) })
        const report = await runFirstStartDoctor(deps)
        expect(calls.proposed).toEqual([])
        expect(calls.cases.map(item => item.key)).toEqual(['first-start:modell'])
        expect(report.items.find(item => item.step === 'modell')?.status).toBe('gescheitert')
    })

    it('repairs only through existing recipes: catalog actions go the queue/card way, config patches wait for the owner', async () => {
        const { deps, calls } = fakeDeps({
            detectLocalModels: async () => [{ name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['example-model'] }],
            scan: async () => ({ actions: [
                { id: 'mesh:embedding', type: 'local_shell', title: 'Embedding-Modell', catalogId: 'ollama-model:nomic-embed-text' },
                { id: 'config:memory', type: 'config_patch', title: 'Speicher einstellen' },
                { id: 'done:x', type: 'config_patch', title: 'Schon erledigt', applied: true },
            ] }),
        })
        const report = await runFirstStartDoctor(deps)
        expect(calls.applied).toEqual(['mesh:embedding'])
        const setup = report.items.filter(item => item.step === 'einrichtung')
        expect(setup.map(item => [item.status, item.catalogId ?? null])).toEqual([['vorgeschlagen', 'ollama-model:nomic-embed-text'], ['braucht-dich', null]])
    })

    it('reports Doctor findings first and survives a failing step as a Doctor case', async () => {
        const { deps, calls } = fakeDeps({
            runDoctor: async () => ({ findings: 2, titles: ['Festplatte fast voll', 'Uhrzeit weicht ab'] }),
            scan: async () => { throw new Error('scan kaputt') },
        })
        const report = await runFirstStartDoctor(deps)
        expect(report.items[0]).toMatchObject({ step: 'doctor', status: 'braucht-dich' })
        expect(report.items.find(item => item.step === 'einrichtung')).toMatchObject({ status: 'gescheitert', caseId: expect.any(String) })
        expect(calls.cases.map(item => item.key)).toContain('first-start:einrichtung')
        expect(report.finishedAt).toBe('2026-10-02T08:00:00.000Z')
    })

    it('stores the report "was ich getan habe" in the first-start marker, once at a time', async () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-firststart-doctor-'))
        await ensureFirstStartConfig({ root, env: {} })
        const { deps } = fakeDeps()
        const [first, second] = await Promise.all([runAndStoreFirstStartDoctor(deps, root), runAndStoreFirstStartDoctor(deps, root)])
        expect([first, second].filter(Boolean)).toHaveLength(1)
        const state = readOnboardingState(root)!
        expect(state.doctor?.items.length).toBeGreaterThan(0)
        expect(state.doctorRunning).toBe(false)
    })

    it('does nothing for an existing installation (no marker)', async () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-firststart-existing-'))
        const { deps, calls } = fakeDeps()
        expect(await runAndStoreFirstStartDoctor(deps, root)).toBeNull()
        expect(calls.proposed).toEqual([])
    })

    it('the daemon runs it in the background only in first-start mode', () => {
        const source = readFileSync(fileURLToPath(new URL('../daemon.ts', import.meta.url)), 'utf8')
        const call = source.indexOf('runAndStoreFirstStartDoctor(')
        expect(call).toBeGreaterThan(0)
        expect(source.slice(Math.max(0, call - 400), call)).toContain('if (firstStart)')
    })
})
