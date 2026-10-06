// „Heute“ als Cockpit (2.86 Paket M „Geführt“): vier Ampel-Kacheln
// (Läuft alles? · Braucht dich · Was sie heute getan hat · Was sie gelernt hat),
// darunter – nur solange offen – die Einrichtungs-Checkliste mit EINEM Knopf je
// Punkt, Beispielsätze nach einer neuen Verbindung, höchstens ein Tipp am Tag
// und der Knopf „Ich komm nicht weiter“. Eigene Datei; app.js ruft nur
// view(h, heute) und mount(h) auf (h = Helfer aus app.js).
// Kein Knopf hier schaltet etwas: „Verbinden“ öffnet die vorhandene Frage,
// Beispielsätze und Tipps gehen als normale Nachricht in die Unterhaltung.
;(() => {
  const PATH = '/api/desktop/gefuehrt'
  const MAX_AGE = 20_000
  const local = { data: null, error: '', loading: false, at: 0, hilfe: null, hilfeBusy: false, busy: new Set() }
  const AMPEL = { gruen: ['good', 'Grün'], gelb: ['warn', 'Gelb'], rot: ['bad', 'Rot'] }
  const ICON = { laeuft: 'activity', braucht: 'bulb', getan: 'check', gelernt: 'brain' }

  async function load(h, force = false) {
    if (local.loading || (!force && local.at && Date.now() - local.at < MAX_AGE)) return
    local.loading = true
    try { local.data = await h.api.get(PATH); local.error = '' } catch (error) { local.error = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally { local.loading = false; local.at = Date.now(); h.rerender() }
  }

  function tiles(h, cockpit) {
    if (!Array.isArray(cockpit) || !cockpit.length) return ''
    return `<section class="cockpit" aria-label="Auf einen Blick">${cockpit.map(tile => {
      const [tone, label] = AMPEL[tile.ampel] || AMPEL.gruen
      return `<article class="cockpit-tile ampel-${h.attr(tile.ampel)}" aria-label="${h.attr(tile.titel)}: ${h.attr(label)}">
        <header><span class="ampel-dot ${tone}" aria-hidden="true"></span><h2>${h.icon(ICON[tile.id] || 'dot', 'sm')}${h.esc(tile.titel)}</h2></header>
        <p class="cockpit-satz">${h.esc(tile.satz)}</p>
        ${(tile.zeilen || []).length ? `<ul>${tile.zeilen.map(line => `<li>${h.esc(line)}</li>`).join('')}</ul>` : ''}
        ${tile.id === 'braucht' && tile.karteId ? '<a class="link-button" href="#ask-title">Zur Frage</a>' : ''}
      </article>`
    }).join('')}</section>`
  }

  function setup(h, list) {
    if (!list || list.fertig) return ''
    const rows = list.punkte.map(item => `<li class="${item.erledigt ? 'done' : 'open'}"><span class="check" aria-hidden="true">${item.erledigt ? h.icon('check', 'sm') : ''}</span>
      <div><div class="row-title">${h.esc(item.titel)}</div>${item.erledigt ? '' : `<div class="row-sub">${h.esc(item.satz)}</div>`}</div>
      ${item.knopf ? `<div class="row-side"><button class="primary" data-guided-item="${h.attr(item.key)}" data-guided-art="${h.attr(item.knopf.aktion.art)}" data-guided-bereich="${h.attr(item.knopf.aktion.bereich || '')}" ${local.busy.has(item.key) ? 'disabled' : ''}>${h.esc(item.knopf.label)}</button><button class="ghost" data-guided-skip="${h.attr(item.key)}" title="Nicht nötig">Nicht nötig</button></div>` : ''}</li>`).join('')
    return `<section class="section setup-list" aria-labelledby="setup-title"><div class="section-head"><h2 id="setup-title">${h.icon('sparkles')}Einrichtung</h2><span class="pill info">${h.esc(list.kopf)}</span></div>
      <ul class="checklist">${rows}</ul></section>`
  }

  function examples(h, list) {
    if (!Array.isArray(list) || !list.length) return ''
    return list.map(item => `<section class="section examples" aria-label="${h.attr(item.titel)} verbunden"><div class="section-head"><h2>${h.icon('check')}${h.esc(item.titel)} ist verbunden. Probier mal:</h2><button class="ghost" data-guided-hide="${h.attr(item.key)}">Ausblenden</button></div>
      <div class="prompt-grid">${item.saetze.map(satz => `<button data-guided-ask="${h.attr(satz)}">${h.esc(satz)}</button>`).join('')}</div></section>`).join('')
  }

  function tip(h, tipp) {
    if (!tipp) return ''
    return `<section class="section tip" aria-label="Tipp"><div class="section-body"><p>${h.icon('bulb', 'sm')}${h.esc(tipp.text)}</p>
      <div class="toolbar"><button class="primary" data-guided-ask="${h.attr(tipp.knopf.satz)}">${h.esc(tipp.knopf.label)}</button><button class="secondary" data-guided-tip-no="${h.attr(tipp.id)}">Nein danke</button></div></div></section>`
  }

  function help(h) {
    const answer = local.hilfe
    const button = answer?.knopf ? (answer.knopf.aktion.art === 'app' ? `<button class="primary" data-section="${h.attr(answer.knopf.aktion.bereich)}">${h.esc(answer.knopf.label)}</button>`
      : answer.knopf.aktion.art === 'verbinden' ? `<button class="primary" data-guided-item="${h.attr(answer.knopf.aktion.key)}" data-guided-art="verbinden">${h.esc(answer.knopf.label)}</button>`
        : answer.knopf.aktion.art === 'frage-zeigen' ? `<a class="link-button" href="#ask-title">${h.esc(answer.knopf.label)}</a>`
          : `<button class="secondary" data-guided-help>${h.esc(answer.knopf.label)}</button>`) : ''
    return `<section class="section help" aria-label="Hilfe"><div class="section-body">
      <button class="secondary" data-guided-help ${local.hilfeBusy ? 'disabled' : ''}>${h.icon('alert', 'sm')}Ich komm nicht weiter</button>
      ${answer ? `<div class="help-answer" role="status"><p>${h.esc(answer.satz)}</p>${button}</div>` : ''}</div></section>`
  }

  /** Guided parts (setup, example sentences, tip, help) — shown under the one open question. */
  function guided(h) {
    if (!local.data && !local.loading && !local.error) void load(h)
    const data = local.data || {}
    return `${setup(h, data.einrichtung)}${examples(h, data.beispiele)}${tip(h, data.tipp)}${help(h)}`
  }

  /** Cockpit tiles + guided parts (for callers without their own question block). */
  function view(h, heute) {
    return `${tiles(h, heute?.cockpit)}${guided(h)}`
  }

  async function act(h, body, key) {
    if (key) local.busy.add(key)
    h.rerender()
    try { const result = await h.api.post(`${PATH}/aktion`, body); if (result?.message) h.toast(result.message) } catch (error) { h.fail(error) }
    finally { if (key) local.busy.delete(key); await load(h, true) }
  }

  function mount(h) {
    const page = document.querySelector('.page')
    if (!page) return
    page.querySelectorAll('[data-guided-item]').forEach(node => node.addEventListener('click', () => {
      if (node.dataset.guidedArt === 'app') return h.navigate(node.dataset.guidedBereich || 'verbindungen')
      void act(h, { art: 'einrichten', key: node.dataset.guidedItem }, node.dataset.guidedItem)
    }))
    page.querySelectorAll('[data-guided-skip]').forEach(node => node.addEventListener('click', () => act(h, { art: 'ueberspringen', key: node.dataset.guidedSkip }, node.dataset.guidedSkip)))
    page.querySelectorAll('[data-guided-hide]').forEach(node => node.addEventListener('click', () => act(h, { art: 'beispiele-weg', key: node.dataset.guidedHide })))
    page.querySelectorAll('[data-guided-tip-no]').forEach(node => node.addEventListener('click', () => act(h, { art: 'tipp-nein', id: node.dataset.guidedTipNo })))
    page.querySelectorAll('[data-guided-ask]').forEach(node => node.addEventListener('click', () => h.ask(node.dataset.guidedAsk)))
    page.querySelectorAll('[data-guided-help]').forEach(node => node.addEventListener('click', async () => {
      local.hilfeBusy = true
      h.rerender()
      try { local.hilfe = await h.api.post(`${PATH}/hilfe`, {}) } catch (error) { h.fail(error) }
      finally { local.hilfeBusy = false; h.rerender() }
    }))
  }

  window.XaventraCockpit = { view, guided, mount, load, tiles, _local: local }
})()
