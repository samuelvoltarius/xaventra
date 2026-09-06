// Full compiled daemon with its production channel gateway. Only the optional
// provider and input data are fixtures; no state/handler/lease is substituted.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
writeFileSync(join(root, 'package.json'), readFileSync(join(source, 'package.json')))

let modelCalls = 0
const provider = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString() || '{}')
  writeFileSync(join(root, 'last-model-request.json'), JSON.stringify(input))
  if (input.model !== 'fixture-model') {
    res.statusCode = 404
    return res.end(JSON.stringify({ error: { message: `Unknown fixture model: ${input.model}` } }))
  }
  if (++modelCalls > 60) { res.statusCode = 429; return res.end('{}') }
  const messages = input.messages || []
  const prompt = String(messages.findLast(message => message.role === 'user')?.content || '')
  const lastUser = messages.findLastIndex(message => message.role === 'user')
  const results = messages.slice(0, lastUser).filter(message => message.role === 'tool').map(message => String(message.content)).join('\n')
  const tool = input.tools?.find(tool => tool.function?.name.replaceAll('_', '') === 'readfile')
  const observed = !/fixture-denied\.txt/.test(prompt) && (prompt.includes('VERIFIED_DESKTOP_CORE_731') || results.includes('VERIFIED_DESKTOP_CORE_731'))
  const denied = /fixture-denied\.txt/.test(prompt)
  const needsFile = /fixture-(?:evidence|denied)\.txt/.test(prompt) && !prompt.startsWith('Tool-Ergebnisse')
  const recalling = /Welchen Inhalt hatte/.test(prompt)
  const history = JSON.stringify(messages.slice(0, -1))
  const message = needsFile && tool && !observed
    ? { role: 'assistant', content: '', tool_calls: [{ id: `read-${modelCalls}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ path: denied ? forbidden : allowed }) } }] }
    : { role: 'assistant', content: observed || (recalling && history.includes('VERIFIED_DESKTOP_CORE_731'))
      ? 'Gelesen: VERIFIED_DESKTOP_CORE_731.' : 'Guten Abend aus dem isolierten Daemon.' }
  res.end(JSON.stringify({ id: `fixture-${modelCalls}`, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }))
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = Number(process.env.XAVENTRA_ACCEPTANCE_DASHBOARD_PORT) || probe.address().port
await new Promise(resolve => probe.close(resolve))
const baseUrl = process.env.XAVENTRA_ACCEPTANCE_BASE_URL || `http://127.0.0.1:${provider.address().port}/v1`
const model = process.env.XAVENTRA_ACCEPTANCE_MODEL || 'fixture-model'
const config = JSON.parse(readFileSync(join(source, 'xaventra.config.example.json'), 'utf8'))
Object.assign(config, {
  provider: 'local', model, fallbackModels: [], providers: { local: { enabled: true, baseUrl } },
  doctorModel: 'off', internalModel: 'auto', repairModel: 'off', learningModel: 'off',
  autonomy: { enabled: false, socialCheckIns: false, triggers: { 'dream-cycle': false } },
  dashboard: { enabled: true, host: '127.0.0.1', port }, server: { enabled: false },
})
config.mesh.update.nodes = []; config.mesh.coordination.witnesses = []; config.mcp.servers = []
writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(config))
// Add a restrictive test hook, never replace production policy. This entire
// process may read one exact synthetic file; all other tools are denied.
const { getLifecyclePolicy } = await load('core/lifecycle-policy.js')
getLifecyclePolicy().register({ id: 'desktop-daemon-read-only', event: 'tool.before', priority: -1000, failClosed: true,
  handler: payload => payload.toolName === 'read_file' && resolve(String(payload.input?.path || '')) === allowed
    ? { decision: 'allow' } : { decision: 'deny', reason: 'Disposable acceptance permits only its exact evidence file' } })
const { getTopicRoomStore } = await load('desktop/topic-room-store.js')
const rooms = getTopicRoomStore()
const room = rooms.listRooms(principal)[0] || rooms.createRoom(principal, { title: 'Daemon acceptance', topic: '', botIds: ['nova'], preferredNodeIds: [], modelMode: 'auto' })
if (!existsSync(join(root, '.nova-data', 'fixture-seeded'))) {
  const { getMemoryGovernanceCoordinator } = await load('memory/memory-governance.js')
  for (const [owner, marker] of [[principal, 'OWN_SCOPED_MEMORY_731'], ['different-user', 'OTHER_SCOPED_MEMORY_912']]) {
    getMemoryGovernanceCoordinator().propose({ content: `Preference: ${marker}`, kind: 'preference', scope: `user:desktop:${owner}`,
      source: 'desktop-daemon-fixture', evidence: 'explicit_user_instruction', confidence: 1, verified: true })
  }
  const { getOutcomeLedger } = await load('core/outcome-ledger.js')
  getOutcomeLedger().append('unscoped-fixture-run', 'run.started', { channel: 'internal' })
  writeFileSync(join(root, '.nova-data', 'fixture-seeded'), 'synthetic data only')
}
const { getNovaState } = await load('core/nova-state.js')
// Loaded using node --import before the real dist/daemon.js entry point.
// Do not start or replace the daemon here.
const ready = setInterval(async () => {
  if (!getNovaState().runtimeReady || !existsSync(join(root, '.nova-data', 'daemon-control.json'))) return
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/desktop/bootstrap`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok || !(await response.json()).controlPlane?.authoritative) return
    clearInterval(ready)
    process.send?.({ endpoint: `http://127.0.0.1:${port}`, principal, roomId: room.id, allowed, forbidden, fullDaemon: true, pid: process.pid, model })
  } catch { /* readiness deadline belongs to the parent */ }
}, 200)
