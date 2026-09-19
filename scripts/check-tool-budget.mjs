// Real native runner / registry / filesystem / ledger, separate disposable users.
// Default: scripted HTTP provider. --live URL MODEL uses an actual unauthenticated
// local model, with only disposable fixture paths and no production configuration.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = process.cwd(), live = process.argv[2] === '--live'
const parent = process.env.XAVENTRA_TOOL_BUDGET_QA_DIR || tmpdir(); mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, 'xaventra-tool-budget-'))
const report = { version: JSON.parse(readFileSync('package.json')).version,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: process.platform, provider: live ? 'live-local-model' : 'scripted-http',
  scope: 'Compiled native runner, real read_file, policy and ledger; not production Telegram or complete CLI/RC acceptance', cases: [] }
let active
const server = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  const chunks = []; for await (const part of req) chunks.push(part)
  const body = JSON.parse(Buffer.concat(chunks)); active.requests.push(body)
  const index = active.requests.length - 1
  const call = (file) => ({ role: 'assistant', content: '', tool_calls: [{ id: `read-${index}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: join(active.root, 'fixtures', file) }) } }] })
  let message = call('a.txt'), output = 47
  if (active.id === 'provider-exceeds-limit') output = 1025
  else if (active.id === 'exhausted-after-read') output = 512
  else if (index === 1 && active.id === 'two-file-chain') message = call('b.txt')
  else if (index > 0) {
    // Learn tokens only from the real tool messages, not from the initial prompt.
    const evidence = body.messages.filter(item => item.role === 'tool').map(item => item.content).join('\n')
    const tokens = [...new Set(evidence.match(/CANARY-[a-f0-9-]+/g) || [])]
    message = { role: 'assistant', content: tokens.join(' ') }; output = active.id === 'follow-up-exceeds-limit' ? 1025 : 20
  }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5333, completion_tokens: output, total_tokens: 5333 + output } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = live ? process.argv[3] : `http://127.0.0.1:${server.address().port}`
try {
  for (const id of live ? ['read-canary', 'two-file-chain'] : ['read-canary', 'two-file-chain', 'zero-total-budget', 'provider-exceeds-limit', 'exhausted-after-read', 'follow-up-exceeds-limit']) {
    const caseRoot = mkdtempSync(join(root, `${id}-`)); mkdirSync(join(caseRoot, 'fixtures'))
    const tokens = [randomUUID(), randomUUID()].map(value => `CANARY-${value}`)
    for (const [i, file] of ['a.txt', 'b.txt'].entries()) writeFileSync(join(caseRoot, 'fixtures', file), tokens[i])
    const files = id === 'two-file-chain' ? ['a.txt', 'b.txt'] : ['a.txt']
    const prompt = `Lies ${files.map(file => join(caseRoot, 'fixtures', file)).join(' und ')} mit read_file. Antworte ausschließlich mit den gefundenen CANARY-Kennungen, durch ein Leerzeichen getrennt.`
    const resultPath = join(caseRoot, 'result.json'), jobPath = join(caseRoot, 'job.json')
    writeFileSync(jobPath, JSON.stringify({ root: caseRoot, resultPath, prompt, baseUrl, model: live ? process.argv[4] : 'fixture-tool-model',
      files: files.map(file => `fixtures/${file}`), requiresTool: true, userId: `budget-${id}`,
      budget: { maxOutputTokens: id === 'exhausted-after-read' ? 512 : 1024, ...(id === 'zero-total-budget' ? { maxTokens: 0 } : {}) } }))
    active = { id, root: caseRoot, requests: [] }
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    Object.assign(env, { HOME: caseRoot, USERPROFILE: caseRoot, APPDATA: join(caseRoot, 'appdata'), LOCALAPPDATA: join(caseRoot, 'localappdata'), CODEX_HOME: join(caseRoot, 'codex') })
    const child = spawn(process.execPath, [resolve('dist/benchmark/agent-acceptance-worker.js'), jobPath], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false
    child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    const timer = setTimeout(() => { timeout = true; child.kill() }, 90_000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      assert.equal(timeout, false); assert.equal(code, 0, log.slice(-1200))
      const result = JSON.parse(readFileSync(resultPath, 'utf8'))
      if (id === 'zero-total-budget' || id === 'provider-exceeds-limit') {
        assert.equal(result.status, 'failed'); assert.equal(result.tools.length, 0)
        assert.equal(active.requests.length, id === 'zero-total-budget' ? 0 : 1)
      } else if (id === 'exhausted-after-read' || id === 'follow-up-exceeds-limit') {
        assert.equal(result.status, 'failed'); assert.equal(result.validation.success, false)
        assert.equal(result.tools.length, 1); assert.equal(result.tools[0].success, true)
        assert.equal(active.requests.length, id === 'exhausted-after-read' ? 1 : 2)
        assert.equal(result.totalTokens, id === 'exhausted-after-read' ? 5845 : 11738)
      } else {
        assert.equal(result.status, 'completed', JSON.stringify(result))
        assert.equal(result.validation.success, true)
        assert.equal(result.output.trim(), tokens.slice(0, files.length).join(' '), 'Only the final answer counts as acceptance')
        for (const file of files) assert.ok(result.tools.some(tool => tool.toolName === 'read_file' && tool.success && tool.params.path === join(caseRoot, 'fixtures', file)))
        if (!live) {
          const calls = files.length + 1
          assert.equal(active.requests.length, calls)
          assert.equal(result.totalTokens, 5333 * calls + 47 * files.length + 20)
          assert.deepEqual(active.requests.map(request => request.max_tokens), Array.from({ length: calls }, (_, i) => Math.min(512, 1024 - i * 47)))
          assert.ok(active.requests[0].messages.every(message => !tokens.some(token => String(message.content).includes(token))))
        }
      }
      report.cases.push({ id, pass: true, modelCalls: result.modelCalls, tokens: result.totalTokens, durationMs: result.durationMs })
    } catch (error) { report.cases.push({ id, pass: false, error: String(error) }); process.exitCode = 1 }
    finally { clearTimeout(timer); writeFileSync(join(caseRoot, 'worker.log'), log) }
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  report.completedAt = new Date().toISOString(); writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ report: join(root, 'report.json'), ...report }, null, 2))
}
