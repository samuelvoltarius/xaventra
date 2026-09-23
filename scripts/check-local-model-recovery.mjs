import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === '--child') {
  process.chdir(process.argv[3])
  process.env.NOVA_RUNTIME_ROOT = process.cwd()
  process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
  process.env.NOVA_OS_MODE = 'false'
  const { createNovaLLMClient } = await import('../dist/llm/nova-llm-sdk.js')
  const { recordModelCall, isModelDisabled } = await import('../dist/llm/model-perf-db.js')
  const model = 'recovery-fixture'
  if (process.argv[5] === 'seed') for (let i = 0; i < 5; i++) recordModelCall(model, 'chat', 1, false)
  const client = await createNovaLLMClient({ provider: 'local', model, baseUrl: process.argv[4] })
  let ok = false
  try { const result = await client.complete([{ role: 'user', content: 'Reply OK' }], [], { timeoutMs: 2000, maxTokens: 8 }); ok = result.content === 'OK' } catch { /* expected fail-closed case */ }
  // Flush the ordinary 5-second performance write debounce before process exit.
  await new Promise(resolve => setTimeout(resolve, 5200))
  writeFileSync(join(process.cwd(), `result-${process.argv[5]}.json`), JSON.stringify({ ok, disabled: isModelDisabled(model) }))
  process.exit(0)
}
const output = join(root, '.nova-data', 'local-model-recovery-qa')
mkdirSync(output, { recursive: true })
const runtime = mkdtempSync(join(output, 'runtime-'))
let calls = 0, healthy = false
const server = createServer((req, res) => {
  req.resume(); req.on('end', () => {
    calls++
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
    res.end(healthy ? JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) : '{"error":"fixture unavailable"}')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `http://127.0.0.1:${server.address().port}/v1`
async function child(mode, directory = runtime) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', directory, endpoint, mode], { cwd: root, stdio: 'pipe' })
    let stderr = ''; p.stderr.on('data', b => { stderr += b }); p.stdout.resume()
    const timer = setTimeout(() => { p.kill(); reject(new Error('child deadline')) }, 20000)
    p.on('error', error => { clearTimeout(timer); reject(error) })
    p.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child ${code}: ${stderr}`)) })
  })
  return JSON.parse(readFileSync(join(directory, `result-${mode}.json`), 'utf8'))
}
let report
try {
  const first = await child('seed')
  const afterFirst = calls
  const second = await child('restart')
  const afterRestart = calls
  healthy = true
  const fresh = mkdtempSync(join(output, 'healthy-'))
  const recovered = await child('seed', fresh)
  const checks = { oneBoundedRequest: afterFirst === 1 && !first.ok,
    restartDoesNotResetAdmission: afterRestart === 1 && !second.ok && second.disabled,
    realHttpRecoveryClearsHold: calls === 2 && recovered.ok && !recovered.disabled }
  report = { evidenceClass: 'real-http-and-process-restart-with-scripted-provider',
    sourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    sourceDirty: !!spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    checks, passed: Object.values(checks).every(Boolean) }
} catch (error) { report = { passed: false, error: String(error) } }
finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1
