const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

// The browser transport of the one UI (renderer/bridge.js): same-origin fetch,
// Desktop token only from this tab's sessionStorage, never persisted, only
// /api/desktop paths, and no-op when Electron's preload already exists.
function storage() {
  const map = new Map()
  return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }
}
function load(existing) {
  const calls = []
  const window = existing ? { novaDesktop: existing } : {}
  const context = {
    window, localStorage: storage(), sessionStorage: storage(), location: { origin: 'http://127.0.0.1:3011' },
    crypto: { randomUUID }, AbortController, setTimeout, clearTimeout, URL, JSON, Promise, Error, String, Number, Boolean, Object,
    fetch: async (path, init) => { calls.push({ path, init }); return { ok: true, status: 200, text: async () => '{"ok":true}' } },
  }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'bridge.js'), 'utf8'), context)
  return { context, calls, bridge: context.window.novaDesktop }
}

test('Electron preload wins: the bridge never replaces it', () => {
  const preload = { api: {} }
  assert.equal(load(preload).bridge, preload)
})

test('the token lives only in sessionStorage and goes out as Bearer to the same origin', async () => {
  const { bridge, calls, context } = load()
  const config = await bridge.config.set({ principal: 'alfred', token: 'tab-only-token-123', theme: 'dunkel' })
  assert.equal(config.web, true)
  assert.equal(config.hasToken, true)
  assert.equal(config.theme, 'dunkel')
  assert.equal(config.endpoint, 'http://127.0.0.1:3011')
  assert.ok(![...context.localStorage.map.values()].some(value => value.includes('tab-only-token-123')), 'token leaked into localStorage')
  await bridge.api.get('/api/desktop/heute')
  assert.equal(calls[0].path, '/api/desktop/heute')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tab-only-token-123')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.redirect, 'error')
})

test('only Desktop API paths are reachable and desktop-only features say so', async () => {
  const { bridge, calls } = load()
  for (const path of ['/api/status', 'https://evil.example/api/desktop/heute', '/api/desktop/../config', '//evil.example/api/desktop'])
    await assert.rejects(bridge.api.get(path), /not allowed/)
  assert.equal(calls.length, 0)
  await assert.rejects(bridge.workspace.select(), /Desktop-App/)
  await assert.rejects(bridge.desktop.capture(), /Desktop-App/)
})
