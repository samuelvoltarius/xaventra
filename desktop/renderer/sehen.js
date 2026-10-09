// „Sehen und lenken“ (2.88): drei Seiten in einer Datei — dieselbe in der
// Desktop-App und in der Web-App (bridge.js).
//   bildschirme Dein Computer: Bildschirme, live zusehen, Übernehmen/Zurückgeben,
//               Stoppen, Anderes Ziel (Alias: computer)
//   aktivitaet  alles, was sie gerade und im Hintergrund tut, mit Stopp/Später/Anders
//   regeln      Regeln in Klartext: erlauben / fragen / blockieren
// app.js ruft view(section, h, { bare }) und mount(section, h) auf (h = Helfer).
// Mit bare: true entfällt die Seitenhülle — für Reiter in Arbeit/System.
// Kein Knopf hier umgeht etwas: alles läuft über /api/desktop/* (nur Owner).
;(() => {
  const LIVE_MS = 1500
  const local = {
    aktivitaet: { data: null, error: '', loading: false, at: 0 },
    bildschirme: { data: null, error: '', loading: false, at: 0 },
    regeln: { data: null, error: '', loading: false, at: 0 },
    live: null, liveText: '', liveSrc: '', liveTimer: null, liveBusy: false, anders: null, busy: new Set(), entwurf: '',
  }
  const PATHS = { aktivitaet: '/api/desktop/aktivitaet', bildschirme: '/api/desktop/bildschirme', regeln: '/api/desktop/regeln' }
  const MAX_AGE = { aktivitaet: 8000, bildschirme: 10000, regeln: 30000 }
  const STATUS_TONE = { laeuft: 'good', wartet: 'warn', geplant: 'info', spaeter: '', pausiert: '' }
  const WIRKUNG = { erlauben: ['good', 'ohne Frage'], fragen: ['warn', 'erst fragen'], blockieren: ['bad', 'nie'] }
  const enc = value => encodeURIComponent(String(value || ''))

  async function load(h, name, force = false) {
    const slot = local[name]
    if (slot.loading || (!force && slot.at && Date.now() - slot.at < MAX_AGE[name])) return
    slot.loading = true
    try { slot.data = await h.api.get(PATHS[name]); slot.error = '' } catch (error) { slot.error = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally { slot.loading = false; slot.at = Date.now(); h.rerender() }
  }

  function head(h, eyebrow, title, text) {
    return `<header class="page-head"><div><div class="eyebrow">${h.esc(eyebrow)}</div><h1>${h.esc(title)}</h1><p>${h.esc(text)}</p></div></header>`
  }
  function shell(inner) { return `<div class="page"><div class="page-inner">${inner}</div></div>` }
  function wrap(bare, inner) { return bare ? inner : shell(inner) }
  function problems(h, list) {
    if (!(list || []).length) return ''
    if (typeof h.problemsNote === 'function') return h.problemsNote(list)
    return `<div class="empty-note">${h.icon('alert', 'sm')}Teilweise nicht lesbar: ${h.esc(list.join(' · '))}. Noch einmal aktualisieren.</div>`
  }
  function waiting(h, slot, label) {
    if (slot.error && !slot.data) return `<section class="section"><div class="section-body"><div class="empty-note">${h.esc(slot.error)}</div></div></section>`
    return `<section class="section" aria-busy="true"><div class="section-body"><div class="empty-note">${h.esc(label)} …</div></div></section>`
  }

  // ── Dein Computer (Bildschirme) ───────────────────────────
  function screenRow(h, screen) {
    const watching = local.live === screen.id
    const state = screen.uebernommen ? '<span class="pill warn">du hast übernommen</span>' : screen.gestoppt ? '<span class="pill bad">gestoppt</span>'
      : `<span class="pill ${screen.zustand === 'bereit' ? 'good' : screen.zustand === 'gesperrt' ? 'warn' : ''}">${h.esc(screen.zustandText)}</span>`
    const held = screen.uebernommen || screen.gestoppt
    const buttons = [
      screen.zuschauen === 'link'
        ? `<button class="secondary" data-sehen-link="${h.attr(screen.id)}" data-mode="view">${h.icon('eye', 'sm')}Zuschauen</button>`
        : `<button class="${watching ? 'primary' : 'secondary'}" data-sehen-watch="${h.attr(screen.id)}">${h.icon('eye', 'sm')}${watching ? 'Schaue zu' : 'Zuschauen'}</button>`,
      held ? `<button class="primary" data-sehen-screen="${h.attr(screen.id)}" data-aktion="zurueckgeben">Zurückgeben</button>`
        : `<button class="secondary" data-sehen-screen="${h.attr(screen.id)}" data-aktion="uebernehmen">${h.icon('pointer', 'sm')}Übernehmen</button>`,
      held ? '' : `<button class="secondary" data-sehen-screen="${h.attr(screen.id)}" data-aktion="stoppen">${h.icon('x', 'sm')}Stoppen</button>`,
      `<button class="ghost" data-sehen-ziel="${h.attr(screen.id)}">Anderes Ziel</button>`,
    ].join('')
    const ziel = local.anders === `screen:${screen.id}` ? `<form class="form inline" data-sehen-ziel-form="${h.attr(screen.id)}"><label>Was soll ich stattdessen tun?<input name="text" maxlength="500" autocomplete="off" placeholder="z. B. Erst die Mails sortieren"></label><button class="primary" type="submit">Schicken</button></form>` : ''
    return `<div class="row screen-row"><div><div class="row-title">${h.icon(screen.art === 'virtuell' ? 'layers' : 'monitor', 'sm')}${h.esc(screen.name)}</div>
      <div class="row-sub">${h.esc(screen.art === 'virtuell' ? 'virtueller Bildschirm' : screen.lokal ? 'dieser Rechner' : 'Rechner im Netz')}${screen.tut ? ` · tut gerade: ${h.esc(screen.tut)}` : ''}</div>${ziel}</div>
      <div class="row-side">${state}${buttons}</div></div>`
  }

  function liveBlock(h, screens) {
    const screen = (screens || []).find(item => item.id === local.live)
    if (!screen) return ''
    const control = screen.uebernommen && screen.eingabeErlaubt
    return `<section class="section sehen-live" aria-labelledby="live-title"><div class="section-head"><h2 id="live-title">${h.icon('eye')}${h.esc(screen.name)} – live</h2>
      <div class="row-side"><span class="section-note" id="sehen-live-status">${h.esc(local.liveText || 'Bild wird geholt …')}</span><button class="ghost" data-sehen-unwatch>Schließen</button></div></div>
      <div class="section-body"><div class="sehen-bild ${control ? 'steuerbar' : ''}"><img id="sehen-live" alt="Bildschirm von ${h.attr(screen.name)}" data-screen="${h.attr(screen.id)}"${local.liveSrc ? ` src="${h.attr(local.liveSrc)}"` : ''}></div>
      ${control ? `<form class="form inline" data-sehen-type="${h.attr(screen.id)}"><label>Tippen<input name="text" maxlength="500" autocomplete="off"></label><button class="secondary" type="submit">Senden</button>
        <button class="ghost" type="button" data-sehen-key="Return">Enter</button><button class="ghost" type="button" data-sehen-key="Escape">Esc</button></form>
        <p class="section-note">Klick ins Bild = Klick auf dem Bildschirm. Ich selbst fasse nichts an, bis du „Zurückgeben“ drückst.</p>`
        : screen.uebernommen ? '<p class="section-note">Ich schaue nur zu. Eingaben von hier sind auf diesem Rechner nicht freigegeben.</p>' : ''}</div></section>`
  }

  function computerView(h, bare = false) {
    const slot = local.bildschirme
    if (!slot.data && !slot.loading) void load(h, 'bildschirme')
    const intro = head(h, 'Computer-Session', 'Dein Computer', 'Desktop, Browser, Terminal und Dateien – auf jedem Rechner mit Bildschirm. Zuschauen, übernehmen, stoppen oder ein anderes Ziel geben.')
    if (!slot.data) return wrap(bare, intro + waiting(h, slot, 'Bildschirme werden gesucht'))
    const d = slot.data
    const rows = (d.bildschirme || []).map(screen => screenRow(h, screen)).join('')
    const none = `<div class="empty-note">Gerade sehe ich keinen Bildschirm. Auf einem Rechner mit Bildschirm muss die Aufnahme einmal am Gerät eingerichtet werden.</div>`
    const paused = d.agentPausiert ? `<div class="empty-note">${h.icon('pointer', 'sm')}Meine Maus und Tastatur sind gerade pausiert.</div>` : ''
    const headless = (d.ohneBildschirm || []).length ? `<p class="section-note">Ohne Bildschirm: ${h.esc(d.ohneBildschirm.join(', '))}</p>` : ''
    return wrap(bare, `${intro}${problems(h, d.probleme)}${liveBlock(h, d.bildschirme)}
      <section class="section" aria-labelledby="screens-title"><div class="section-head"><h2 id="screens-title">${h.icon('monitor')}Bildschirme</h2></div>
      <div class="section-body">${paused}<div class="rows">${rows || none}</div>${headless}</div></section>`)
  }

  async function liveTick(h) {
    const img = document.querySelector('#sehen-live')
    if (!img || !local.live) { stopLive(); return }
    if (document.visibilityState === 'hidden' || local.liveBusy) return
    local.liveBusy = true
    try {
      const result = await h.api.get(`${PATHS.bildschirme}/${enc(local.live)}/bild`)
      const now = document.querySelector('#sehen-live')
      if (!now || now.dataset.screen !== local.live) return
      if (result?.ok && result.bild?.base64) {
        local.liveSrc = `data:${result.bild.mimeType};base64,${result.bild.base64}`
        now.src = local.liveSrc
        local.liveText = `Stand ${new Date(result.bild.capturedAt).toLocaleTimeString('de-AT')}`
      } else local.liveText = result?.message || 'Gerade kein Bild.'
    } catch (error) { local.liveText = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally {
      local.liveBusy = false
      const status = document.querySelector('#sehen-live-status')
      if (status) status.textContent = local.liveText
    }
  }
  function startLive(h) {
    stopLive()
    if (!local.live) return
    void liveTick(h)
    local.liveTimer = setInterval(() => void liveTick(h), LIVE_MS)
  }
  function stopLive() { if (local.liveTimer) clearInterval(local.liveTimer); local.liveTimer = null }

  async function screenAction(h, id, body) {
    local.busy.add(id)
    try { const result = await h.api.post(`${PATHS.bildschirme}/${enc(id)}`, body); h.toast(result?.message || 'Erledigt.') } catch (error) { h.fail(error) }
    finally { local.busy.delete(id); local.anders = null; await load(h, 'bildschirme', true); void load(h, 'aktivitaet', true) }
  }
  async function input(h, id, action) {
    try {
      const result = await h.api.post(`${PATHS.bildschirme}/${enc(id)}/eingabe`, { action })
      if (!result?.ok) h.toast(result?.message || 'Eingabe ging nicht.', true)
      else setTimeout(() => void liveTick(h), 300)
    } catch (error) { h.fail(error) }
  }

  function mountComputer(h, page) {
    page.querySelectorAll('[data-sehen-watch]').forEach(node => node.addEventListener('click', () => { local.live = node.dataset.sehenWatch; local.liveText = ''; local.liveSrc = ''; h.rerender() }))
    page.querySelectorAll('[data-sehen-unwatch]').forEach(node => node.addEventListener('click', () => { local.live = null; local.liveSrc = ''; stopLive(); h.rerender() }))
    page.querySelectorAll('[data-sehen-link]').forEach(node => node.addEventListener('click', () => {
      const id = node.dataset.sehenLink.replace(/^direkt:/, '')
      if (h.openDesktop) void h.openDesktop(id, node.dataset.mode || 'view')
    }))
    page.querySelectorAll('[data-sehen-screen]').forEach(node => node.addEventListener('click', async () => {
      const id = node.dataset.sehenScreen
      const aktion = node.dataset.aktion
      await screenAction(h, id, { aktion })
      // Virtueller Bildschirm: Übernehmen öffnet zusätzlich das eigene Fenster zum Bedienen.
      const screen = (local.bildschirme.data?.bildschirme || []).find(item => item.id === id)
      if (aktion === 'uebernehmen' && screen?.linkSteuern && h.openDesktop) void h.openDesktop(id.replace(/^direkt:/, ''), 'control')
      if (aktion === 'uebernehmen' && screen?.zuschauen === 'bild') { local.live = id; h.rerender() }
    }))
    page.querySelectorAll('[data-sehen-ziel]').forEach(node => node.addEventListener('click', () => { local.anders = `screen:${node.dataset.sehenZiel}`; h.rerender(); document.querySelector('[data-sehen-ziel-form] input')?.focus() }))
    page.querySelectorAll('[data-sehen-ziel-form]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const text = form.querySelector('input')?.value || ''
      document.activeElement?.blur?.()
      void screenAction(h, form.dataset.sehenZielForm, { aktion: 'ziel', text })
    }))
    const img = page.querySelector('#sehen-live')
    if (img) {
      img.addEventListener('click', event => {
        const screen = (local.bildschirme.data?.bildschirme || []).find(item => item.id === img.dataset.screen)
        if (!screen?.uebernommen || !screen.eingabeErlaubt || !img.naturalWidth) return
        const rect = img.getBoundingClientRect()
        const x = Math.round((event.clientX - rect.left) * img.naturalWidth / rect.width)
        const y = Math.round((event.clientY - rect.top) * img.naturalHeight / rect.height)
        void input(h, screen.id, { action: 'click', x: Math.max(0, x), y: Math.max(0, y), button: 'left' })
      })
      startLive(h)
    } else stopLive()
    page.querySelectorAll('[data-sehen-type]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const field = form.querySelector('input')
      const text = field?.value || ''
      if (!text) return
      field.value = ''
      void input(h, form.dataset.sehenType, { action: 'type', text })
    }))
    page.querySelectorAll('[data-sehen-key]').forEach(node => node.addEventListener('click', () => {
      const form = node.closest('[data-sehen-type]')
      if (form) void input(h, form.dataset.sehenType, { action: 'key', key: node.dataset.sehenKey })
    }))
  }

  // ── Aktivität ────────────────────────────────────────────
  const BUTTON = { stopp: ['secondary', 'Stopp'], spaeter: ['ghost', 'Später'], weiter: ['primary', 'Weiter'], anders: ['ghost', 'Anders …'] }
  function activityRow(h, item) {
    const busy = local.busy.has(item.id)
    const buttons = item.aktionen.map(aktion => `<button class="${BUTTON[aktion][0]}" data-sehen-akt="${h.attr(item.id)}" data-aktion="${aktion}" ${busy ? 'disabled' : ''}>${h.esc(BUTTON[aktion][1])}</button>`).join('')
    const anders = local.anders === `akt:${item.id}` ? `<form class="form inline" data-sehen-anders="${h.attr(item.id)}"><label>Anders: …<input name="text" maxlength="500" autocomplete="off" placeholder="Was soll ich stattdessen tun?"></label><button class="primary" type="submit">An den Planer</button></form>` : ''
    const meta = [item.node && item.node !== 'main' ? item.node : '', item.grund, item.naechster ? `nächstes Mal ${new Date(item.naechster).toLocaleString('de-AT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''].filter(Boolean)
    return `<div class="row activity-row"><div><div class="row-title"><span class="pill">${h.esc(item.artText)}</span> ${h.esc(item.tut || item.titel)}</div>
      <div class="row-sub">${h.esc(item.tut && item.tut !== item.titel ? `${item.titel} · ` : '')}${h.esc(meta.join(' · '))}</div>${anders}</div>
      <div class="row-side"><span class="pill ${STATUS_TONE[item.status] || ''}">${h.esc(item.statusText)}</span>${buttons}</div></div>`
  }
  function aktivitaetView(h, bare = false) {
    const slot = local.aktivitaet
    if (!slot.data && !slot.loading) void load(h, 'aktivitaet')
    const intro = head(h, 'Sehen und lenken', 'Aktivität', 'Was ich gerade und im Hintergrund tue – mit Status, Rechner und Grund. Stopp, Später oder Anders: du lenkst.')
    if (!slot.data) return wrap(bare, intro + waiting(h, slot, 'Aktivität wird gelesen'))
    const items = slot.data.eintraege || []
    const now = items.filter(item => item.jetzt)
    const bg = items.filter(item => !item.jetzt)
    const section = (id, title, list, empty) => `<section class="section" aria-labelledby="${id}"><div class="section-head"><h2 id="${id}">${h.icon(id === 'akt-jetzt' ? 'activity' : 'clock')}${h.esc(title)}${list.length ? `<span class="count">${list.length}</span>` : ''}</h2></div>
      <div class="section-body"><div class="rows">${list.map(item => activityRow(h, item)).join('') || `<div class="empty-note">${h.esc(empty)}</div>`}</div></div></section>`
    return wrap(bare, `${intro}${problems(h, slot.data.probleme)}${section('akt-jetzt', 'Gerade', now, 'Gerade arbeite ich an nichts Bestimmtem.')}${section('akt-hinten', 'Im Hintergrund', bg, 'Im Hintergrund läuft nichts.')}`)
  }
  async function activityAction(h, id, body) {
    local.busy.add(id)
    h.rerender()
    try { const result = await h.api.post(`${PATHS.aktivitaet}/${enc(id)}`, body); h.toast(result?.message || 'Erledigt.', result?.ok === false) } catch (error) { h.fail(error) }
    finally { local.busy.delete(id); local.anders = null; await load(h, 'aktivitaet', true) }
  }
  function mountAktivitaet(h, page) {
    page.querySelectorAll('[data-sehen-akt]').forEach(node => node.addEventListener('click', () => {
      const id = node.dataset.sehenAkt
      if (node.dataset.aktion === 'anders') { local.anders = `akt:${id}`; h.rerender(); document.querySelector('[data-sehen-anders] input')?.focus(); return }
      void activityAction(h, id, { aktion: node.dataset.aktion })
    }))
    page.querySelectorAll('[data-sehen-anders]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const text = form.querySelector('input')?.value || ''
      document.activeElement?.blur?.()
      void activityAction(h, form.dataset.sehenAnders, { aktion: 'anders', text })
    }))
  }

  // ── Regeln ───────────────────────────────────────────────
  function ruleRow(h, regel) {
    const [tone, label] = WIRKUNG[regel.wirkung] || ['', regel.wirkung]
    const busy = local.busy.has(regel.id)
    const choose = ['erlauben', 'fragen', 'blockieren'].map(w => `<button class="${regel.wirkung === w ? 'primary' : 'ghost'}" data-sehen-regel="${h.attr(regel.id)}" data-wirkung="${w}" ${busy || regel.wirkung === w ? 'disabled' : ''} aria-pressed="${regel.wirkung === w}">${h.esc(WIRKUNG[w][1])}</button>`).join('')
    return `<div class="row rule-row"><div><div class="row-title">„${h.esc(regel.satz)}“</div>
      <div class="row-sub"><span class="pill ${regel.fest ? '' : tone}">${h.esc(regel.fest ? 'feste Grenze' : label)}</span> ${h.esc(regel.bereich)} · ${h.esc(regel.hinweis)}</div></div>
      <div class="row-side"><div class="segmented" role="group" aria-label="Wirkung">${choose}</div><button class="ghost" data-sehen-regel-weg="${h.attr(regel.id)}" ${busy ? 'disabled' : ''}>Entfernen</button></div></div>`
  }
  function regelnView(h, bare = false) {
    const slot = local.regeln
    if (!slot.data && !slot.loading) void load(h, 'regeln')
    const intro = head(h, 'Sehen und lenken', 'Regeln', 'Sag in einem Satz, was ich ohne Frage darf, wo ich fragen soll und was nie. Das geht auch einfach im Gespräch.')
    const examples = (slot.data?.beispiele || ['Lichter darfst du ohne Frage schalten', 'Bei Mails immer fragen', 'Nie etwas löschen'])
      .map(text => `<button class="ghost" type="button" data-sehen-beispiel="${h.attr(text)}">${h.esc(text)}</button>`).join('')
    const form = `<section class="section" aria-labelledby="regel-neu"><div class="section-head"><h2 id="regel-neu">${h.icon('plus')}Neue Regel</h2></div><div class="section-body">
      <form class="form inline" data-sehen-regel-form><label>In einem Satz<input name="text" maxlength="300" autocomplete="off" value="${h.attr(local.entwurf)}" placeholder="z. B. Lichter darfst du ohne Frage schalten"></label><button class="primary" type="submit">Merken</button></form>
      <div class="prompt-grid">${examples}</div>
      <p class="section-note">${h.esc(slot.data?.fest || 'Geld, Passwörter und Zugangsdaten, Löschen und die Nie-Liste bleiben immer fest.')}</p></div></section>`
    if (!slot.data) return wrap(bare, intro + form + waiting(h, slot, 'Regeln werden gelesen'))
    const rows = (slot.data.regeln || []).map(regel => ruleRow(h, regel)).join('')
    return wrap(bare, `${intro}${form}<section class="section" aria-labelledby="regel-liste"><div class="section-head"><h2 id="regel-liste">${h.icon('shield')}Deine Regeln${(slot.data.regeln || []).length ? `<span class="count">${slot.data.regeln.length}</span>` : ''}</h2></div>
      <div class="section-body"><div class="rows">${rows || '<div class="empty-note">Noch keine Regeln. Ohne Regel frage ich bei allem, was etwas verändert.</div>'}</div></div></section>`)
  }
  async function ruleCall(h, id, run) {
    if (id) local.busy.add(id)
    h.rerender()
    try { const result = await run(); h.toast(result?.message || 'Erledigt.', result?.ok === false); return result } catch (error) { h.fail(error); return null }
    finally { if (id) local.busy.delete(id); await load(h, 'regeln', true) }
  }
  function mountRegeln(h, page) {
    page.querySelectorAll('[data-sehen-beispiel]').forEach(node => node.addEventListener('click', () => {
      const field = page.querySelector('[data-sehen-regel-form] input')
      if (field) { field.value = node.dataset.sehenBeispiel; local.entwurf = field.value; field.focus() }
    }))
    const form = page.querySelector('[data-sehen-regel-form]')
    form?.querySelector('input')?.addEventListener('input', event => { local.entwurf = event.target.value })
    form?.addEventListener('submit', async event => {
      event.preventDefault()
      const text = form.querySelector('input')?.value || ''
      document.activeElement?.blur?.()
      const result = await ruleCall(h, null, () => h.api.post(PATHS.regeln, { text }))
      if (result?.ok) local.entwurf = ''
    })
    page.querySelectorAll('[data-sehen-regel]').forEach(node => node.addEventListener('click', () => {
      void ruleCall(h, node.dataset.sehenRegel, () => h.api.post(`${PATHS.regeln}/${enc(node.dataset.sehenRegel)}`, { wirkung: node.dataset.wirkung }))
    }))
    page.querySelectorAll('[data-sehen-regel-weg]').forEach(node => node.addEventListener('click', () => {
      void ruleCall(h, node.dataset.sehenRegelWeg, () => h.api.delete(`${PATHS.regeln}/${enc(node.dataset.sehenRegelWeg)}`))
    }))
  }

  // ── Einstieg für app.js ──────────────────────────────────
  function view(section, h, options) {
    const bare = options?.bare === true
    if (section === 'computer' || section === 'bildschirme') return computerView(h, bare)
    if (section === 'aktivitaet') return aktivitaetView(h, bare)
    return regelnView(h, bare)
  }
  function mount(section, h) {
    const page = document.querySelector('.page')
    const screens = section === 'computer' || section === 'bildschirme'
    if (!screens) stopLive()
    if (!page || !section) return
    if (screens) { void load(h, 'bildschirme'); mountComputer(h, page) }
    if (section === 'aktivitaet') { void load(h, 'aktivitaet'); mountAktivitaet(h, page) }
    if (section === 'regeln') { void load(h, 'regeln'); mountRegeln(h, page) }
  }
  /** Leaving the page: stop the live picture (no polling in the background). */
  function leave() { stopLive() }

  window.XaventraSehen = { view, mount, leave, load, _local: local }
})()
