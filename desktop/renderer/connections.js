// Verbindungen (2.85 Paket A): Gefunden / Möglich / Verbunden.
// Eigene Datei; app.js ruft nur view(h) und mount(h) auf (h = Helfer aus app.js:
// api, esc, attr, icon, toast, fail, rerender, showModal, closeModal).
// Jeder Knopf startet nur den vorhandenen Weg: „Verbinden“ legt eine Karte an
// (Ja/Nein direkt hier oder unter „Heute“), „Anmelden“ öffnet die Login-Seite
// des Dienstes, „Trennen“ trennt. Konfiguration ändert sich nur nach dem Ja.
// KI-Modelle (Paket C) stehen hier mit: lokale Modelle und SearXNG unter
// „Gefunden“ (lokal = ohne Frage nutzbar), Cloud-Anbieter unter „Möglich“ mit
// API-Key (einmal einfügen, sofort geprüft, nie wieder angezeigt) oder – nur wo
// der Anbieter es offiziell erlaubt – Anmeldung mit Konto.
;(() => {
  const PATH = '/api/desktop/verbindungen'
  const LLM = '/api/desktop/llm-connections'
  const SMART = '/api/desktop/smart-geraete'
  let smartDevices = [], smartError = ''
  const local = { data: null, error: '', loading: false, at: 0, tried: 0, query: '', results: null, searching: false, busy: new Set(), cards: {}, icons: {} }
  const MAX_AGE = 20_000

  const statusLabel = {
    verbunden: ['good', 'verbunden'], 'wartet-auf-anmeldung': ['warn', 'Anmeldung fehlt'], 'wartet-auf-zugang': ['warn', 'Zugang fehlt'],
    abgelaufen: ['warn', 'Anmeldung abgelaufen'], fehler: ['bad', 'Fehler'], getrennt: ['', 'getrennt'],
  }
  const img = (h, src, label) => src ? `<img src="${h.attr(src)}" width="28" height="28" alt="" aria-hidden="true">` : `<span class="pill" aria-hidden="true">${h.esc(String(label || '?').slice(0, 2))}</span>`
  const where = (h, klasse) => klasse === 'cloud' ? '<span class="pill info">Cloud · nichts Privates</span>' : klasse === 'lokal' ? '<span class="pill good">lokal</span>' : ''

  function stufePill(h, stufe) {
    return stufe === 'unbekannt' ? '<span class="pill bad">unbekannt – fragt bei allem</span>' : '<span class="pill warn">nicht geprüft</span>'
  }

  // 2.88: found, but no checked connector → matching entries from the (checked) directory.
  function directoryHints(h, item) {
    const list = item.verzeichnis || []
    if (!list.length || item.verbunden) return ''
    return `<div class="row-sub">Passend im MCP-Verzeichnis: ${list.map(entry => `${h.esc(entry.title)} ${stufePill(h, entry.stufe)} <button class="link-button" data-conn-connect="${h.attr(entry.connectorId)}">Verbinden</button>${cardButtons(h, entry.connectorId)}`).join(' · ')}</div>`
  }

  function cardButtons(h, connectorId) {
    const cardId = local.cards[connectorId]
    if (!cardId) return ''
    const busy = local.busy.has(cardId)
    return `<div class="answer-row" role="group" aria-label="Verbinden bestätigen"><span class="section-note">Verbinden?</span>
      <button class="primary" data-conn-card="${h.attr(cardId)}" data-conn-answer="ja" ${busy ? 'disabled' : ''}>${h.icon('check', 'sm')}Ja</button>
      <button class="secondary" data-conn-card="${h.attr(cardId)}" data-conn-answer="nein" ${busy ? 'disabled' : ''}>${h.icon('x', 'sm')}Nein</button></div>`
  }

  // KI-Modelle: Key einfügen (immer), Konto-Anmeldung nur wo der Anbieter es Drittanwendungen erlaubt.
  function llmButtons(h, llm) {
    return `${llm.kontoHinweis ? `<p class="section-note">${h.esc(llm.kontoHinweis)}</p>` : ''}<div class="toolbar">
      <button class="secondary" data-conn-llm-key="${h.attr(llm.provider)}">API-Key einfügen</button>
      ${llm.konto ? `<button class="primary" data-conn-llm-login="${h.attr(llm.provider)}">Mit Konto anmelden</button>` : ''}</div>`
  }

  // Paket L: one row per real device; Hue/Tuya/Matter get their own „Verbinden“ (one card each, Tuya: lokal or Cloud).
  function deviceButtons(h, item) {
    const g = item.geraet
    if (!g?.verbinden || item.verbunden || item.connectorId) return ''
    if (g.verbinden === 'tuya') return `<button class="primary" data-conn-device="${h.attr(g.id)}" data-conn-weg="local">Lokal verbinden</button><button class="secondary" data-conn-device="${h.attr(g.id)}" data-conn-weg="cloud">Über Cloud</button>`
    return `<button class="primary" data-conn-device="${h.attr(g.id)}">${g.verbinden === 'hue' || g.verbinden === 'matter' ? 'Koppeln' : 'Verbinden'}</button>`
  }

  function foundSection(h, data) {
    const items = data.gefunden || []
    const rows = items.map(item => `<div class="row"><div>${img(h, item.icon, item.title)}<div class="row-title">${h.esc(item.title)}</div>
      <div class="row-sub">${h.esc(item.fund)} · ${h.esc(item.wirkung)}${item.geraet?.dienste > 1 ? ` · ${Number(item.geraet.dienste)} Dienste` : ''}</div>${item.connectorId ? cardButtons(h, item.connectorId) : item.geraet ? cardButtons(h, `geraet:${item.geraet.id}`) : ''}
      ${item.geraet?.verbinden === 'hue' && !item.verbunden ? '<div class="row-sub">Vor dem Ja die runde Taste an der Bridge drücken.</div>' : ''}${directoryHints(h, item)}</div>
      <div class="row-side">${where(h, item.datenklasse)}${item.verbunden ? `<span class="pill good">${item.connectorId ? 'verbunden' : 'in Nutzung'}</span>`
        : item.connectorId ? `<button class="primary" data-conn-connect="${h.attr(item.connectorId)}">Verbinden</button>` : deviceButtons(h, item)}</div></div>`).join('')
    return `<section class="section" aria-labelledby="conn-found"><div class="section-head"><h2 id="conn-found">${h.icon('eye')}Gefunden</h2><span class="section-note">selbst entdeckt – sie fragt deswegen nicht</span></div>
      ${rows ? `<div class="rows">${rows}</div>` : `<div class="section-body"><div class="empty-note">Noch nichts gefunden. Sie sucht selbst im eigenen Netz und in den eigenen Konten.</div></div>`}</section>`
  }

  function possibleSection(h, data) {
    const groups = data.moeglich?.gruppen || []
    const dir = data.moeglich?.verzeichnis || {}
    const tiles = groups.map(group => `<article class="tile"><header><div><h3>${h.esc(group.label)}</h3></div></header>
      ${group.eintraege.map(item => `<div>${img(h, item.icon, item.title)} <strong>${h.esc(item.title)}</strong> ${where(h, item.datenklasse)} <span class="pill good">geprüft</span>
        <p>${h.esc(item.wirkung)}</p>${item.hinweis ? `<p class="section-note">${h.esc(item.hinweis)}</p>` : ''}
        ${item.status === 'verbunden' ? '<span class="pill good">verbunden</span>' : item.status === 'wartet' ? '<span class="pill warn">eingerichtet – siehe unten</span>'
          : item.llm ? llmButtons(h, item.llm)
          : `<div class="toolbar"><button class="secondary" data-conn-connect="${h.attr(item.connectorId)}">Verbinden</button></div>`}
        ${cardButtons(h, item.connectorId)}</div>`).join('')}</article>`).join('')
    const results = local.results
    // 2.88: every hit carries Xaventra's own check (Stufe, Herausgeber, Version, Netz).
    const resultRows = results ? (results.length ? results.map(item => `<div class="row"><div>${img(h, local.icons[item.name] || item.iconData, item.title)}<div class="row-title">${h.esc(item.title)} ${stufePill(h, item.pruefung?.stufe)}</div>
      <div class="row-sub">${h.esc(item.description || item.name)}${item.remotes?.length ? '' : ' · nur als Paket – wird nie automatisch installiert'}</div>
      ${item.pruefung ? `<div class="row-sub">Von ${h.esc(item.pruefung.herausgeber || '?')}${item.pruefung.version ? `, Version ${h.esc(item.pruefung.version)}` : ''}${(item.pruefung.gruende || []).length ? ` · ${h.esc(item.pruefung.gruende.join('; '))}` : ''}</div>` : ''}${cardButtons(h, item.name)}</div>
      <div class="row-side">${item.remotes?.length ? `<button class="secondary" data-conn-connect="${h.attr(item.name)}">${item.pruefung?.stufe === 'unbekannt' ? 'Verbinden (fragt bei allem)' : 'Verbinden (nur lesen)'}</button>` : ''}</div></div>`).join('')
      : '<div class="section-body"><div class="empty-note">Nichts gefunden.</div></div>') : ''
    return `<section class="section" aria-labelledby="conn-possible"><div class="section-head"><h2 id="conn-possible">${h.icon('grid')}Möglich</h2><span class="section-note">geprüfter Katalog · lokal oder Cloud</span></div>
      <div class="tiles">${tiles}</div>
      <div class="section-body"><form class="form" data-conn-search><label>Weitere aus dem MCP-Verzeichnis (${Number(dir.anzahl || 0)} Einträge, nicht geprüft)
        <input type="search" name="q" value="${h.attr(local.query)}" placeholder="z. B. Wetter, Notizen" maxlength="80"></label>
        <div class="toolbar"><button class="secondary" type="submit" ${local.searching ? 'disabled' : ''}>Suchen</button></div></form></div>
      ${resultRows ? `<div class="rows">${resultRows}</div>` : ''}</section>`
  }

  function connectedSection(h, data) {
    const items = data.verbunden || []
    const rows = items.map(item => {
      const [tone, label] = statusLabel[item.status] || ['', item.status]
      const darf = item.darf || {}
      const test = item.letzterTest ? ` · getestet: ${item.letzterTest.werkzeuge} Werkzeuge` : ''
      return `<div class="row"><div>${img(h, item.icon, item.title)}<div class="row-title">${h.esc(item.title)} ${item.trust === 'community' ? '<span class="pill warn">nicht geprüft</span>' : ''}</div>
        ${item.llm ? `<div class="row-sub">KI-Modelle${item.llm.maske ? ` · Key ${h.esc(item.llm.maske)}` : ''}</div>` : `<div class="row-sub">Darf selbst: ${h.esc((darf.lesen || []).join(', ') || '—')}${test}</div>
        <div class="row-sub">Fragt dich: ${h.esc((darf.fragt || []).join(', ') || '—')}${(darf.nie || []).length ? ` · nie: ${h.esc(darf.nie.join(', '))}` : ''}</div>`}
        <div class="row-sub">${h.esc(darf.sonst || '')}</div></div>
        <div class="row-side"><span class="pill ${tone}">${h.esc(label)}</span>${where(h, item.datenklasse)}
          ${item.aktion === 'anmelden' ? `<button class="primary" data-conn-login="${h.attr(item.id)}">Anmelden</button>` : ''}
          ${item.aktion === 'zugang' ? `<button class="primary" data-conn-access="${h.attr(item.id)}">Zugang eintragen</button>` : ''}
          ${item.llm ? (item.llm.trennbar ? `<button class="ghost" data-conn-llm-disconnect="${h.attr(item.llm.provider)}">Trennen</button>` : '')
            : `<button class="ghost" data-conn-disconnect="${h.attr(item.id)}">Trennen</button>`}</div></div>`
    }).join('')
    return `<section class="section" aria-labelledby="conn-connected"><div class="section-head"><h2 id="conn-connected">${h.icon('check')}Verbunden</h2><span class="section-note">was sie damit darf</span></div>
      ${rows ? `<div class="rows">${rows}</div>` : `<div class="section-body"><div class="empty-note">Noch nichts verbunden.</div></div>`}</section>`
  }

  function view(h) {
    const head = `<header class="page-head"><div><div class="eyebrow">Verbindungen</div><h1>Dienste verbinden</h1><p>Sie zeigt, was sie gefunden hat und womit sie sich verbinden kann. Verbunden wird erst nach deinem Ja; Anmeldung im Browser, kein Token abtippen.</p></div>
      <div class="head-actions">${local.at ? `<span class="stamp">Stand ${h.esc(new Date(local.at).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}<button class="icon-button" data-conn-refresh title="Aktualisieren" aria-label="Aktualisieren">${h.icon('refresh')}</button></div></header>`
    if (local.error && !local.data) return `<div class="page"><div class="page-inner">${head}<div class="section"><div class="section-body"><div class="empty-note">${h.icon('alert')}<span>${h.esc(local.error)}</span></div></div></div></div></div>`
    if (!local.data) return `<div class="page"><div class="page-inner">${head}<div class="section"><div class="section-body" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div></div></div></div>`
    return `<div class="page"><div class="page-inner">${head}${foundSection(h, local.data)}${smartSection(h)}${connectedSection(h, local.data)}${window.XaventraTelefon ? window.XaventraTelefon.section(h) : ''}${window.XaventraZugaenge ? window.XaventraZugaenge.section(h) : ''}${possibleSection(h, local.data)}
      <p class="section-note">Kommt die Anmeldung auf einem anderen Gerät zurück? <button class="link-button" data-conn-paste>Rückkehr-Adresse einfügen</button></p></div></div>`
  }

  async function load(h, force = false) {
    if (local.loading || (!force && Date.now() - local.tried < MAX_AGE)) return
    local.loading = true
    local.tried = Date.now()
    try {
      local.data = await h.api.get(PATH); local.error = ''; local.at = Date.now()
      try { smartDevices = (await h.api.get(SMART)).devices || []; smartError = '' }
      catch { smartDevices = []; smartError = 'Smart-Gerätezugänge konnten nicht geladen werden.' }
    }
    catch (error) { local.error = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally { local.loading = false; h.rerender() }
  }

  async function connect(h, connectorId) {
    let body = { connectorId }
    if (connectorId === 'home-assistant' && !(local.data?.gefunden || []).some(item => item.connectorId === 'home-assistant')) {
      const basis = await ask(h, 'Home Assistant verbinden', 'Adresse von Home Assistant (z. B. http://192.168.1.10:8123)', 'basis')
      if (!basis) return
      body = { connectorId, basis }
    }
    if (connectorId === 'dateien') {
      const ordner = await ask(h, 'Ordner freigeben', 'Vollständiger Pfad des Ordners (z. B. eine NAS-Freigabe)', 'ordner')
      if (!ordner) return
      body = { connectorId, ordner }
    }
    try {
      const result = await h.api.post(`${PATH}/verbinden`, body)
      local.cards[connectorId] = result.cardId
      h.toast(result.message || 'Karte erstellt.')
    } catch (error) { h.fail(error) }
    h.rerender()
  }

  async function connectDevice(h, id, weg) {
    try {
      const result = await h.api.post(`${PATH}/geraet/${encodeURIComponent(id)}/verbinden`, weg ? { weg } : {})
      local.cards[`geraet:${id}`] = result.cardId
      h.toast(result.message || 'Karte erstellt.')
    } catch (error) { h.fail(error) }
    h.rerender()
  }

  function ask(h, title, label, name, fields) {
    return new Promise(resolve => {
      const inputs = fields
        ? fields.map(field => `<label>${h.esc(field.label)}<input name="${h.attr(field.env)}" type="${field.geheim ? 'password' : 'text'}" autocomplete="off" maxlength="300" required></label>`).join('')
        : `<label>${h.esc(label)}<input name="${h.attr(name)}" type="text" autocomplete="off" maxlength="300" required></label>`
      h.showModal(title, `<form class="form" id="conn-ask">${inputs}<div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Weiter</button></div></form>`)
      const form = document.querySelector('#conn-ask')
      document.querySelectorAll('#modal-root [data-close-modal]').forEach(node => node.addEventListener('click', () => resolve(null)))
      form?.addEventListener('submit', event => {
        event.preventDefault()
        const values = Object.fromEntries(new FormData(form).entries())
        h.closeModal()
        resolve(fields ? values : String(values[name] || '').trim() || null)
      })
    })
  }

  async function answer(h, cardId, value) {
    local.busy.add(cardId); h.rerender()
    try {
      const result = await h.api.post(`/api/desktop/karten/${encodeURIComponent(cardId)}/antwort`, { answer: value })
      h.toast(result?.message || 'Antwort gespeichert.')
      for (const [key, id] of Object.entries(local.cards)) if (id === cardId) delete local.cards[key]
    } catch (error) { h.fail(error) }
    finally { local.busy.delete(cardId); await load(h, true) }
  }

  async function login(h, id) {
    try {
      const result = await h.api.post(`${PATH}/${encodeURIComponent(id)}/anmelden`, {})
      if (!result.url) { h.toast(result.message); return void load(h, true) }
      // https opens in the system browser; a local http login page (Home Assistant) is shown as a link.
      if (/^https:\/\//.test(result.url)) window.open(result.url, '_blank', 'noopener')
      h.showModal('Anmelden', `<p>Die Anmeldeseite des Dienstes ist geöffnet. Danach geht es automatisch weiter.</p><p class="section-note">Nicht geöffnet? Diese Adresse im Browser öffnen (15 Minuten gültig):</p><p class="mono">${h.esc(result.url)}</p><div class="toolbar"><button class="primary" data-close-modal>Fertig</button></div>`)
    } catch (error) { h.fail(error) }
  }

  async function access(h, id) {
    const item = (local.data?.verbunden || []).find(entry => entry.id === id)
    if (!item?.felder?.length) return
    const werte = await ask(h, `${item.title}: Zugang`, '', '', item.felder)
    if (!werte) return
    try { const result = await h.api.post(`${PATH}/${encodeURIComponent(id)}/zugang`, { werte }); h.toast(result.message) } catch (error) { h.fail(error) }
    await load(h, true)
  }

  function smartSection(h) {
    if (!smartDevices.length && !smartError) return ''
    return `<section class="section" aria-labelledby="smart-access"><div class="section-head"><h2 id="smart-access">Direkte Smart-Geräte</h2><span class="section-note">ohne Home Assistant · keine Schaltfreigabe</span></div>
      ${smartError ? `<div class="section-body">${h.esc(smartError)}</div>` : `<div class="rows">${smartDevices.map(d => `<div class="row"><div><div class="row-title">${h.esc(d.name)}</div>
      <div class="row-sub">${h.esc(d.id)} · ${d.route === 'local' ? 'lokaler lesender Zugang freigegeben' : d.route === 'cloud' ? 'Cloud-Weg freigegeben; kein lokaler Ersatzweg' : 'Zugriffsweg oder Verbindungsfreigabe noch offen'}</div>
      <div class="row-sub">${d.zustand === 'verbunden' ? 'Verbunden.' : d.zustand === 'wartet' ? `Wartet: ${h.esc(d.grund || '')}.` : 'Nicht verbunden.'} ${d.accessStored ? 'Zugang privat hinterlegt.' : 'Kein privater Gerätezugang hinterlegt.'}</div>
      ${!d.route ? `<div class="row-sub">Mit Nova wählen: /geraete weg ${h.esc(d.id)} lokal oder cloud; danach /geraete ja ${h.esc(d.id)}.</div>` : ''}</div>
      <div class="row-side">${d.route && d.fields?.length ? `<button class="secondary" data-smart-access="${h.attr(d.id)}">${d.accessStored ? 'Zugang ersetzen' : d.route === 'cloud' ? 'Cloud-Zugang eintragen' : 'Lokalen Zugang eintragen'}</button>` : ''}
      ${d.controls?.length ? `<button class="secondary" data-smart-control="${h.attr(d.id)}">Geräteaktion vorbereiten</button>` : ''}</div></div>`).join('')}</div>`}</section>`
  }

  function smartControl(h, id) {
    const d = smartDevices.find(d => d.id === id)
    if (!d?.controls?.length) return
    h.showModal('Konkrete Geräteaktion', `<form class="form" id="smart-control-form"><p>${h.esc(d.name)} · ${d.route === 'cloud' ? 'Hersteller-Cloud' : 'lokal'}. Eine physische Aktion, keine Dauerfreigabe.</p>
      <label>Bestätigte Funktion<select name="functionId" required><option value="">Bitte wählen</option>${d.controls.map(f => `<option value="${h.attr(f.id)}">${h.esc(f.name)} · ${h.esc(f.id)}</option>`).join('')}</select></label>
      <label>Zielzustand<select name="state" required><option value="">Bitte wählen</option><option value="on">Ein</option><option value="off">Aus</option></select></label>
      <div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Vorbereiten, noch nicht ausführen</button></div></form>`)
    document.querySelector('#smart-control-form')?.addEventListener('submit', async event => {
      event.preventDefault()
      const values = new FormData(event.currentTarget)
      h.closeModal()
      try {
        const proposal = await h.api.post(`${SMART}/${encodeURIComponent(id)}/aktion`, { functionId: String(values.get('functionId')), on: values.get('state') === 'on' })
        if (!proposal?.ok || !proposal.confirmationId) { h.toast(proposal?.message || 'Nicht vorbereitet.'); return }
        h.showModal('Physische Aktion einmalig bestätigen', `<p>${h.esc(proposal.message)}</p><p class="section-note">Bei unklarer Wirkung wird nicht erneut geschaltet. Diese Bestätigung verfällt nach zwei Minuten.</p><div class="toolbar"><button class="secondary" data-close-modal>Abbrechen</button><button class="primary" id="smart-control-confirm">Genau diese Aktion ausführen</button></div>`)
        document.querySelector('#smart-control-confirm')?.addEventListener('click', async () => {
          h.closeModal()
          try { const result = await h.api.post(`/api/desktop/smart-aktionen/${encodeURIComponent(proposal.confirmationId)}/bestaetigen`, { confirm: 'ja' }); h.toast(result.message) }
          catch { h.toast('Wirkung nicht bestätigt. Nicht automatisch wiederholen; Gerätezustand prüfen.') }
          await load(h, true)
        }, { once: true })
      } catch { h.toast('Geräteaktion konnte nicht vorbereitet werden. Nichts ausgeführt.') }
    })
  }

  function smartAccess(h, id) {
    const d = smartDevices.find(d => d.id === id)
    if (!d || !d.route || !d.fields?.length) return
    h.showModal(`${d.protocol === 'matter' ? 'Matter' : d.protocol === 'esphome' ? 'ESPHome' : d.protocol === 'shelly' ? 'Shelly' : 'Tuya'}: privater ${d.route === 'cloud' ? 'Cloud-' : 'lokaler '}Zugang`, `<form class="form" id="smart-access-form"><p class="section-note">${d.protocol === 'matter' ? 'Einmaliges Pairing dieses Geräts, danach nur lesende Abfragen. Bei bestehenden Fabrics zuerst das Multi-Admin-Fenster öffnen; kein Reset. Matter über Thread benötigt einen erreichbaren Border-Router. Zur Zertifikatsprüfung werden öffentliche Vertrauens- und Sperrlisten geladen; keine Gerätesecrets hochgeladen. Kein Schalten.' : `Nur dieses Gerät, nur lesend. ${d.route === 'cloud' ? 'Abfrage über den ausgewählten Hersteller; kein lokaler Ersatzweg. Kein Schalten.' : 'Kein Cloud-Abruf und kein Schalten.'}`} Den Schlüssel nicht im Chat teilen.</p>
      ${(d.fields || []).map(f => `<label>${h.esc(f.label)}${f.choices ? `<select name="${h.attr(f.name)}" required><option value="">Bitte wählen</option>${f.choices.map(v => `<option value="${h.attr(v)}">${h.esc(v)}</option>`).join('')}</select>` : `<input type="${f.secret === false ? 'text' : 'password'}" name="${h.attr(f.name)}" autocomplete="off" ${Number.isInteger(f.length) ? `minlength="${f.length}" maxlength="${f.length}"` : 'maxlength="512"'} required>`}</label>`).join('')}
      <div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">${d.protocol === 'matter' ? 'Einmaliges Pairing durchführen' : 'Privat speichern'}</button></div></form>`)
    document.querySelector('#smart-access-form')?.addEventListener('submit', async event => {
      event.preventDefault()
      const form = event.currentTarget, values = Object.fromEntries(new FormData(form).entries())
      form.reset(); h.closeModal()
      try { const result = await h.api.post(`${SMART}/${encodeURIComponent(id)}/zugang`, { fingerprint: d.fingerprint, values }); h.toast(result.message) }
      catch { h.toast('Privater Zugang konnte nicht gespeichert werden. Keine Verbindung bestätigt.') }
      finally { for (const key of Object.keys(values)) values[key] = ''; await load(h, true) }
    })
  }

  async function search(h, query) {
    local.query = query; local.searching = true; h.rerender()
    try {
      const result = await h.api.get(`${PATH}/verzeichnis?q=${encodeURIComponent(query)}`)
      local.results = result.eintraege || []
      // Icons: the Main fetches and checks them on first display.
      for (const item of local.results.filter(entry => entry.icon && !entry.iconData && !local.icons[entry.name]).slice(0, 12)) {
        h.api.get(`${PATH}/icon?name=${encodeURIComponent(item.name)}`).then(icon => { local.icons[item.name] = icon.dataUri; h.rerender() }).catch(() => undefined)
      }
    } catch (error) { h.fail(error) }
    finally { local.searching = false; h.rerender() }
  }

  // Paket C: der Key geht nur an den eigenen Anbieter zur Prüfung, wird sicher abgelegt und nie wieder angezeigt.
  async function llmKey(h, provider) {
    const item = (local.data?.moeglich?.gruppen || []).flatMap(group => group.eintraege).find(entry => entry.llm?.provider === provider)
    const where = item?.llm?.keyUrl ? `<p class="section-note">Key erstellen: <span class="mono">${h.esc(item.llm.keyUrl)}</span></p>` : ''
    h.showModal(`${item ? item.title : provider}: API-Key`, `<form class="form" id="conn-llm-key">${where}<label>API-Key (wird sofort geprüft, danach nie wieder angezeigt)<input name="key" type="password" autocomplete="off" maxlength="512" required></label>
      <div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Prüfen und verbinden</button></div></form>`)
    const form = document.querySelector('#conn-llm-key')
    form?.addEventListener('submit', async event => {
      event.preventDefault()
      const key = String(new FormData(form).get('key') || '')
      h.closeModal()
      try {
        const result = await h.api.post(`${LLM}/key`, { provider, key })
        h.toast(result?.ok ? `Verbunden${result.maske ? ` (Key ${result.maske})` : ''}.` : (result?.meldung || 'Nicht verbunden.'))
      } catch (error) { h.fail(error) }
      await load(h, true)
    })
  }

  async function llmLogin(h, provider) {
    try {
      const result = await h.api.post(`${LLM}/oauth/start`, { provider })
      if (!result?.url) { h.toast(result?.meldung || 'Anmeldung nicht möglich.'); return }
      if (/^https:\/\//.test(result.url)) window.open(result.url, '_blank', 'noopener')
      if (result.manuell && result.state) {
        const code = await ask(h, 'Anmelden', 'Den Code von der Anmeldeseite hier einfügen', 'code')
        if (!code) return
        const done = await h.api.post(`${LLM}/oauth/complete`, { state: result.state, code })
        h.toast(done?.ok ? 'Verbunden.' : (done?.meldung || 'Nicht verbunden.'))
        return void load(h, true)
      }
      h.showModal('Anmelden', `<p>Die Anmeldeseite des Anbieters ist geöffnet. Danach geht es automatisch weiter.</p>${result.code ? `<p class="section-note">Code für die Anmeldeseite:</p><p class="mono">${h.esc(result.code)}</p>` : ''}<p class="section-note">Nicht geöffnet? Diese Adresse im Browser öffnen:</p><p class="mono">${h.esc(result.url)}</p><div class="toolbar"><button class="primary" data-close-modal>Fertig</button></div>`)
    } catch (error) { h.fail(error) }
  }

  function mount(h) {
    const page = document.querySelector('#page')
    if (!page) return
    page.querySelector('[data-conn-refresh]')?.addEventListener('click', () => load(h, true))
    page.querySelectorAll('[data-conn-connect]').forEach(node => node.addEventListener('click', () => connect(h, node.dataset.connConnect)))
    page.querySelectorAll('[data-conn-device]').forEach(node => node.addEventListener('click', () => connectDevice(h, node.dataset.connDevice, node.dataset.connWeg)))
    page.querySelectorAll('[data-conn-card]').forEach(node => node.addEventListener('click', () => answer(h, node.dataset.connCard, node.dataset.connAnswer)))
    page.querySelectorAll('[data-conn-login]').forEach(node => node.addEventListener('click', () => login(h, node.dataset.connLogin)))
    page.querySelectorAll('[data-conn-access]').forEach(node => node.addEventListener('click', () => access(h, node.dataset.connAccess)))
    page.querySelectorAll('[data-smart-access]').forEach(node => node.addEventListener('click', () => smartAccess(h, node.dataset.smartAccess)))
    page.querySelectorAll('[data-smart-control]').forEach(node => node.addEventListener('click', () => smartControl(h, node.dataset.smartControl)))
    page.querySelectorAll('[data-conn-disconnect]').forEach(node => node.addEventListener('click', async () => {
      try { const result = await h.api.post(`${PATH}/${encodeURIComponent(node.dataset.connDisconnect)}/trennen`, {}); h.toast(result.message) } catch (error) { h.fail(error) }
      await load(h, true)
    }))
    page.querySelectorAll('[data-conn-llm-key]').forEach(node => node.addEventListener('click', () => llmKey(h, node.dataset.connLlmKey)))
    page.querySelectorAll('[data-conn-llm-login]').forEach(node => node.addEventListener('click', () => llmLogin(h, node.dataset.connLlmLogin)))
    page.querySelectorAll('[data-conn-llm-disconnect]').forEach(node => node.addEventListener('click', async () => {
      try { const result = await h.api.delete(`${LLM}/key/${encodeURIComponent(node.dataset.connLlmDisconnect)}`); h.toast(result?.removed ? 'Getrennt.' : 'Nichts zu trennen.') } catch (error) { h.fail(error) }
      await load(h, true)
    }))
    page.querySelector('[data-conn-search]')?.addEventListener('submit', event => {
      event.preventDefault()
      void search(h, String(new FormData(event.currentTarget).get('q') || '').trim())
    })
    page.querySelector('[data-conn-paste]')?.addEventListener('click', async () => {
      const adresse = await ask(h, 'Rückkehr-Adresse', 'Die Adresse, auf der die Anmeldung geendet hat', 'adresse')
      if (!adresse) return
      try { const result = await h.api.post(`${PATH}/rueckkehr`, { adresse }); h.toast(result.message) } catch (error) { h.fail(error) }
      await load(h, true)
    })
    window.XaventraTelefon?.mount(h)
    window.XaventraZugaenge?.mount(h)
    void load(h)
  }

  window.XaventraConnections = Object.freeze({ view, mount })
})()
