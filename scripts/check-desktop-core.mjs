import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'

const source = resolve(import.meta.dirname, '..')
const fullDaemon = process.argv.includes('--daemon')
const parent = resolve(process.env.NOVA_DESKTOP_QA_DIR || join(tmpdir(), 'xaventra-desktop-core'))
mkdirSync(parent, { recursive: true })
const root = mkdtempSync(join(parent, 'core-'))
const profile = join(root, 'profile'); mkdirSync(profile)
const runtime = join(root, 'runtime'); mkdirSync(runtime)
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), CODEX_HOME: join(root, 'codex'),
  NODE_ENV: 'test', NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1', NOVA_SKIP_MODEL_RESOLVER_INIT: '1', NOVA_NO_TELEGRAM: 'true', NOVA_TELEGRAM_MODE: 'disabled',
  NOVA_NODE_ID: 'desktop-core-fixture', NOVA_DESKTOP_OWNER_ID: 'desktop-core-test', NOVA_AUTO_START_OLLAMA: '0', NOVA_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
  NOVA_AGENT_TIMEOUT_MS: '20000', NOVA_MAX_TOOL_ROUNDS: '3' })
if (fullDaemon) {
  env.NOVA_NODE_ONLY = 'false'
  for (const key of ['XAVENTRA_ACCEPTANCE_BASE_URL', 'XAVENTRA_ACCEPTANCE_MODEL']) if (process.env[key]) env[key] = process.env[key]
}
mkdirSync(env.APPDATA); mkdirSync(env.LOCALAPPDATA)
const log = createWriteStream(join(root, 'core.log'))
const startChild = () => {
  const args = fullDaemon ? ['--import', pathToFileURL(join(source, 'scripts/fixtures/desktop-daemon.mjs')).href, join(source, 'dist/daemon.js'), runtime]
    : [join(source, 'scripts/fixtures/desktop-core.mjs'), runtime]
  const processHandle = spawn(process.execPath, args, { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  processHandle.stdout.pipe(log, { end: false }); processHandle.stderr.pipe(log, { end: false })
  return processHandle
}
let child = startChild()
const version = JSON.parse(readFileSync(join(source, 'package.json'))).version
const report = { version, sourceRevision: process.env.GITHUB_SHA || 'local-working-tree', platform: process.platform, passed: false, checks: [],
  scope: 'Packaged Electron -> production Desktop API -> actual message pipeline/native runner/tool policy/validator/ledger. Scripted loopback model and minimal runtime state, not full daemon, live provider, Telegram, Mesh or installer acceptance.' }
if (fullDaemon) report.scope = 'Packaged Electron -> full compiled daemon -> production channel gateway -> pipeline/tools/validator/ledger. Read-only synthetic files, no production channels, Mesh, credentials or installer acceptance.'
report.fullDaemon = fullDaemon
report.modelMode = process.env.XAVENTRA_ACCEPTANCE_BASE_URL ? 'explicit-live-provider' : 'scripted-loopback'
let app, page, info
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
const check = async (name, action) => { report.currentCheck = name; save(); console.log(`START ${name}`); await action(); report.checks.push({ name, passed: true }); save(); console.log(`PASS ${name}`) }
const watchdog = setTimeout(() => { report.error = `Deadline at ${report.currentCheck}`; save(); app?.process().kill('SIGKILL'); child.kill('SIGKILL'); process.exit(1) }, fullDaemon ? 360000 : 150000)
const waitReady = () => new Promise((resolve, reject) => {
  const handle = child
  const finish = (error, value) => { clearTimeout(timer); handle.off('message', ready); handle.off('error', failed); handle.off('exit', exited); error ? reject(error) : resolve(value) }
  const ready = value => finish(null, value)
  const failed = error => finish(error)
  const exited = () => finish(new Error('Core exited before ready'))
  const timer = setTimeout(() => finish(new Error('Core startup deadline')), fullDaemon ? 120000 : 30000)
  handle.once('message', ready); handle.once('error', failed); handle.once('exit', exited)
})
const stopDaemon = async () => {
  const cli = spawn(process.execPath, [join(source, 'dist/cli.js'), 'stop'], { cwd: runtime, env, windowsHide: true, stdio: 'ignore' })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cli.kill(); reject(new Error('CLI stop deadline')) }, 30000)
    cli.once('exit', code => { clearTimeout(timer); resolve(code) }); cli.once('error', error => { clearTimeout(timer); reject(error) })
  })
  assert.equal(code, 0, 'Authenticated, instance-scoped daemon shutdown failed')
  assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null)
}
const api = async (path, options = {}, principal = info.principal) => {
  const response = await fetch(`${info.endpoint}/api/desktop${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'x-nova-principal': principal, ...options.headers }, signal: AbortSignal.timeout(40000) })
  return { status: response.status, body: await response.json() }
}
try {
  info = await waitReady()
  assert.equal(Boolean(info.fullDaemon), fullDaemon)
  writeFileSync(join(profile, 'connection.json'), JSON.stringify({ endpoint: info.endpoint, principal: info.principal, clientId: 'core-acceptance-client', requestTimeoutMs: 40000 }))
  const release = join(source, 'desktop/release')
  const executablePath = process.platform === 'win32' ? join(release, 'win-unpacked/Xaventra Desktop.exe')
    : process.platform === 'darwin' ? join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Xaventra Desktop.app/Contents/MacOS/Xaventra Desktop')
      : join(release, process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'xaventra-desktop')
  assert.ok(process.platform !== 'linux' || process.geteuid?.() !== 0, 'Linux QA must not disable Chromium sandbox via root')
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], cwd: root, env, timeout: 30000 })
  page = await app.firstWindow(); page.setDefaultTimeout(35000)
  await check('packaged client connects to actual Core authority', async () => {
    await page.locator('#composer').waitFor()
    const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))
    assert.equal(identity.packaged, true); assert.equal(identity.version, version)
    const bootstrap = await api('/bootstrap'); assert.equal(bootstrap.body.controlPlane.authoritative, true)
  })
  await check('real file tool produces a linked validated Outcome', async () => {
    await page.locator('#composer').fill(`Lies die Datei ${info.allowed} und nenne den Inhalt.`)
    await page.locator('#composer').press('Enter')
    await page.locator('.message:not(.user):not(.pending)').filter({ hasText: 'VERIFIED_DESKTOP_CORE_731' }).waitFor()
    const messages = (await api(`/rooms/${info.roomId}/messages`)).body.messages
    const reply = messages.findLast(message => message.authorType === 'bot')
    report.reply = reply
    assert.ok(reply.runId, 'Reply is missing its real Outcome run ID')
    const run = await api(`/trust/runs/${reply.runId}`)
    assert.equal(run.status, 200, 'The same Desktop principal cannot open its own Outcome')
    assert.equal(run.body.userId, `desktop:${info.principal}`)
    assert.equal(run.body.validation.success, true)
    assert.equal(run.body.status, 'completed')
    if (fullDaemon) {
      assert.equal(reply.model, info.model, 'Reply model must match the explicitly configured provider model')
      assert.equal(run.body.model, info.model, 'Outcome model attribution disagrees with execution')
      assert.equal(run.body.tools.filter(tool => tool.toolName === 'read_file').length, 1, 'A simple read must not become a repeated tool loop')
    }
    assert.ok(run.body.tools.some(tool => tool.toolName === 'read_file' && tool.success === true))
    assert.ok(run.body.tools.some(tool => String(tool.result).includes('VERIFIED_DESKTOP_CORE_731')))
    report.outcome = run.body
    assert.equal((await api(`/trust/runs/${reply.runId}`, {}, 'different-user')).status, 404)
    await page.locator(`.run-link[data-run-id="${reply.runId}"]`).click()
    await page.locator('.run-detail').waitFor()
    assert.ok((await page.locator('.run-detail').innerText()).includes('bestanden'))
    await page.screenshot({ path: join(root, 'trust-run.jpg'), type: 'jpeg', quality: 85 })
    await page.locator('.modal [data-close-modal]').click()
    await page.locator('.run-detail').waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(root, 'tool-evidence.jpg'), type: 'jpeg', quality: 85 })
  })
  await check('command after a tool turn stays a command instead of replaying history', async () => {
    const before = (await api('/trust/runs')).body.runs.length
    await page.locator('#composer').fill('/status'); await page.locator('#composer').press('Enter')
    await page.waitForFunction(() => !document.querySelector('.message.pending'))
    const messages = (await api(`/rooms/${info.roomId}/messages`)).body.messages
    const reply = messages.findLast(message => message.authorType === 'bot')
    assert.ok(!reply.runId, 'Slash command was incorrectly routed through the model with historical instructions')
    assert.equal((await api('/trust/runs')).body.runs.length, before)
  })
  await check('scoped memory and Trust lists match execution identity without widening access', async () => {
    const memory = (await api('/memory')).body
    assert.equal(memory.scope, `user:desktop:${info.principal}`)
    assert.ok(memory.records.some(record => record.content.includes('OWN_SCOPED_MEMORY_731')))
    assert.ok(!memory.records.some(record => record.content.includes('OTHER_SCOPED_MEMORY_912')))
    assert.ok(!(await api('/memory', {}, 'different-user')).body.records.some(record => record.content.includes('OWN_SCOPED_MEMORY_731')))
    assert.ok(!(await api('/trust/runs')).body.runs.some(run => run.runId === 'unscoped-fixture-run'))
    assert.equal((await api('/trust/runs/unscoped-fixture-run')).status, 404)
  })
  if (fullDaemon) await check('full daemon restart preserves room, Outcome, memory and session without repeating tools', async () => {
    const pid = info.pid
    const before = (await api(`/rooms/${info.roomId}/messages`)).body.messages
    const priorRun = before.find(message => message.runId)?.runId
    await page.locator('#composer').fill('Welchen Inhalt hatte die eben gelesene Datei? Antworte aus dem Verlauf, ohne sie erneut zu lesen.')
    await stopDaemon()
    env.XAVENTRA_ACCEPTANCE_DASHBOARD_PORT = new URL(info.endpoint).port
    child = startChild(); const restarted = await waitReady()
    assert.notEqual(restarted.pid, pid); assert.equal(restarted.roomId, info.roomId)
    info = restarted
    assert.deepEqual((await api(`/rooms/${info.roomId}/messages`)).body.messages, before)
    assert.equal((await api(`/trust/runs/${priorRun}`)).body.validation.success, true)
    assert.ok((await api('/memory')).body.records.some(record => record.content.includes('OWN_SCOPED_MEMORY_731')))
    assert.ok((await page.locator('#composer').inputValue()).startsWith('Welchen Inhalt hatte'))
    await page.locator('#composer').press('Enter')
    await page.waitForFunction(() => !document.querySelector('.message.pending'))
    const reply = (await api(`/rooms/${info.roomId}/messages`)).body.messages.findLast(message => message.authorType === 'bot')
    assert.ok(reply.content.includes('VERIFIED_DESKTOP_CORE_731'), 'Session recall was lost across full daemon restart')
    assert.ok(reply.runId)
    const resumed = (await api(`/trust/runs/${reply.runId}`)).body
    assert.equal(resumed.tools.length, 0, 'Remembering the prior answer must not repeat the file tool')
    report.restart = { priorPid: pid, restartedPid: info.pid, priorRun, resumedRun: reply.runId }
    await page.screenshot({ path: join(root, 'daemon-restarted.jpg'), type: 'jpeg', quality: 85 })
  })
  await check('forbidden file remains denied and cannot become verified completion', async () => {
    await page.locator('#composer').fill(`Lies die Datei ${info.forbidden} und nenne den Inhalt.`)
    await page.locator('#composer').press('Enter')
    await page.waitForFunction(() => !document.querySelector('.message.pending'))
    const runs = (await api('/trust/runs')).body.runs
    const run = runs.find(run => run.contract?.goal.includes('fixture-denied.txt'))
    assert.ok(run, 'Missing failed run evidence')
    assert.equal(run.status, 'failed'); assert.notEqual(run.validation?.success, true)
    assert.ok(!JSON.stringify(run).includes('DENIED_CONTENT_MUST_NOT_LEAK'))
    assert.ok(!run.tools.some(tool => tool.toolName === 'read_file' && tool.success === true))
    const label = await page.locator('.message:not(.user):not(.pending)').last().locator('.evidence-state').innerText()
    assert.equal(label, 'Ergebnis nicht verifiziert', 'Denied action is incorrectly labeled as needing no evidence')
    report.deniedOutcome = run
    await page.screenshot({ path: join(root, 'policy-denied.jpg'), type: 'jpeg', quality: 85 })
  })
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  if (page) await page.screenshot({ path: join(root, 'failure.jpg'), type: 'jpeg', quality: 85 }).catch(() => {})
} finally {
  if (app) { const closing = app; let timer; try { await Promise.race([closing.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Electron close deadline')), 10000) })]) } catch { closing.process().kill('SIGKILL') } finally { clearTimeout(timer) } }
  if (fullDaemon && child.exitCode === null && child.signalCode === null) {
    try { await stopDaemon(); report.gracefulShutdown = true } catch (error) { report.passed = false; report.shutdownError = String(error) }
  }
  if (!fullDaemon && child.connected) child.send('shutdown')
  if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000); child.once('exit', () => { clearTimeout(timer); resolve() }) }) }
  log.end(); clearTimeout(watchdog); save()
}
console.log(JSON.stringify({ version, passed: report.passed, checks: report.checks, error: report.error, artifactRoot: root }, null, 2))
if (!report.passed) process.exitCode = 1
