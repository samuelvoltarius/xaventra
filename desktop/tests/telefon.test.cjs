const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

// 2.87 Paket P: Verbindungen → Telefon. Drei Felder reichen; das Passwort-Feld
// ist nie vorbefüllt und das Passwort taucht nie im HTML auf.

function loadTelefon(data) {
  const context = { window: {}, document: { querySelector: () => null }, console, Promise, JSON, Math, Object, Date }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'telefon.js'), 'utf8'), context)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const h = {
    esc, attr: esc, icon: () => '', toast() {}, fail() {}, rerender() {},
    api: { get: async () => data, post: async () => ({}), patch: async () => ({}), delete: async () => ({}) },
  }
  return { telefon: context.window.XaventraTelefon, h }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('ohne Einrichtung: Server, Login, Passwort als Eingabe', async () => {
  const data = { eingerichtet: false, aktiv: false, weg: 'direkt', sip: { server: '', login: '', transport: 'udp', port: 5060 }, ownerNummern: [], passwortGespeichert: false, hinweise: ['Trag Server und Login deines Telefonanbieters ein.'] }
  const { telefon, h } = loadTelefon(data)
  telefon.mount(h)
  await tick()
  const html = telefon.section(h)
  assert.match(html, /name="server"/)
  assert.match(html, /name="login"/)
  assert.match(html, /name="passwort" type="password" value=""/)
  assert.match(html, /placeholder="sip\.zadarma\.com"/)
})

test('eingerichtet: Zustand in Alltagssprache, Passwort-Feld leer, Hinweis zur fehlenden Nummer', async () => {
  const data = {
    eingerichtet: true, aktiv: true, weg: 'direkt', passwortGespeichert: true,
    sip: { server: 'sip.zadarma.com', login: '100100', transport: 'tls', port: 5061, anbieter: 'Zadarma' }, ownerNummern: ['+4312345678'],
    pruefung: { ok: false, text: 'Anmeldung bei Zadarma hat nicht geklappt — Passwort prüfen.' },
    hinweise: ['Für Anrufe von außen fehlt noch eine Telefonnummer im Zadarma-Konto.'],
  }
  const { telefon, h } = loadTelefon(data)
  telefon.mount(h)
  await tick()
  const html = telefon.section(h)
  assert.match(html, /Zadarma/)
  assert.match(html, /nicht angemeldet/)
  assert.match(html, /Passwort prüfen/)
  assert.match(html, /fehlt noch eine Telefonnummer/)
  assert.match(html, /Anmeldung prüfen/)
  assert.doesNotMatch(html, /name="passwort"[^>]*value="[^"]+"/)
})
