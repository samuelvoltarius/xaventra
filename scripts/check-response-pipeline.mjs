// Production Desktop HTTP ingress/message pipeline, not a browser or full daemon.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const source = process.cwd()
const parent = process.env.XAVENTRA_RESPONSE_QA_DIR || tmpdir(); mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, 'xaventra-response-pipeline-'))
const report = { version: JSON.parse(readFileSync('package.json')).version,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  platform: process.platform, provider: 'scripted-loopback', scope: 'Actual Desktop API + message pipeline, minimal runtime fixture, not packaged UI/full daemon', cases: [] }
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), CODEX_HOME: join(root, 'codex'),
  NODE_ENV: 'test', NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1', NOVA_SKIP_MODEL_RESOLVER_INIT: '1', NOVA_NO_TELEGRAM: 'true', NOVA_TELEGRAM_MODE: 'disabled',
  NOVA_NODE_ID: 'desktop-core-fixture', NOVA_DESKTOP_OWNER_ID: 'desktop-core-test', NOVA_AUTO_START_OLLAMA: '0', NOVA_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
  NOVA_AGENT_TIMEOUT_MS: '15000', XAVENTRA_RESPONSE_CONTRACT_FIXTURE: '1' })
mkdirSync(env.APPDATA); mkdirSync(env.LOCALAPPDATA)
const child = spawn(process.execPath, [resolve('scripts/fixtures/desktop-core.mjs'), root], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
let log = ''; child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
const watchdog = setTimeout(() => child.kill(), 90_000)
try {
  const info = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Fixture exited before ready'))) })
  const api = async (path, options = {}) => {
    const response = await fetch(`${info.endpoint}/api/desktop${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'x-nova-principal': info.principal }, signal: AbortSignal.timeout(25000) })
    assert.equal(response.ok, true, `HTTP ${response.status}`)
    return response.json()
  }
  for (const [id, content, expected] of [
    ['short-no-footer', 'Antworte nur mit "OK"', 'OK'],
    ['literal-no-persona-rewrite', 'Return only "I\'m Pi"', "I'm Pi"],
    ['correction-no-footer', 'Die Kennung lautet jetzt DUSK-62. Nenne nur die neue Kennung.', 'DUSK-62'],
    ['prose-never-starts-mission', 'Guten Abend', '/mission This is quoted model prose, never an authorized task'],
  ]) {
    try {
      await api(`/rooms/${info.roomId}/messages`, { method: 'POST', body: JSON.stringify({ content }) })
      const messages = (await api(`/rooms/${info.roomId}/messages`)).messages
      const reply = messages.findLast(message => message.authorType === 'bot')
      assert.ok(reply.runId)
      if (id === 'prose-never-starts-mission') assert.ok(reply.content.startsWith(expected), reply.content)
      else assert.equal(reply.content, expected)
      const run = await api(`/trust/runs/${reply.runId}`)
      assert.equal(run.status, 'completed'); assert.equal(run.validation.success, true); assert.equal(run.tools.length, 0)
      report.cases.push({ id, pass: true })
    } catch (error) { report.cases.push({ id, pass: false, error: String(error) }); process.exitCode = 1 }
  }
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
  clearTimeout(watchdog)
  if (child.connected) child.send('shutdown')
  await new Promise(resolve => setTimeout(resolve, 200))
  if (child.exitCode === null) child.kill()
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', resolve) })
  writeFileSync(join(root, 'worker.log'), log)
  report.completedAt = new Date().toISOString(); writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ report: join(root, 'report.json'), ...report }, null, 2))
}
