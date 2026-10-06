const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

// 2.88: Verbindungen → Proxmox und Passwort-Tresor. Token- und Passwort-Felder
// sind nie vorbefüllt; die 3-Schritt-Anleitung steht in der App.

function loadZugaenge(pve, tresor) {
  const context = { window: {}, document: { querySelector: () => null }, console, Promise, JSON, Math, Object, Date, encodeURIComponent, FormData: class {} }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'zugaenge.js'), 'utf8'), context)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const h = {
    esc, attr: esc, icon: () => '', toast() {}, fail() {}, rerender() {},
    api: { get: async path => path.includes('proxmox') ? pve : tresor, post: async () => ({}), delete: async () => ({}) },
  }
  return { ui: context.window.XaventraZugaenge, h }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('Proxmox nicht eingerichtet: Adresse vorgeschlagen, Token-Feld leer, 3 Schritte sichtbar', async () => {
  const pve = { eingerichtet: false, adresse: null, vorschlaege: ['https://192.0.2.10:8006'], tokenGespeichert: false, fingerabdruck: null, ausConfig: false, anleitung: ['Schritt eins', 'Schritt zwei', 'Schritt drei'] }
  const { ui, h } = loadZugaenge(pve, { eintraege: [], hinweise: [] })
  ui.mount(h)
  await tick()
  const html = ui.section(h)
  assert.match(html, /value="https:\/\/192\.0\.2\.10:8006"/)
  assert.match(html, /name="token" type="password" value=""/)
  assert.equal((html.match(/<li>Schritt/g) || []).length, 3)
  assert.match(html, /<details open><summary>Token in Proxmox anlegen \(3 Schritte\)/)
})

test('Fingerabdruck offen: Anfang und Ende sichtbar, nie ein Token', async () => {
  const pve = { eingerichtet: false, adresse: 'https://192.0.2.10:8006', vorschlaege: [], tokenGespeichert: true, fingerabdruck: { anfang: '10:11:12:13', ende: '2C:2D:2E:2F', bestaetigt: false }, ausConfig: false, anleitung: [] }
  const { ui, h } = loadZugaenge(pve, { eintraege: [], hinweise: [] })
  ui.mount(h)
  await tick()
  const html = ui.section(h)
  assert.match(html, /10:11:12:13/)
  assert.match(html, /2C:2D:2E:2F/)
  assert.match(html, /Fingerabdruck bestätigen/)
  assert.match(html, /gespeichert – nur zum Ändern einfügen/)
})

test('Tresor: Einträge nur mit Kurzname und Diensten, Passwort-Feld leer', async () => {
  const tresor = { eintraege: [{ id: 'github-main', label: '<b>GitHub</b>', quelle: 'bitwarden', dienste: ['github.com'] }], hinweise: ['Passwörter ändern machst du selbst.'] }
  const { ui, h } = loadZugaenge({ eingerichtet: true, ausConfig: true, vorschlaege: [], anleitung: [] }, tresor)
  ui.mount(h)
  await tick()
  let html = ui.section(h)
  assert.match(html, /github-main/)
  assert.match(html, /Bitwarden\/Vaultwarden · nur für github\.com/)
  assert.match(html, /&lt;b&gt;GitHub/)
  assert.doesNotMatch(html, /name="geheim"/)
  assert.match(html, /über die Einstellungen eingerichtet/)
})
