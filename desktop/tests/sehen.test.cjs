const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

// 2.88 „Sehen und lenken“: Dein Computer, Aktivität, Regeln — eine Datei für
// Desktop-App und Web-App. Daten nur escaped, Knöpfe in Alltagssprache.

function loadSehen(responses) {
  const context = { window: {}, document: { querySelector: () => null, visibilityState: 'visible' }, console, Promise, JSON, Math, Object, Date, encodeURIComponent, setInterval, clearInterval, setTimeout }
  vm.createContext(context)
  vm.runInContext(readFileSync(join(__dirname, '..', 'renderer', 'sehen.js'), 'utf8'), context)
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const posts = []
  const h = {
    esc, attr: esc, icon: () => '', toast() {}, fail() {}, rerender() {}, errorText: e => String(e),
    api: { get: async path => responses[path], post: async (path, body) => { posts.push([path, body]); return { ok: true, message: 'ok' } }, delete: async () => ({ ok: true }) },
  }
  return { sehen: context.window.XaventraSehen, h, posts }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('Dein Computer: Bildschirme mit Zuschauen / Übernehmen / Stoppen / Anderes Ziel', async () => {
  const { sehen, h } = loadSehen({ '/api/desktop/bildschirme': {
    bildschirme: [
      { id: 'node:spark-a', name: 'spark-a', art: 'sitzung', zustand: 'bereit', zustandText: 'bereit', lokal: false, zuschauen: 'bild', eingabeErlaubt: false, linkSteuern: false, uebernommen: false, gestoppt: false, tut: 'Projekt: Website 4/7' },
      { id: 'direkt:labor-vm', name: 'Labor-VM <b>', art: 'virtuell', zustand: 'bereit', zustandText: 'bereit', lokal: false, zuschauen: 'link', eingabeErlaubt: false, linkSteuern: true, uebernommen: true, gestoppt: false, tut: '' },
    ], ohneBildschirm: ['worker-a'], agentPausiert: 'Desktop-Eingabe pausiert', probleme: [],
  } })
  sehen.view('computer', h)
  await tick()
  const html = sehen.view('computer', h)
  assert.match(html, /Dein Computer/)
  assert.match(html, /data-sehen-watch="node:spark-a"/)
  assert.match(html, /data-aktion="uebernehmen"/)
  assert.match(html, /data-aktion="stoppen"/)
  assert.match(html, /Anderes Ziel/)
  assert.match(html, /tut gerade: Projekt: Website 4\/7/)
  // übernommen → „Zurückgeben“, kein Stoppen auf diesem Bildschirm
  assert.match(html, /data-sehen-screen="direkt:labor-vm" data-aktion="zurueckgeben"/)
  assert.match(html, /Labor-VM &lt;b&gt;/)
  assert.doesNotMatch(html, /Labor-VM <b>/)
  assert.match(html, /Ohne Bildschirm: worker-a/)
  assert.match(html, /Maus und Tastatur sind gerade pausiert/)
})

test('Aktivität: Gerade / Im Hintergrund mit Stopp, Später, Weiter, Anders', async () => {
  const { sehen, h } = loadSehen({ '/api/desktop/aktivitaet': { eintraege: [
    { id: 'aufgabe:1', art: 'aufgabe', artText: 'Aufgabe', titel: 'Doku finden', tut: 'Browser: suche Doku zu ESPHome (2/3)', status: 'laeuft', statusText: 'läuft', node: 'main', grund: 'Du hast gefragt', jetzt: true, aktionen: ['anders'] },
    { id: 'auftrag:m1', art: 'auftrag', artText: 'Projekt', titel: 'Website', tut: 'Projekt Website 4/7', status: 'laeuft', statusText: 'läuft', node: 'spark-a', grund: 'Dein Auftrag', jetzt: true, aktionen: ['stopp', 'spaeter', 'anders'] },
    { id: 'geplant:job-1', art: 'geplant', artText: 'Geplant', titel: 'Müll', tut: 'pausiert', status: 'spaeter', statusText: 'später (ab 10:00 UTC)', node: 'main', grund: 'x', jetzt: false, aktionen: ['weiter', 'anders'] },
  ], probleme: [] } })
  sehen.view('aktivitaet', h)
  await tick()
  const html = sehen.view('aktivitaet', h)
  assert.match(html, /Browser: suche Doku zu ESPHome \(2\/3\)/)
  assert.match(html, /Projekt Website 4\/7/)
  assert.match(html, /spark-a/)
  assert.match(html, /data-sehen-akt="auftrag:m1" data-aktion="stopp"/)
  assert.match(html, /data-sehen-akt="auftrag:m1" data-aktion="spaeter"/)
  assert.match(html, /data-sehen-akt="geplant:job-1" data-aktion="weiter"/)
  assert.match(html, /Im Hintergrund/)
  assert.doesNotMatch(html, /data-sehen-akt="aufgabe:1" data-aktion="stopp"/)
})

test('Regeln: Satz eingeben, Wirkung umschalten, feste Grenze sichtbar', async () => {
  const { sehen, h } = loadSehen({ '/api/desktop/regeln': {
    regeln: [
      { id: 'd-0123456789', satz: 'Lichter darfst du ohne Frage schalten', wirkung: 'erlauben', bereich: 'Lichter schalten', wirksam: true, fest: false, hinweis: 'Lichter schalte ich ohne Vorschau-Karte.', status: 'gilt' },
      { id: 'd-abcdefabcd', satz: 'Bezahlen darfst du ohne Frage', wirkung: 'erlauben', bereich: 'allgemein', wirksam: false, fest: true, hinweis: 'Bei Geld frage ich immer.', status: 'gilt' },
    ], beispiele: ['Lichter darfst du ohne Frage schalten', 'Bei Mails immer fragen', 'Nie etwas löschen'], fest: 'Geld bleibt fest.',
  } })
  sehen.view('regeln', h)
  await tick()
  const html = sehen.view('regeln', h)
  assert.match(html, /data-sehen-regel-form/)
  assert.match(html, /Bei Mails immer fragen/)
  assert.match(html, /„Lichter darfst du ohne Frage schalten“/)
  assert.match(html, /data-sehen-regel="d-0123456789" data-wirkung="fragen"/)
  assert.match(html, /data-sehen-regel="d-0123456789" data-wirkung="blockieren"/)
  assert.match(html, /feste Grenze/)
  assert.match(html, /Bei Geld frage ich immer/)
  assert.match(html, /Entfernen/)
})
