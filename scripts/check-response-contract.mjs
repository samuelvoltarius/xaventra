// Actual compiled native runner + authenticated REST, scripted local provider.
// No production configuration, credentials, memory, tools or model is accessed.
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const source = process.cwd()
const parent = process.env.XAVENTRA_RESPONSE_QA_DIR || tmpdir()
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, 'xaventra-response-contract-'))
const report = { version: JSON.parse(readFileSync('package.json')).version,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: process.platform, provider: 'scripted-loopback', startedAt: new Date().toISOString(), cases: [] }
let active
const server = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  const chunks = []; for await (const part of req) chunks.push(part)
  const body = JSON.parse(Buffer.concat(chunks))
  active.calls++
  const output = active.outputs[Math.min(active.calls - 1, active.outputs.length - 1)]
  active.tools.push(body.tools || [])
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ id: `reply-${active.calls}`, choices: [{ message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
try {
  const cases = [
    { id: 'correction-repair', prompt: 'Korrektur: Die Projektkennung lautet jetzt ORBIT-42. Die vorherige Kennung ist ungültig. Bestätige nur die neue Kennung.', outputs: ['ORBIT-42 (ORBIT-41 ist ungültig.)', 'ORBIT-42'], calls: 2, success: true },
    { id: 'repeated-invalid', prompt: 'Return only "POLAR-17"', outputs: ['POLAR-17 plus obsolete value'], calls: 2, success: false },
    { id: 'short-literal', prompt: 'Antworte nur mit "OK"', outputs: ['OK'], calls: 1, success: true },
    { id: 'post-hook-mutation', prompt: 'Return only "CURRENT-51"', outputs: ['CURRENT-51'], outputHook: 'append', calls: 1, success: false },
    { id: 'post-hook-denial', prompt: 'Return only "CURRENT-52"', outputs: ['CURRENT-52'], outputHook: 'deny', calls: 1, success: false },
  ]
  for (const item of cases) {
    active = { outputs: item.outputs, calls: 0, tools: [] }
    const caseRoot = mkdtempSync(join(root, `${item.id}-`))
    const resultPath = join(caseRoot, 'result.json')
    const job = { root: caseRoot, resultPath, prompt: item.prompt, baseUrl, model: 'fixture-model',
      files: [], requiresTool: false, userId: 'response-contract-user', useRest: true, outputHook: item.outputHook }
    const jobPath = join(caseRoot, 'job.json'); writeFileSync(jobPath, JSON.stringify(job))
    const child = spawn(process.execPath, [resolve('dist/benchmark/agent-acceptance-worker.js'), jobPath], {
      cwd: source, windowsHide: true, env: {
        ...Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]])),
        HOME: caseRoot, USERPROFILE: caseRoot, APPDATA: join(caseRoot, 'appdata'), LOCALAPPDATA: join(caseRoot, 'localappdata'), CODEX_HOME: join(caseRoot, 'codex'),
      }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 60_000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      assert.equal(timedOut, false); assert.equal(code, 0, log.slice(-2000))
      const result = JSON.parse(readFileSync(resultPath, 'utf8'))
      assert.equal(result.validation.success, item.success)
      assert.equal(result.status, item.success ? 'completed' : 'failed')
      assert.equal(result.modelCalls, item.calls)
      assert.equal(result.tools.length, 0)
      assert.equal(active.tools.every(tools => tools.length === 0), true)
      assert.equal(result.totalTokens, 110 * item.calls, 'repair usage must be included')
      if (item.id === 'correction-repair') {
        assert.equal(result.output, 'ORBIT-42')
        assert.equal(result.validations[0].success, false, 'keep initial failure evidence')
        assert.equal(result.validations.at(-1).success, true)
      }
      if (!item.success) assert.equal(result.output.includes('EXTRA'), false, 'invalid draft cannot reach delivery')
      report.cases.push({ id: item.id, pass: true, modelCalls: result.modelCalls, tokens: result.totalTokens })
    } catch (error) { report.cases.push({ id: item.id, pass: false, error: String(error) }); process.exitCode = 1 }
    finally { clearTimeout(timer); writeFileSync(join(caseRoot, 'worker.log'), log) }
  }
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  report.completedAt = new Date().toISOString()
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ report: join(root, 'report.json'), ...report }, null, 2))
}
