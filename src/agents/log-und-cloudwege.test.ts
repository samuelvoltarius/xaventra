import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, NoopTrace, Usage, addTraceProcessor, getGlobalTraceProvider, setTracingDisabled } from '@openai/agents'

// 2.84.0 Punkt 10: Live-Log sauber, Cloud-Nebenwege weg.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const learningDir = () => join(process.cwd(), '.nova-learning')

function fakeProvider() {
    const model = {
        async getResponse() {
            return {
                usage: new Usage(),
                responseId: 'r1',
                output: [{ type: 'message', role: 'assistant', status: 'completed',
                    content: [{ type: 'output_text', text: 'ok' }] }],
            }
        },
        async *getStreamedResponse() { throw new Error('not used') },
    }
    return { getModel: () => model } as any
}

describe('Tracing des Agents-SDK ist global aus', () => {
    it('nach dem Laden von sdk-runtime legt kein Lauf einen Trace an und kein Exporter wird gerufen', async () => {
        setTracingDisabled(false) // so wie in Produktion (NODE_ENV != test)
        const processor = {
            onTraceStart: vi.fn(async () => {}), onTraceEnd: vi.fn(async () => {}),
            onSpanStart: vi.fn(async () => {}), onSpanEnd: vi.fn(async () => {}),
            shutdown: vi.fn(async () => {}), forceFlush: vi.fn(async () => {}),
        }
        addTraceProcessor(processor as any)
        const { createSdkRunner } = await import('./sdk-runtime.js')

        expect(getGlobalTraceProvider().createTrace({ name: 'probe' })).toBeInstanceOf(NoopTrace)
        const result = await createSdkRunner(fakeProvider()).run(new Agent({ name: 'probe', instructions: 'x' }), 'hallo')
        expect(result.finalOutput).toBe('ok')
        expect(processor.onTraceStart).not.toHaveBeenCalled()
        expect(processor.onSpanStart).not.toHaveBeenCalled()
    })
})

describe('Learning Hub über Supabase ist entfernt (L22 ist der eine Weg zwischen Knoten)', () => {
    let fetchSpy: ReturnType<typeof vi.fn>
    let warnSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        rmSync(learningDir(), { recursive: true, force: true })
        mkdirSync(learningDir(), { recursive: true })
        fetchSpy = vi.fn(async () => { throw new Error('kein Netz im Test') })
        vi.stubGlobal('fetch', fetchSpy)
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => { vi.unstubAllGlobals(); warnSpy.mockRestore() })

    it('das Modul gibt es nicht mehr, und kein Start-Code lädt es', () => {
        expect(existsSync(join(srcDir, 'intelligence', 'learning-hub.ts'))).toBe(false)
        for (const file of ['daemon.ts', 'intelligence/proactive-learning.ts', 'memory/capabilities-store.ts']) {
            expect(readFileSync(join(srcDir, file), 'utf-8')).not.toMatch(/learning-hub/)
        }
    })

    it('ein erfolgreicher Owner-Werkzeuglauf ruft kein fetch und warnt nicht vor fehlender Supabase-Konfiguration', async () => {
        const store = await import('../memory/capabilities-store.js')
        expect(store.learnToolOutcome({ tool: 'read_file', args: { path: 'a.txt' }, result: { success: true }, permission: 'owner' })).toBe('success')
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(warnSpy.mock.calls.flat().join(' ')).not.toMatch(/No Supabase config/)
        // Die Erfolgsliste lernte vor der Validierung; sie wird nicht mehr geschrieben.
        expect(existsSync(join(learningDir(), 'capabilities.json'))).toBe(false)
    })

    it('proaktives Lernen schaut nur lokal nach und geht nicht ins Netz', async () => {
        const learning = await import('../intelligence/proactive-learning.js')
        learning.storeKnowledge('example.com Ausfall', ['lokal gelernt'])
        expect(await learning.checkIfAlreadyLearned('example.com ausfall')).toEqual(['lokal gelernt'])
        expect(await learning.checkIfAlreadyLearned('etwas ganz anderes')).toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(warnSpy.mock.calls.flat().join(' ')).not.toMatch(/No Supabase config/)
    })
})

describe('Prompt: kein siebter Lernblock, Negativ-Gedächtnis bleibt', () => {
    beforeEach(() => {
        rmSync(learningDir(), { recursive: true, force: true })
        mkdirSync(learningDir(), { recursive: true })
    })

    it('alte capabilities.json bleibt liegen, kommt aber nicht mehr in den Prompt', async () => {
        const legacy = JSON.stringify([{ id: 'tts', name: 'Text-to-Speech Audio erstellen', description: 'x',
            tools: ['run_command'], examples: [], successCount: 9, lastUsed: 1, firstLearned: 1, category: 'audio' }])
        writeFileSync(join(learningDir(), 'capabilities.json'), legacy)
        const store = await import('../memory/capabilities-store.js')
        store.recordUnavailable('browser_open', 'chromium not found')
        store.recordUnavailable('browser_open', 'chromium not found')

        for (const permission of ['owner', 'guest']) {
            const prompt = store.getCapabilitiesPrompt({ permission })
            expect(prompt).not.toContain('GELERNTEN FÄHIGKEITEN')
            expect(prompt).not.toContain('Text-to-Speech')
            expect(prompt).toContain('NICHT VERFÜGBAR')
            expect(prompt).toContain('browser_open')
        }
        expect(readFileSync(join(learningDir(), 'capabilities.json'), 'utf-8')).toBe(legacy)
    })
})
