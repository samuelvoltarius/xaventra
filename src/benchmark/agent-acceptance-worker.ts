// Dedicated disposable process: establish isolation before importing the runtime.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const jobPath = resolve(process.argv[2])
const job = JSON.parse(readFileSync(jobPath, 'utf8'))
process.chdir(job.root)
process.env.NODE_ENV = 'test'
process.env.NOVA_TEST_MODE = '1'
process.env.NOVA_NO_SIDE_EFFECTS = '1'
process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
process.env.NOVA_RUNTIME_ROOT = job.root
process.env.NOVA_MAX_TOOL_ROUNDS = '3'
process.env.OTEL_SDK_DISABLED = 'true'
const { getLifecyclePolicy } = await import('../core/lifecycle-policy.js')
const { runNovaAgent } = await import('../agents/nova-runner.js')
const { createTaskContract } = await import('../core/task-contract.js')
const { detectActionIntent } = await import('../core/action-intent.js')
const { getOrCreateUser } = await import('../users/multi-user-middleware.js')
const { OutcomeLedger, withOutcomeLedger } = await import('../core/outcome-ledger.js')
const { withModelPerformanceRecording } = await import('../llm/model-perf-db.js')
const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')

const allowed = new Set<string>(job.files.map((file: string) => resolve(job.root, file)))
getLifecyclePolicy().register({
    id: 'acceptance-read-only', event: 'tool.before', priority: -1000, failClosed: true,
    handler: payload => payload.toolName === 'read_file' && allowed.has(resolve(String(payload.input?.path || '')))
        ? { decision: 'allow' } : { decision: 'deny', reason: 'Acceptance test permits only its exact fixture reads' },
})
getOrCreateUser(job.userId, 'acceptance')
// This executable is a disposable acceptance worker, never a daemon ingress.
// Explicit synthetic output-hook cases prove that postprocessors cannot publish
// changed/denied text with an earlier successful validation.
if (job.outputHook === 'append' || job.outputHook === 'deny') getLifecyclePolicy().register({
    id: 'acceptance-output-hook', event: 'message.after', priority: -1000, failClosed: true,
    handler: payload => job.outputHook === 'deny' ? { decision: 'deny', reason: 'Synthetic delivery denial' }
        : { decision: 'allow', updatedOutput: { content: `${(payload.output as { content?: string })?.content} EXTRA` } },
})
const provider = await createNovaLLMClient({ provider: 'local', model: job.model, baseUrl: job.baseUrl, isolated: true })
let modelCalls = 0
const llm = {
    modelId: job.model, providerId: 'local',
    complete: (messages: any[], tools?: any[], options?: any) => {
        if (++modelCalls > 6) throw new Error('Acceptance model-call budget exhausted')
        return provider.complete(messages, tools, { ...options, maxTokens: Math.min(512, options?.maxTokens ?? 512), timeoutMs: Math.min(15_000, options?.timeoutMs ?? 15_000), maxAttempts: 1 })
    },
}
const intent = detectActionIntent(job.prompt)
const contract = createTaskContract(job.prompt, { ...intent, requiresTool: job.requiresTool }, job.requiresTool ? ['read_file'] : [], {
    allowedChanges: { readOnly: true, externalSideEffects: false, allowedPaths: [join(job.root, 'fixtures')] },
    budget: { timeoutMs: 50_000, maxToolCalls: 6 },
})
const ledger = new OutcomeLedger(join(job.root, 'ledger'), false)
const startedAt = Date.now()
const invoke = () => withOutcomeLedger(ledger, async () => withModelPerformanceRecording(false, () => runNovaAgent({
    userId: job.userId, channel: 'acceptance', content: job.prompt, llm,
    conversationId: job.room || 'acceptance', botId: 'nova', contract,
    tools: job.requiresTool ? [{ name: 'read_file' }] : [],
    abortSignal: AbortSignal.timeout(50_000),
    systemPrompt: 'Du bist Xaventra. Antworte kurz auf Deutsch. Lies angeforderte Dateien mit read_file. Behaupte niemals einen nicht ausgeführten Schritt. Verwende den bisherigen Gesprächskontext. Gib nur die Antwort aus, keine internen Denktexte.',
})))
let result: Awaited<ReturnType<typeof runNovaAgent>>
if (job.useRest) {
    const { startRestApi } = await import('../server/rest-api.js')
    process.env.NOVA_API_TOKEN = randomUUID()
    const server = await startRestApi({ enabled: true, host: '127.0.0.1', port: 0 }, async (_channel, _from, request, reply) => {
        if (request !== job.prompt) throw new Error('Unexpected acceptance input')
        result = await invoke()
        await reply(result.content)
    }, () => ({ test: true }))
    try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/message`, {
            method: 'POST', headers: { Authorization: `Bearer ${process.env.NOVA_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: job.prompt }), signal: AbortSignal.timeout(50_000),
        })
        const payload: any = await response.json()
        if (!response.ok || payload.response !== result?.content) throw new Error('REST response did not match kernel output')
    } finally {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
    }
} else result = await invoke()
const run = ledger.getRun(contract.id)
writeFileSync(job.resultPath, JSON.stringify({
    output: result.content, validation: result.validation, error: result.error,
    validations: run?.events.filter(event => event.type === 'validation.finished').map(event => event.payload.validation) || [],
    totalTokens: run?.totalTokens, costs: run?.costs,
    tools: run?.tools || [], status: run?.status, modelCalls,
    durationMs: Date.now() - startedAt,
    stages: [...(job.useRest ? ['rest.authenticated', 'rest.response'] : []), ...new Set(run?.events.map(event => event.type) || [])],
}), { mode: 0o600 })
// Let provider/native cleanup finish. Forced process.exit can race libuv
// async-handle teardown on Windows even after the result was persisted.
process.exitCode = 0
