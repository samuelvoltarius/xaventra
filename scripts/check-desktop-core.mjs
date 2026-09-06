import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'

const source = resolve(import.meta.dirname, '..')
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
mkdirSync(env.APPDATA); mkdirSync(env.LOCALAPPDATA)
const child = spawn(process.execPath, [join(source, 'scripts/fixtures/desktop-core.mjs'), runtime], { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
const log = createWriteStream(join(root, 'core.log')); child.stdout.pipe(log); child.stderr.pipe(log)
const version = JSON.parse(readFileSync(join(source, 'package.json'))).version
const report = { version, sourceRevision: process.env.GITHUB_SHA || 'local-working-tree', platform: process.platform, passed: false, checks: [],
  scope: 'Packaged Electron -> production Desktop API -> actual message pipeline/native runner/tool policy/validator/ledger. Scripted loopback model and minimal runtime state, not full daemon, live provider, Telegram, Mesh or installer acceptance.' }
let app, page, info
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
const check = async (name, action) => { report.currentCheck = name; save(); console.log(`START ${name}`); await action(); report.checks.push({ name, passed: true }); save(); console.log(`PASS ${name}`) }
const watchdog = setTimeout(() => { report.error = `Deadline at ${report.currentCheck}`; save(); app?.process().kill('SIGKILL'); child.kill('SIGKILL'); process.exit(1) }, 150000)
const api = async (path, options = {}, principal = info.principal) => {
  const response = await fetch(`${info.endpoint}/api/desktop${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'x-nova-principal': principal, ...options.headers }, signal: AbortSignal.timeout(40000) })
  return { status: response.status, body: await response.json() }
}
try {
  info = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Core startup deadline')), 30000); child.once('message', value => { clearTimeout(timer); resolve(value) }); child.once('error', reject); child.once('exit', () => reject(new Error('Core exited before ready'))) })
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
  if (child.connected) child.send('shutdown')
  if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000); child.once('exit', () => { clearTimeout(timer); resolve() }) }) }
  log.end(); clearTimeout(watchdog); save()
}
console.log(JSON.stringify({ version, passed: report.passed, checks: report.checks, error: report.error, artifactRoot: root }, null, 2))
if (!report.passed) process.exitCode = 1
