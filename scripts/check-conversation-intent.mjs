// Opt-in live inference, isolated data and no executable tools. Not Telegram QA.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const endpoint = process.env.XAVENTRA_QA_MODEL_URL
assert.ok(endpoint, 'An explicitly configured model endpoint is required')
const root = mkdtempSync(join(tmpdir(), 'xaventra-conversation-'))
process.chdir(root)
Object.assign(process.env, { NODE_ENV: 'test', NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1',
  NOVA_SKIP_MODEL_RESOLVER_INIT: '1', NOVA_NO_TELEGRAM: 'true', NOVA_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
  HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root })
const report = { scope: 'isolated clarification + execution kernel + live model/SDK runner; not installed or Telegram acceptance', cases: [] }
try {
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(10000) })
  assert.ok(response.ok)
  const models = await response.json()
  const model = models.data?.find(item => item.id === process.env.XAVENTRA_QA_MODEL)?.id || models.data?.[0]?.id
  assert.ok(model)
  const { createNovaLLMClient } = await import('../dist/llm/nova-llm-sdk.js')
  const { getToolRegistry } = await import('../dist/tools/complete-registry.js')
  const { ExecutionKernel } = await import('../dist/core/execution-kernel.js')
  const { evaluateClarification } = await import('../dist/core/clarification-gate.js')
  const { conversationResponseGuidance } = await import('../dist/core/action-intent.js')
  const { runNovaAgent } = await import('../dist/agents/nova-runner.js')
  const registry = getToolRegistry()
  let attemptedEffects = 0
  for (const definition of registry.getAll()) registry.register({ ...definition, handler: async () => {
    attemptedEffects++
    throw new Error('Conversation acceptance forbids effects')
  } })
  const llm = await createNovaLLMClient({ provider: 'local', model, baseUrl: endpoint, isolated: true })
  report.model = model
  for (const [index, content] of [
    'Du wirst nun ent docker und native installiert dann hast du die Full power',
    'Ich installiere dich morgen nativ.',
    'Wie installiere ich Docker?',
  ].entries()) {
    const principal = `conversation-acceptance-${index}`
    const decision = evaluateClarification(principal, content)
    assert.equal(decision.action, 'continue')
    assert.equal(decision.content, content)
    const kernel = new ExecutionKernel(content)
    assert.equal(kernel.intent.requiresTool, false)
    assert.deepEqual(kernel.selectWorkerTools(), [])
    const reply = await runNovaAgent({ userId: principal, channel: 'acceptance', content, llm,
      systemPrompt: 'Du bist Nova, ein lokaler KI-Assistent. Antworte auf Deutsch und behaupte keine unbestätigten Aktionen oder Fähigkeiten.' + conversationResponseGuidance(content),
      abortSignal: AbortSignal.timeout(60000) })
    report.cases.push({ content, response: reply.content, validation: reply.validation, tools: reply.toolsExecuted })
    assert.ok(reply.content.trim())
    assert.ok(reply.validation?.success)
    assert.equal(reply.toolsExecuted.length, 0)
    assert.doesNotMatch(reply.content, /Auf welchem Node, Dienst oder Ziel|kein passendes Tool erfolgreich/)
    assert.doesNotMatch(reply.content, /rein textbasiert|keinen? (?:direkten )?Zugriff auf das (?:Host-)?System/i,
      'No-tool conversation is not evidence of missing host capabilities')
  }
  assert.equal(attemptedEffects, 0)
  report.attemptedEffects = attemptedEffects
  report.success = true
} catch (error) {
  report.success = false
  report.error = String(error)
  process.exitCode = 1
} finally {
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ path: join(root, 'report.json'), ...report }, null, 2))
  process.exit(process.exitCode || 0)
}
