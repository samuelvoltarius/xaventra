// Real compiled Desktop API + message pipeline in a disposable child process.
// Only the model and optional subsystems are fixtures; tools/validator/ledger
// are production code. This does not start the full daemon or production nodes.
import express from 'express'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = resolve(import.meta.dirname, '../..')
const root = resolve(process.argv[2])
process.chdir(root)
const load = relative => import(pathToFileURL(join(source, 'dist', relative)).href)
const principal = 'desktop-core-test'
const allowed = join(root, 'fixture-evidence.txt')
const forbidden = join(root, 'fixture-denied.txt')
writeFileSync(allowed, 'VERIFIED_DESKTOP_CORE_731\n')
writeFileSync(forbidden, 'DENIED_CONTENT_MUST_NOT_LEAK\n')
mkdirSync(join(root, '.nova-data'), { recursive: true })
writeFileSync(join(root, 'SOUL.md'), '# Xaventra\nAntworte kurz auf Deutsch. Nutze echte Tools.\n')
writeFileSync(join(root, '.nova-data/soul.md'), '# Xaventra\n')
let modelCalls = 0
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  res.setHeader('Content-Type', 'application/json')
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  writeFileSync(join(root, 'last-model-request.json'), JSON.stringify(input))
  modelCalls++
  if (modelCalls > 30) { res.statusCode = 429; return res.end('{}') }
  const messages = input.messages || []
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const prompt = String(messages[lastUser]?.content || '')
  const observed = messages.slice(lastUser + 1).filter(message => message.role === 'tool')
  const needsFile = /fixture-(?:evidence|denied)\.txt/.test(prompt)
  const hasReadResult = prompt.includes('VERIFIED_DESKTOP_CORE_731') || observed.some(message => String(message.content).includes('VERIFIED_DESKTOP_CORE_731'))
  const tool = (input.tools || []).find(tool => tool.function?.name.replaceAll('_', '') === 'readfile')
  const message = needsFile && tool && observed.length === 0 && !hasReadResult
    ? { role: 'assistant', content: '', tool_calls: [{ id: `fixture-read-${modelCalls}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ path: prompt.includes('fixture-denied.txt') ? forbidden : allowed }) } }] }
    : { role: 'assistant', content: hasReadResult
      ? 'Gelesen: VERIFIED_DESKTOP_CORE_731.' : observed.length ? 'Der Zugriff wurde verweigert.' : 'Guten Abend aus dem isolierten Core.' }
  res.end(JSON.stringify({ id: `fixture-${modelCalls}`, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }))
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${model.address().port}/v1`
const config = { name: 'Xaventra', provider: 'local', model: 'fixture-model', fallbackModels: [],
  providers: { local: { enabled: true, baseUrl } }, userPrincipals: {},
  multiUser: { enabled: true }, autonomy: { enabled: false }, mesh: { enabled: false }, mcp: { servers: [] } }
writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(config))
writeFileSync(join(root, 'package.json'), readFileSync(join(source, 'package.json')))
const { initNovaState } = await load('core/nova-state.js')
const { setNovaConfig } = await load('core/config.js')
setNovaConfig(config)
const { createNovaLLMClient } = await load('llm/nova-llm-sdk.js')
const llm = await createNovaLLMClient({ provider: 'local', model: 'fixture-model', baseUrl, isolated: true })
const state = initNovaState({ running: true, runtimeReady: true, config, llm, channels: {}, startTime: Date.now() })
const { availableLLMs } = await load('core/llm-factory.js')
availableLLMs.push({ provider: 'local', model: 'fixture-model', endpoint: baseUrl, local: true })
const { getLifecyclePolicy } = await load('core/lifecycle-policy.js')
getLifecyclePolicy().register({ id: 'desktop-core-read-only', event: 'tool.before', priority: -1000, failClosed: true,
  handler: payload => payload.toolName === 'read_file' && resolve(String(payload.input?.path || '')) === allowed
    ? { decision: 'allow' } : { decision: 'deny', reason: 'Disposable acceptance permits only its exact evidence file' } })
const { acquireServiceLease } = await load('mesh/leader-election.js')
await acquireServiceLease('nova-main'); await acquireServiceLease('dashboard')
const { getTopicRoomStore } = await load('desktop/topic-room-store.js')
const room = getTopicRoomStore().createRoom(principal, { title: 'Core acceptance', topic: '', botIds: ['nova'], preferredNodeIds: [], modelMode: 'auto' })
const { getMemoryGovernanceCoordinator } = await load('memory/memory-governance.js')
for (const [owner, marker] of [[principal, 'OWN_SCOPED_MEMORY_731'], ['different-user', 'OTHER_SCOPED_MEMORY_912']]) {
  getMemoryGovernanceCoordinator().propose({ content: `Preference: ${marker}`, kind: 'preference', scope: `user:desktop:${owner}`,
    source: 'desktop-core-fixture', evidence: 'explicit_user_instruction', confidence: 1, verified: true })
}
const { getOutcomeLedger } = await load('core/outcome-ledger.js')
getOutcomeLedger().append('unscoped-fixture-run', 'run.started', { channel: 'internal' })
const { handleMessage } = await load('core/message-pipeline.js')
const { getDesktopAgentContext } = await load('desktop/desktop-agent-context.js')
const { registerDesktopApi } = await load('desktop/desktop-api.js')
const { handleCommand } = await load('core/slash-commands.js')
const app = express(); app.use(express.json())
registerDesktopApi(app, () => async (message, channel) => {
  let response = ''
  await handleMessage(channel, getDesktopAgentContext()?.authorizationUserId || 'dashboard', message,
    async value => { response = value }, state, (cmd, args, from, context) => handleCommand(cmd, args, from, state, availableLLMs, context))
  return response || 'Keine Antwort generiert.'
})
const server = app.listen(0, '127.0.0.1', () => process.send?.({ endpoint: `http://127.0.0.1:${server.address().port}`, principal, roomId: room.id, allowed, forbidden }))
process.on('message', message => {
  if (message !== 'shutdown') return
  server.closeAllConnections(); model.closeAllConnections()
  server.close(); model.close()
  // Runtime optional modules retain timers. This fixture process is disposable
  // and only its parent may terminate it after all output has been persisted.
  process.send?.({ stopped: true, modelCalls })
})
