import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { createLocalLLM } from '../llm/local-llm.js'
import { getToolRegistry } from '../tools/complete-registry.js'
import { resolveConfigPath } from '../config/config-path.js'


async function main(): Promise<void> {
    const registry = getToolRegistry()
    const builder = registry.get('build_skill')
    if (!builder) throw new Error('build_skill is not registered')

    const definition = {
        name: builder.name,
        description: builder.description,
        parameters: {
            type: 'object',
            properties: Object.fromEntries((builder.parameters || []).map((p: any) => [
                p.name,
                { type: p.type || 'string', description: p.description || '' },
            ])),
            required: (builder.parameters || []).filter((p: any) => p.required).map((p: any) => p.name),
        },
    }

    // Exercise the same local-only model class as Nova's isolated learning
    // runtime. A cloud quota must never disable autonomous learning.
    const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
    const vllmNode = (config.nodes || []).find((node: any) => node?.services?.vllm)
    const baseUrl = String(vllmNode?.services?.vllm || '').replace(/\/$/, '')
    if (!baseUrl) throw new Error('No local vLLM service configured for learning')
    const modelPayload: any = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) }).then(response => response.json())
    const model = (modelPayload.data || []).map((entry: any) => String(entry.id || '')).find((name: string) => /qwen/i.test(name))
        || String(modelPayload.data?.[0]?.id || '')
    if (!model) throw new Error('Local learning runtime exposes no model')
    const llm = createLocalLLM({ baseUrl, model, name: 'Learning vLLM', requestTimeoutMs: 45_000 })
    const response = await llm.complete([
        {
            role: 'system',
            content: [
                'Du bist Nova und testest deinen eigenen Self-Learning-Kreislauf.',
                'Erstelle selbst einen kleinen, wiederverwendbaren Skill als reviewbaren Vorschlag.',
                'Du darfst nichts installieren und keine Dateien verändern.',
                'Rufe build_skill genau einmal auf. Der Code muss lokal, deterministisch und ohne Shell funktionieren.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: 'Fehlende Fähigkeit: Berechne für einen übergebenen lokalen Dateipfad die SHA-256-Prüfsumme und gib sie als Hex-String zurück.',
        },
    ], [definition], { toolChoice: 'required' })

    const calls = response.toolCalls || []
    if (calls.length !== 1 || calls[0].name !== 'build_skill') {
        throw new Error(`Nova did not call build_skill exactly once: ${JSON.stringify(calls)}`)
    }

    const result = await registry.execute('build_skill', calls[0].arguments || {})
    console.log(JSON.stringify({
        ok: true,
        modelGenerated: true,
        provider: 'vllm',
        model,
        tool: calls[0].name,
        arguments: calls[0].arguments,
        result,
    }, null, 2))
}

main().catch(err => {
    console.error('[SelfLearningE2E] FAILED', err)
    process.exitCode = 1
})
