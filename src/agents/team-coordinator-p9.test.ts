import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// P9 Punkt 5: /bot team und /subagent laufen über den einen
// Unteragenten-Orchestrator (Grenze 6, Audit-Log); die Multi-Bot-Instanzen
// sind weg, ihre Personas sind Rollen.

const orchestrator = vi.hoisted(() => ({
    calls: [] as any[],
    busy: false,
}))
vi.mock('./subagent-orchestrator.js', () => ({
    spawnSubagent: vi.fn(async (task: any) => {
        orchestrator.calls.push(task)
        if (orchestrator.busy) return { id: 'x', status: 'failed', output: '', toolsUsed: [], durationMs: 0, mode: 'local', error: 'Concurrency limit reached (max 6 parallel subagents)' }
        if (/Zerlege diese Aufgabe/.test(task.task)) return { id: 'c', status: 'completed', output: '1. Researcher: suche\n2. Coder: prüfe\n3. Analyst: bewerte', toolsUsed: [], durationMs: 1, mode: 'local' }
        return { id: 's', status: 'completed', output: `Antwort für: ${task.task.slice(0, 40)}`, toolsUsed: [], durationMs: 1, mode: 'local' }
    }),
}))
vi.mock('../mesh/mesh-llm-proxy.js', () => { throw new Error('team must not call the mesh LLM proxy directly') })
vi.mock('../llm/nova-llm-sdk.js', () => { throw new Error('team must not create its own LLM client') })

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

beforeEach(() => {
    orchestrator.calls = []
    orchestrator.busy = false
})

describe('P9 /bot team über den Unteragenten-Orchestrator', () => {
    it('Captain und alle Spezialisten laufen als Unteragenten mit Rolle, Identität und Lese-Werkzeugen', async () => {
        const { runTeam } = await import('./team-coordinator.js')
        const answer = await runTeam('default', 'Wie verbessern wir die Startzeit?', undefined, { userId: 'owner-1', authUserId: 'tg-1' })
        // captain decompose + 3 specialists + captain aggregate
        expect(orchestrator.calls).toHaveLength(5)
        expect(orchestrator.calls.every(call => call.userId === 'owner-1' && call.authUserId === 'tg-1')).toBe(true)
        expect(orchestrator.calls.every(call => typeof call.systemPrompt === 'string' && call.systemPrompt.length > 20)).toBe(true)
        expect(orchestrator.calls.every(call => Array.isArray(call.tools) && call.tools.length > 0 && !call.tools.some((tool: string) => ['write_file', 'run_command', 'delete_file'].includes(tool)))).toBe(true)
        expect(answer).toContain('Antwort für')
    })

    it('Grenze erreicht: der Orchestrator lehnt ab, das Team meldet das ehrlich statt anders weiterzurechnen', async () => {
        orchestrator.busy = true
        const { runTeam, runSubAgent } = await import('./team-coordinator.js')
        expect(await runTeam('default', 'Frage', undefined, { userId: 'owner-1' })).toMatch(/Team-Ausführung fehlgeschlagen: Concurrency limit/)
        expect(await runSubAgent('coder', 'Frage', undefined, { userId: 'owner-1' })).toMatch(/fehlgeschlagen: Concurrency limit/)
    })

    it('Quelltext: kein eigener LLM-Weg mehr im Team-Koordinator', () => {
        const source = readFileSync(here('./team-coordinator.ts'), 'utf8')
        expect(source).not.toMatch(/mesh-llm-proxy|nova-llm-sdk|OPENAI_API_KEY|fetch\(/)
        expect(source).toMatch(/subagent-orchestrator\.js/)
    })
})

describe('P9 Multi-Bot → Rollen', () => {
    it('multi-bot.ts ist weg, die Personas sind Rollen (inkl. Übersetzer)', async () => {
        expect(existsSync(here('../layers/multi-bot.ts'))).toBe(false)
        const { BUILT_IN_ROLES } = await import('./agent-roles.js')
        expect(BUILT_IN_ROLES.translator?.name).toBe('Übersetzer')
        const registry = readFileSync(here('../tools/complete-registry.ts'), 'utf8')
        expect(registry).not.toMatch(/name: 'spawn_bot'|name: 'kill_bot'|name: 'list_bots'/)
    })

    it('/bot spawn verweist auf Rollen; /bots listet Rollen', async () => {
        const { handleCommand } = await import('../core/slash-commands.js')
        const state: any = { running: true, channels: {}, config: {}, startTime: Date.now() }
        const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }
        expect(String(await handleCommand('bot', 'spawn Helfer', 'owner-1', state, [], owner))).toMatch(/Personas sind Rollen/)
        expect(String(await handleCommand('bots', '', 'owner-1', state, [], owner))).toMatch(/Übersetzer/)
    })
})
