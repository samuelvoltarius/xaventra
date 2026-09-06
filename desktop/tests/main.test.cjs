const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const vm = require('node:vm')

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'xaventra-desktop-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const handlers = new Map()
  let ready
  const electron = {
    app: { getPath: () => root, on() {}, setAppUserModelId() {}, whenReady: () => ({ then: fn => { ready = fn } }) },
    BrowserWindow: class { webContents = { id: 1, setWindowOpenHandler() {}, on() {} }; loadFile() {}; once() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
  }
  const context = { require: id => id === 'electron' ? electron : require(id), __dirname: join(__dirname, '..'), process: { platform: 'linux', env: {} }, Buffer, URL, console }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8'), context)
  ready()
  return { root, handlers, evaluate: script => vm.runInContext(script, context), context }
}

test('first config read persists the exact client identity returned to the renderer', t => {
  const { root, handlers } = harness(t)
  const first = handlers.get('nova:config:get')()
  const saved = JSON.parse(readFileSync(join(root, 'connection.json'), 'utf8'))
  assert.equal(first.clientId, saved.clientId)
  assert.equal(handlers.get('nova:config:get')().clientId, first.clientId)
})

test('changing the Core endpoint clears credentials belonging to the former Core', t => {
  const { handlers } = harness(t)
  handlers.get('nova:config:set')(null, { endpoint: 'https://first.invalid', token: 'synthetic-test-token' })
  const changed = handlers.get('nova:config:set')(null, { endpoint: 'https://second.invalid' })
  assert.equal(changed.hasToken, false)
})

test('explicit workspace paths cannot read files below hidden private directories', t => {
  const { root, evaluate, context } = harness(t)
  context.workspace = { path: root }
  for (const dir of ['.git', '.nova-data', '.nova-auth', 'secrets', 'node_modules']) {
    mkdirSync(join(root, dir))
    writeFileSync(join(root, dir, 'record.json'), '{}')
    context.target = `${dir}/record.json`
    assert.throws(() => evaluate('safeWorkspacePath(workspace, target)'), /not available/)
  }
  writeFileSync(join(root, 'README.md'), 'safe source')
  assert.equal(evaluate("safeWorkspacePath(workspace, 'README.md').relativePath"), 'README.md')
  for (const file of ['xaventra.config.json', 'nova.config.json', 'PROJECT_MEMORY.md', '.nova-gateway-token', 'example.wallet.json']) {
    writeFileSync(join(root, file), 'synthetic private configuration')
    context.target = file
    assert.throws(() => evaluate('safeWorkspacePath(workspace, target)'), /not available/)
  }
})

test('IPv6 loopback is a valid local Core endpoint', t => {
  assert.equal(harness(t).evaluate("normalizeEndpoint('http://[::1]:3011')"), 'http://[::1]:3011')
})

test('bootstrap has a bounded retry budget while chat keeps its configured deadline', async t => {
  const { handlers, context } = harness(t)
  const deadlines = []
  context.AbortController = AbortController
  context.setTimeout = (_callback, ms) => { deadlines.push(ms); return 1 }
  context.clearTimeout = () => {}
  context.fetch = async () => ({ ok: true, text: async () => '{}' })
  handlers.get('nova:config:get')()
  await handlers.get('nova:api')(null, { path: '/api/desktop/bootstrap' })
  await handlers.get('nova:api')(null, { path: '/api/desktop/rooms/alpha/messages' })
  assert.deepEqual(deadlines, [5000, 120000])
})
