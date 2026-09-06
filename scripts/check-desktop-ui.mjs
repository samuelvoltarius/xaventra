// Packaged Electron interactions with an isolated simulated Core contract.
// Never uses production config, full-display capture, providers or Mesh nodes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { createDesktopFixture } from './fixtures/desktop-control-plane.mjs'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8')).version
const release = join(root, 'desktop/release')
const executable = process.platform === 'win32' ? join(release, 'win-unpacked/Xaventra Desktop.exe')
  : process.platform === 'darwin' ? join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Xaventra Desktop.app/Contents/MacOS/Xaventra Desktop')
    : join(release, process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'xaventra-desktop')
assert.ok(existsSync(executable), `Build this platform's Desktop package first: ${executable}`)
assert.ok(process.platform !== 'linux' || process.geteuid?.() !== 0, 'Run Desktop QA as a normal user; root makes Playwright disable the Chromium sandbox')
const parent = resolve(process.env.NOVA_DESKTOP_QA_DIR || join(tmpdir(), 'xaventra-desktop-qa'))
mkdirSync(parent, { recursive: true })
const artifactRoot = mkdtempSync(join(parent, 'run-'))
const profile = join(artifactRoot, 'profile')
mkdirSync(profile)
const fixture = await createDesktopFixture()
fixture.controls.bootstrapStatus = 401
writeFileSync(join(profile, 'connection.json'), JSON.stringify({ endpoint: fixture.endpoint, principal: 'fixture-user', clientId: 'fixture-desktop', requestTimeoutMs: 30000, sendOnEnter: true, showInspector: true }))
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
Object.assign(env, { HOME: artifactRoot, USERPROFILE: artifactRoot, APPDATA: join(artifactRoot, 'appdata'), LOCALAPPDATA: join(artifactRoot, 'localappdata') })
const report = { version, sourceRevision: process.env.GITHUB_SHA || 'local-working-tree', platform: process.platform, arch: process.arch, passed: false, checks: [],
  scope: 'Packaged Electron against simulated HTTP Core contract; not real model, channels, Mesh HA, installer, signature or screenshot-tool acceptance.' }
// Preserve evidence even if a failed Electron launch causes an unhandled
// rejection inside the automation library. Monitoring does not suppress exit.
process.on('uncaughtExceptionMonitor', error => {
  writeFileSync(join(artifactRoot, 'report.json'), JSON.stringify({ ...report, passed: false, error: error.stack || String(error) }, null, 2))
})
let app, page
const persist = () => writeFileSync(join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2))
const check = async (name, fn) => { report.currentCheck = name; persist(); console.log(`START ${name}`); const start = Date.now(); await fn(); report.checks.push({ name, passed: true, durationMs: Date.now() - start }); persist(); console.log(`PASS ${name}`) }
const screenshot = name => page.screenshot({ path: join(artifactRoot, `${name}.jpg`), type: 'jpeg', quality: 85 })
const wait = async predicate => { const end = Date.now() + 10000; while (!await predicate()) { if (Date.now() > end) throw new Error('UI condition deadline exceeded'); await new Promise(r => setTimeout(r, 50)) } }
const launch = async () => {
  report.currentCheck = 'launch packaged Electron'; persist()
  app = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], cwd: artifactRoot, env, timeout: 30000 })
  page = await app.firstWindow({ timeout: 10000 }); page.setDefaultTimeout(10000)
}
const closeApp = async () => {
  const owned = app
  if (!owned) return
  let timer
  try { await Promise.race([owned.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packaged Electron failed to close within 10 seconds')), 10000) })]) }
  catch (error) { owned.process().kill('SIGKILL'); throw error }
  finally { clearTimeout(timer); app = null }
}
const watchdog = setTimeout(() => {
  report.passed = false; report.error = `Whole UI run exceeded 120 seconds at ${report.currentCheck}`; persist()
  app?.process().kill('SIGKILL')
  process.exit(1)
}, 120000)
const posts = () => fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages'))
try {
  await launch()
  await check('actual packaged version and disposable profile', async () => {
    const actual = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }))
    assert.equal(actual.packaged, true); assert.equal(actual.version, version); assert.equal(resolve(actual.profile), resolve(profile))
  })
  await check('authentication failure leaves setup reachable immediately', async () => {
    await page.locator('#open-settings').waitFor({ state: 'visible', timeout: 5000 }); await screenshot('offline')
    await page.locator('#open-settings').click(); await page.locator('#settings-form').waitFor()
    await page.waitForTimeout(2200); assert.ok(await page.locator('#settings-form').isVisible(), 'Old retry replaced settings')
  })
  await check('save connection recovers without restarting', async () => {
    fixture.controls.bootstrapStatus = 200
    fixture.controls.omitAuthority = true
    await page.locator('#settings-form button[type=submit]').click()
    await page.locator('#toast.error').waitFor()
    assert.ok(!await page.locator('#composer').isVisible(), 'Missing Main authority accepted')
    fixture.controls.omitAuthority = false
    await page.locator('#settings-form button[type=submit]').click(); await page.locator('#composer').waitFor()
    assert.equal(await page.locator('.room-heading h1').innerText(), 'Test alpha')
  })
  await screenshot('initial-chat')
  await check('model pin and auto preserve draft and exact route', async () => {
    const values = await page.locator('#model-picker option').evaluateAll(options => options.map(o => o.value))
    assert.equal(new Set(values).size, 3)
    await page.locator('#composer').fill('Draft before model change')
    await page.locator('#model-picker').selectOption(values[2]); await wait(() => fixture.rooms[0].pinnedRouteId === values[2])
    await wait(async () => await page.locator('#composer').inputValue() === 'Draft before model change')
    await page.locator('#model-picker').selectOption('auto'); await wait(() => fixture.rooms[0].modelMode === 'auto')
    assert.equal(await page.locator('#composer').inputValue(), 'Draft before model change')
  })
  await check('scroll and draft survive specialist and navigation changes', async () => {
    await page.locator('.messages').hover(); await page.mouse.wheel(0, -650); await page.waitForTimeout(350)
    const before = await page.locator('.messages').evaluate(e => ({ top: e.scrollTop, bottom: e.scrollHeight - e.clientHeight }))
    assert.ok(before.top < before.bottom - 200)
    await page.locator('[data-action=toggle-experts]').click(); await page.waitForTimeout(100)
    assert.ok(Math.abs(await page.locator('.messages').evaluate(e => e.scrollTop) - before.top) < 3)
    await page.locator('[data-action=toggle-experts]').click()
    await page.locator('[data-section=settings]').click(); await page.locator('#settings-form').waitFor(); await screenshot('settings')
    await page.locator('[data-section=chat]').click(); await page.waitForTimeout(100)
    assert.equal(await page.locator('#composer').inputValue(), 'Draft before model change')
    assert.ok(Math.abs(await page.locator('.messages').evaluate(e => e.scrollTop) - before.top) < 3)
  })
  await check('failed send restores draft without automatic retry', async () => {
    fixture.controls.postStatus = 503; const before = posts().length
    await page.locator('#composer').fill('Retry only by user'); await page.locator('#composer').press('Enter')
    await wait(() => posts().length === before + 1); await wait(async () => await page.locator('#composer').isEnabled())
    assert.equal(await page.locator('#composer').inputValue(), 'Retry only by user')
    await page.waitForTimeout(250); assert.equal(posts().length, before + 1); fixture.controls.postStatus = 200
  })
  await check('keyboard chat produces exactly one primary reply', async () => {
    const before = posts().length
    await page.locator('#composer').fill('Hello from packaged Desktop'); await page.locator('#composer').press('Enter')
    await page.getByText('Fixture reply: Hello from packaged Desktop', { exact: true }).waitFor()
    assert.equal(posts().length, before + 1); assert.deepEqual(posts().at(-1).body.botIds, ['nova'])
  })
  await check('room drafts and delayed response never cross rooms', async () => {
    await page.locator('#composer').fill('Keep alpha draft')
    await page.locator('[data-room=beta]').click(); await wait(async () => await page.locator('#composer').isEnabled())
    assert.equal(await page.locator('#composer').inputValue(), '')
    await page.locator('#composer').fill('Keep beta draft')
    await page.locator('[data-room=alpha]').click(); await wait(async () => await page.locator('#composer').isEnabled())
    assert.equal(await page.locator('#composer').inputValue(), 'Keep alpha draft')
    fixture.controls.delayMs = 2400
    await page.locator('#composer').fill('Delayed alpha only'); await page.locator('#composer').press('Enter')
    await page.locator('[data-room=beta]').click(); await page.getByText('beta history 0:', { exact: false }).waitFor({ state: 'attached' })
    assert.ok(!(await page.locator('.messages').innerText()).includes('Delayed alpha only'))
    await wait(async () => await page.locator('#composer').isEnabled())
    assert.equal(await page.locator('#composer').inputValue(), 'Keep beta draft')
    assert.ok(!(await page.locator('.messages').innerText()).includes('Delayed alpha only'))
    await page.locator('[data-room=alpha]').click(); await page.getByText('Fixture reply: Delayed alpha only', { exact: true }).waitFor()
    await page.locator('#composer').fill('Settings edit while replying'); await page.locator('#composer').press('Enter')
    await page.locator('[data-section=settings]').click(); await page.locator('[name=principal]').fill('unsaved-fixture-principal')
    await wait(() => fixture.messages.alpha.some(message => message.content === 'Fixture reply: Settings edit while replying'))
    await page.waitForTimeout(150)
    assert.equal(await page.locator('[name=principal]').inputValue(), 'unsaved-fixture-principal', 'Reply discarded an unsaved settings edit')
    await page.locator('[data-section=chat]').click()
    fixture.controls.delayMs = 0
  })
  await check('preferences change input behavior and survive relaunch', async () => {
    await page.locator('[data-section=settings]').click()
    await page.locator('[name=sendOnEnter]').uncheck(); await page.locator('[name=showInspector]').uncheck()
    await page.locator('#settings-form button[type=submit]').click(); await page.locator('#composer').waitFor()
    const before = posts().length
    await page.locator('#composer').fill('Newline'); await page.locator('#composer').press('Enter')
    assert.equal(await page.locator('#composer').inputValue(), 'Newline\n'); assert.equal(posts().length, before)
    assert.ok(!await page.locator('.inspector').isVisible())
    await closeApp(); await launch(); await page.locator('#composer').waitFor()
    assert.ok(!await page.locator('.inspector').isVisible())
    await page.locator('[data-section=settings]').click(); assert.ok(!await page.locator('[name=sendOnEnter]').isChecked())
    await page.locator('[name=sendOnEnter]').check(); await page.locator('[name=showInspector]').check()
    await page.locator('#settings-form button[type=submit]').click(); await page.locator('#composer').waitFor()
    await page.locator('#composer').fill('Private draft in first principal scope')
    await page.locator('[data-section=settings]').click(); await page.locator('[name=principal]').fill('fixture-other-user')
    await page.locator('#settings-form button[type=submit]').click(); await page.locator('#composer').waitFor()
    assert.equal(await page.locator('#composer').inputValue(), '', 'Draft survived an identity boundary change')
  })
  await check('minimum supported window retains primary controls', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 720)); await page.waitForTimeout(300)
    const fit = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX: document.documentElement.scrollWidth > innerWidth,
      regions: ['.workspace', '.messages', '.composer', '#model-picker', '#composer'].map(selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { selector, left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height } }) }))
    assert.equal(fit.scrollX, false)
    for (const b of fit.regions) assert.ok(b.height > 0 && b.left >= 0 && b.top >= 0 && b.right <= fit.width + 1 && b.bottom <= fit.height + 1, `Clipped ${JSON.stringify(b)}`)
    report.minimumWindow = fit; await screenshot('minimum-window')
  })
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  if (page) await screenshot('failure').catch(() => {})
} finally {
  if (app) await closeApp().catch(error => { report.passed = false; report.error = [report.error, error.message].filter(Boolean).join('\n') })
  await fixture.close()
  clearTimeout(watchdog)
  persist()
}
console.log(JSON.stringify({ ...report, artifactRoot }, null, 2))
if (!report.passed) process.exitCode = 1
