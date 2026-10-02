// Werkzeugkasten (2.85 Paket D): welche Programme Xaventra stärker machen
// würden – wie ein kleiner App-Store. Die Seite liest /api/desktop/werkzeugkasten.
// „Installieren“ und „Entfernen“ legen nur einen Vorschlag an und zeigen die
// vorhandene Knopf-Karte; erst das „Ja“ auf der Karte installiert (signiertes
// Ticket, mit Rückweg). Es gibt hier keine zweite Freigabe-Logik.
;(function () {
  'use strict'

  const STATUS = {
    laeuft: ['good', 'läuft'],
    installiert: ['good', 'installiert'],
    abgedeckt: ['', 'schon abgedeckt'],
    passt: ['info', 'passt'],
    'passt-nicht': ['', 'passt nicht'],
  }
  const FRESH = { aktuell: 'good', nachfolger: 'warn', ungeprueft: '' }
  // Karten, die diese Seite gerade angeboten hat (Schlüssel: Katalog-ID oder Warteschlangen-ID).
  const offered = new Map()
  const busy = new Set()

  function size(mb) {
    if (!mb) return ''
    return mb >= 1000 ? `${(mb / 1000).toLocaleString('de-AT', { maximumFractionDigits: 1 })} GB` : `${mb} MB`
  }

  function offeredCard(h, card) {
    if (!card) return ''
    const answers = ['ja', 'nein'].filter(answer => (card.antworten || []).includes(answer))
    const waiting = busy.has(card.id)
    return `<div class="ask-card tool-ask" aria-label="${h.attr(card.titel)}">
      <header><div><h3>${h.esc(card.titel)}</h3>${card.vorschlag ? `<p class="proposal">${h.esc(card.vorschlag)}</p>` : ''}</div></header>
      ${answers.length ? `<div class="answer-row" role="group" aria-label="Antwort">${answers.map(answer => `<button class="${answer === 'ja' ? 'primary' : 'secondary'}" data-wk-answer="${answer}" data-wk-card="${h.attr(card.id)}" ${waiting ? 'disabled' : ''}>${h.icon(answer === 'ja' ? 'check' : 'x', 'sm')}${answer === 'ja' ? 'Ja' : 'Nein'}</button>`).join('')}</div>`
        : '<p class="section-note">Diese Karte ist schon beantwortet.</p>'}
      <p class="section-note">Die Karte steht auch unter „Heute“ und in Telegram.</p>
    </div>`
  }

  function entryTile(h, item) {
    const [tone, label] = STATUS[item.status] || ['', item.status]
    const key = item.knopf?.art === 'entfernen' ? item.knopf.queueId : item.katalogId
    const card = key ? offered.get(key) : null
    const working = key && busy.has(key)
    let button = ''
    if (item.knopf?.art === 'installieren') {
      button = `<button class="primary" data-wk-install="${h.attr(item.knopf.katalogId)}" ${working ? 'disabled' : ''}>${h.icon('plus', 'sm')}Installieren</button>`
    } else if (item.knopf?.art === 'entfernen') {
      button = `<button class="secondary" data-wk-remove="${h.attr(item.knopf.queueId)}" ${working ? 'disabled' : ''}>${h.icon('x', 'sm')}Entfernen</button>`
    }
    const fresh = item.aktualitaet?.status && item.aktualitaet.status !== 'kein-modell'
      ? `<span class="pill ${FRESH[item.aktualitaet.status] || ''}" title="${h.attr(item.aktualitaet.text)}">${h.esc(item.aktualitaet.status === 'aktuell' ? 'aktuell' : item.aktualitaet.status === 'nachfolger' ? 'es gibt Neueres' : 'Aktualität ungeprüft')}</span>` : ''
    return `<article class="tile tool-tile${item.empfohlen ? ' recommended' : ''}" aria-label="${h.attr(item.name)}">
      <div class="tool-head"><h3>${h.esc(item.name)}</h3><span class="pill ${tone}">${h.esc(label)}</span></div>
      <p class="tool-benefit">${h.esc(item.nutzen)}</p>
      <div class="tool-meta">
        ${item.empfohlen ? `<span class="pill warn">${h.icon('bulb', 'sm')}empfohlen, weil gebraucht</span>` : ''}
        ${fresh}
        <span>${h.esc(item.statusText)}</span>
        ${item.groesseMb ? `<span>${h.esc(size(item.groesseMb))}</span>` : ''}
      </div>
      ${item.hinweis ? `<p class="section-note">${h.esc(item.hinweis)}</p>` : ''}
      <details><summary>Mehr dazu</summary><p>${h.esc(item.detail)}</p>${item.bedarf?.length ? `<p>Gebraucht, weil: ${h.esc(item.bedarf.join(' · '))}</p>` : ''}${item.aktualitaet?.text ? `<p>${h.esc(item.aktualitaet.text)}</p>` : ''}</details>
      ${button ? `<div class="toolbar">${button}</div>` : ''}
      ${offeredCard(h, card)}
    </article>`
  }

  function view(h) {
    const { data, error } = h.viewState('werkzeugkasten')
    const head = h.pageHead('Werkzeugkasten', 'Programme, die mir weiterhelfen',
      'Was ich mit einem Knopf dazulernen kann. Installiert wird erst nach deinem „Ja“ auf der Karte – und alles lässt sich wieder entfernen.', 'werkzeugkasten')
    if (error && !data) return `${head}${h.viewErrorBlock(error)}`
    if (!data) return `${head}${h.skeletonSection('Werkzeuge')}${h.skeletonSection('Werkzeuge')}`
    const all = (data.gruppen || []).flatMap(group => group.eintraege || [])
    const recommended = all.filter(item => item.empfohlen).length
    const installable = all.filter(item => item.knopf?.art === 'installieren').length
    const summary = `<div class="tool-summary"><span class="count-chip"><strong>${installable}</strong>mit einem Knopf</span>${recommended ? `<span class="count-chip"><strong>${recommended}</strong>empfohlen</span>` : ''}<span class="count-chip"><strong>${all.filter(item => item.status === 'laeuft' || item.status === 'installiert').length}</strong>schon da</span></div>`
    const groups = (data.gruppen || []).map(group => `<section class="section" aria-label="${h.attr(group.titel)}">
      <div class="section-head"><h2>${h.esc(group.titel)}</h2></div>
      <div class="section-body"><div class="tiles">${(group.eintraege || []).map(item => entryTile(h, item)).join('')}</div></div>
    </section>`).join('')
    const nodes = (data.knoten || []).map(node => `${node.id}${node.bewertet ? '' : ' (veraltet)'}`).join(', ')
    return `${head}${summary}${h.problemsNote(data.probleme)}${groups || '<div class="empty-note">Keine Werkzeuge im Katalog.</div>'}
      <p class="section-note">${h.esc(data.hinweis || '')}${nodes ? ` Bewertete Rechner: ${h.esc(nodes)}.` : ''}</p>`
  }

  async function act(h, key, path, body) {
    busy.add(key)
    h.render()
    try {
      const result = await h.api.post(path, body)
      if (result?.karte) offered.set(key, result.karte)
      h.toast(result?.message || 'Gemacht.', result?.ok === false)
    } catch (error) { h.fail(error) }
    finally {
      busy.delete(key)
      await h.ensureView('werkzeugkasten', { force: true })
      void h.ensureView('heute', { force: true })
      h.render()
    }
  }

  async function answer(h, cardId, value) {
    busy.add(cardId)
    h.render()
    try {
      const result = await h.api.post(`/api/desktop/karten/${encodeURIComponent(cardId)}/antwort`, { answer: value })
      h.toast(result?.message || 'Antwort gespeichert.')
      for (const [key, card] of offered) if (card.id === cardId) offered.delete(key)
    } catch (error) { h.fail(error) }
    finally {
      busy.delete(cardId)
      await h.ensureView('werkzeugkasten', { force: true })
      void h.ensureView('heute', { force: true })
      h.render()
    }
  }

  function bind(h) {
    document.querySelectorAll('[data-wk-install]').forEach(node => node.addEventListener('click', () => {
      const id = node.dataset.wkInstall
      void act(h, id, '/api/desktop/werkzeugkasten/installieren', { katalogId: id })
    }))
    document.querySelectorAll('[data-wk-remove]').forEach(node => node.addEventListener('click', () => {
      const id = node.dataset.wkRemove
      void act(h, id, '/api/desktop/werkzeugkasten/entfernen', { queueId: id })
    }))
    document.querySelectorAll('[data-wk-answer]').forEach(node => node.addEventListener('click', () => answer(h, node.dataset.wkCard, node.dataset.wkAnswer)))
  }

  window.Werkzeugkasten = { view, bind }
})()
