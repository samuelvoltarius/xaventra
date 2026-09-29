// Opt-in actual model + SDK + kernel acceptance against a controlled HTTP server.
// No production channel, role override, shell, or external URL execution.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const endpoint = process.env.XAVENTRA_QA_MODEL_URL
assert.ok(endpoint, 'Set an explicitly configured model endpoint')
const root = mkdtempSync(join(tmpdir(), 'xaventra-routing-'))
process.chdir(root)
Object.assign(process.env, { NODE_ENV: 'test', NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1',
  NOVA_SKIP_MODEL_RESOLVER_INIT: '1', NOVA_NO_TELEGRAM: 'true', NOVA_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
  HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root })
const observed = []
const server = createServer((request, response) => {
  observed.push(request.url)
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ results: [{ title: 'Controlled Agent result' }] }))
})
const report = { scope: 'actual model/SDK/kernel; controlled HTTP adapter, not production tool authorization or Telegram acceptance', success: false }
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const expected = `${base}/search?q=Agent&format=json`
  const content = `test es noch mal [24.09.2026 18:27] User: check mal url --get '${base}/search' --data-urlencode 'q=Agent' --data-urlencode 'format=json'`
  const { ExecutionKernel } = await import('../dist/core/execution-kernel.js')
  const { runGovernedSdkLoop } = await import('../dist/agents/governed-sdk-loop.js')
  const { createNovaLLMClient } = await import('../dist/llm/nova-llm-sdk.js')
  const { loadSkillPackTool } = await import('../dist/tools/tool-router.js')
  const { evaluateClarification } = await import('../dist/core/clarification-gate.js')
  const listing = await fetch(`${endpoint.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(10000) })
  assert.ok(listing.ok)
  const models = await listing.json()
  const model = models.data?.find(item => item.id === (process.env.XAVENTRA_QA_MODEL || 'qwen'))?.id || models.data?.[0]?.id
  assert.ok(model)
  report.model = model
  const client = await createNovaLLMClient({ provider: 'local', model, baseUrl: endpoint, isolated: true })
  assert.equal(evaluateClarification('fixture-user', content).action, 'continue')
  const kernel = new ExecutionKernel(content)
  assert.ok(kernel.contract.allowedChanges.allowedTools.includes('fetch_url'))
  assert.ok(!kernel.contract.allowedChanges.allowedTools.includes('searxng_search'))
  // The fixture executor is narrower than the real immutable contract.
  const tools = [{ name: 'fetch_url', description: 'Read the exact requested URL via HTTP GET.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }]
  const messages = [{ role: 'system', content: 'Check the requested URL using the offered tool. Preserve query values and report only observed results.' }, { role: 'user', content }]
  const initialResponse = await client.complete(messages, tools)
  const output = await runGovernedSdkLoop({ messages, tools, initialResponse, modelOptions: { client }, maxTurns: 4,
    signal: AbortSignal.timeout(60000), execute: async call => {
      kernel.assertCanExecute(call.name)
      assert.equal(call.name, 'fetch_url')
      assert.equal(call.arguments.url, expected, 'No fixture request to an unapproved target')
      assert.equal(observed.length, 0, 'No duplicate HTTP effect')
      const response = await fetch(expected, { signal: AbortSignal.timeout(5000) })
      const result = { success: response.ok, status: response.status, content: await response.text() }
      assert.ok(kernel.verify(call.name, result, { callId: call.id, arguments: call.arguments }).success)
      return JSON.stringify(result)
    } })
  report.validation = kernel.validateCompletion(output)
  assert.ok(report.validation.success, JSON.stringify(report.validation))
  assert.deepEqual(observed, ['/search?q=Agent&format=json'])
  assert.match(await loadSkillPackTool.handler({ pack_name: 'web' }), /web-search/)
  report.requests = observed.length
  report.output = output
  report.success = true
} catch (error) {
  report.error = String(error)
  process.exitCode = 1
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ path: join(root, 'report.json'), ...report }, null, 2))
  process.exit(process.exitCode || 0)
}
