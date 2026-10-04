const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('direct-device access form uses masked fields and a separate secret endpoint, not chat', async () => {
  let click, submit, modal, reset = false, sent
  const device = { id: 'dev-0123456789', name: '<unsafe>', fingerprint: 'a'.repeat(64), route: 'local', protocol: 'tuya', accessStored: false,
    fields: [{ name: 'key', label: 'Local-Key', length: 16 }, { name: 'version', label: 'Protokoll', choices: ['3.3'] }] }
  const node = { dataset: { smartAccess: device.id }, addEventListener: (event, handler) => { click = handler } }
  const form = { addEventListener: (event, handler) => { submit = handler }, reset: () => { reset = true } }
  const page = { querySelector: () => null, querySelectorAll: selector => selector === '[data-smart-access]' ? [node] : [] }
  const document = { querySelector: selector => selector === '#page' ? page : selector === '#smart-access-form' ? form : null }
  const window = {}
  class FormData { entries() { return [['key', 'a'.repeat(16)], ['version', '3.3']][Symbol.iterator]() } }
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const h = { api: { get: async endpoint => endpoint.endsWith('smart-geraete') ? { devices: [device] } : { gefunden: [], verbunden: [] },
    post: async (endpoint, body) => { assert.equal(reset, true); sent = { endpoint, body: structuredClone(body) }; return { message: 'Gespeichert, noch ungeprüft' } } },
    esc: escape, attr: escape, icon: () => '', toast: () => {}, fail: () => assert.fail('Unexpected UI error'), rerender: () => {},
    showModal: (title, html) => { modal = html }, closeModal: () => {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/connections.js'), 'utf8'), { window, document, FormData, Date, Set, Object, String, Number })
  window.XaventraConnections.mount(h)
  await new Promise(resolve => setImmediate(resolve))
  const html = window.XaventraConnections.view(h)
  assert.match(html, /&lt;unsafe&gt;/); assert.doesNotMatch(html, /<unsafe>/)
  window.XaventraConnections.mount(h); click()
  assert.match(modal, /type="password"/); assert.match(modal, /Kein Cloud-Abruf und kein Schalten/)
  assert.doesNotMatch(modal, /private123456789/)
  await submit({ preventDefault() {}, currentTarget: form })
  assert.equal(sent.endpoint, `/api/desktop/smart-geraete/${device.id}/zugang`)
  assert.equal(sent.body.fingerprint, device.fingerprint)
  assert.equal(sent.body.values.key, 'a'.repeat(16))
  assert.doesNotMatch(window.XaventraConnections.view(h), /private123456789/)
})

test('physical device control prepares first and requires a second exact-action confirmation', async () => {
  let click, submit, confirm, modal
  const posts = [], device = { id: 'dev-0123456789', name: '<desk>', route: 'local', fields: [], controls: [{ id: 'light:1', name: '<light>', kind: 'light' }] }
  const document = { querySelector: selector => selector === '#page' ? { querySelector: () => null, querySelectorAll: s => s === '[data-smart-control]' ? [{ dataset: { smartControl: device.id }, addEventListener: (_, handler) => { click = handler } }] : [] }
    : selector === '#smart-control-form' ? { addEventListener: (_, handler) => { submit = handler } }
    : selector === '#smart-control-confirm' ? { addEventListener: (_, handler) => { confirm = handler } } : null }
  const escape = v => String(v).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const window = {}, h = { api: { get: async e => e.endsWith('smart-geraete') ? { devices: [device] } : { gefunden: [], verbunden: [] }, post: async (endpoint, body) => { posts.push({ endpoint, body }); return endpoint.endsWith('/aktion') ? { ok: true, confirmationId: 'uuid', message: '<exact action>' } : { ok: true, message: 'confirmed' } } },
    esc: escape, attr: escape, icon: () => '', rerender() {}, showModal: (_, html) => { modal = html }, closeModal() {}, toast() {}, fail: () => assert.fail('Unexpected failure') }
  class FormData { get(key) { return key === 'functionId' ? 'light:1' : 'on' } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/connections.js'), 'utf8'), { window, document, FormData, Date, Set, Object, String, Number })
  window.XaventraConnections.mount(h); await new Promise(resolve => setImmediate(resolve)); window.XaventraConnections.mount(h)
  click(); assert.match(modal, /noch nicht ausführen/); assert.match(modal, /&lt;desk&gt;/)
  await submit({ preventDefault() {}, currentTarget: {} })
  assert.equal(posts.length, 1); assert.equal(posts[0].endpoint, `/api/desktop/smart-geraete/${device.id}/aktion`)
  assert.match(modal, /&lt;exact action&gt;/); assert.match(modal, /Genau diese Aktion ausführen/)
  await confirm(); assert.equal(posts.length, 2); assert.equal(posts[1].endpoint, '/api/desktop/smart-aktionen/uuid/bestaetigen'); assert.equal(posts[1].body.confirm, 'ja')
})
