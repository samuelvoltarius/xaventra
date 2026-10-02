// Erster Start (2.85 Paket B): Ansicht „Willkommen“ der gemeinsamen Oberfläche.
// Zeigt, was Xaventra beim Einrichten selbst getan hat, und stellt höchstens
// drei Fragen: Name, Telegram koppeln (Link/QR statt Token tippen), gefundene
// Dienste verbinden (nur Verweis auf die Ansicht „Verbindungen“ aus Paket A).
// Eigene Datei; app.js liefert nur die Hilfsfunktionen (ctx) und die Navigation.
;(() => {
  const API = '/api/desktop/onboarding'
  const local = { data: null, error: null, loading: false, pair: null, skipped: new Set(), timer: null, at: 0 }

  // Die lokale Desktop-App übernimmt bei einer frischen Installation einmal das
  // Owner-Token (nur der Hauptprozess sieht es). Im Browser gibt es das nicht.
  async function tryClaim(error, connection) {
    const claim = window.novaDesktop?.onboarding?.claim
    if (!claim || connection?.hasToken || !/authentication required|token required|owner/i.test(String(error?.message || error || ''))) return false
    try { return (await claim())?.claimed === true } catch { return false }
  }

  async function load(ctx, force = false) {
    if (local.loading || (!force && local.data && Date.now() - local.at < 4000)) return
    local.loading = true
    const before = JSON.stringify([local.data, local.error])
    try {
      local.data = await ctx.api.get(API)
      local.error = null
    } catch (error) { local.error = String(error?.message || error) }
    finally { local.loading = false; local.at = Date.now() }
    // Never replace the page while something is being typed into it.
    const typing = document.activeElement?.closest?.('[data-onboarding-form]')
    if (ctx.isActive() && !typing && JSON.stringify([local.data, local.error]) !== before) ctx.rerender()
  }

  function schedule(ctx) {
    clearTimeout(local.timer)
    const data = local.data
    // Während der Doctor läuft oder ein Kopplungscode offen ist, still nachsehen.
    if (data && (data.doctor?.running || data.telegram?.pairingPending || (!data.doctor?.report && data.firstStart))) {
      local.timer = setTimeout(() => { if (ctx.isActive()) void load(ctx, true) }, 4000)
    }
  }

  const STATUS = {
    ok: ['good', 'In Ordnung'], getan: ['good', 'Erledigt'], vorgeschlagen: ['warn', 'Vorschlag'],
    'braucht-dich': ['warn', 'Braucht dich'], gescheitert: ['bad', 'Verfolge ich'],
  }

  function reportSection(ctx, data) {
    const { esc, icon } = ctx
    const doctor = data.doctor || {}
    const items = doctor.report?.items || []
    const body = doctor.running || (!doctor.report && data.firstStart)
      ? `<div class="section-body" aria-busy="true"><div class="empty-note">${icon('clock')}<span>Ich prüfe gerade diesen Rechner, suche ein lokales Modell und richte mich ein …</span></div><div class="skeleton"></div><div class="skeleton"></div></div>`
      : items.length
        ? `<div class="section-body flush">${items.map(item => {
          const [tone, label] = STATUS[item.status] || ['', item.status]
          return `<div class="row"><div><div class="row-title">${esc(item.text)}</div>${item.proposalId ? '<div class="row-sub">Die Karte dazu liegt unter „Heute“.</div>' : ''}</div><div class="row-side"><span class="badge ${tone}">${esc(label)}</span></div></div>`
        }).join('')}</div>`
        : `<div class="section-body"><div class="empty-note">${icon('check')}<span>Noch kein Bericht.</span></div></div>`
    const needsCard = items.some(item => item.proposalId)
    return `<section class="section"><div class="section-head"><h2>${icon('wrench')}Was ich getan habe</h2><div class="row-side">${needsCard ? '<button class="secondary" data-section="heute">Zur Karte</button>' : ''}<button class="secondary" data-onboarding="doctor" ${doctor.running ? 'disabled' : ''}>${icon('refresh', 'sm')}Nochmal prüfen</button></div></div>${body}</section>`
  }

  function nameQuestion(ctx, data) {
    const { esc, attr, icon } = ctx
    if (data.ownerName) return question(ctx, 1, 'Wie heißt du?', `<div class="empty-note">${icon('check')}<span>Hallo ${esc(data.ownerName)}.</span></div>`, true)
    return question(ctx, 1, 'Wie heißt du?', `<form class="form" data-onboarding-form="name"><label>Dein Name<input name="name" maxlength="60" autocomplete="given-name" required value="${attr('')}"></label><div class="toolbar"><button class="primary" type="submit">Speichern</button></div></form>`, false)
  }

  function telegramQuestion(ctx, data) {
    const { esc, attr, icon } = ctx
    const tg = data.telegram || {}
    if (tg.paired) return question(ctx, 2, 'Telegram koppeln', `<div class="empty-note">${icon('check')}<span>Gekoppelt${tg.pairedWith && tg.pairedWith !== 'verbunden' ? ` mit ${esc(tg.pairedWith)}` : ''}. Du kannst mir dort schreiben.</span></div>`, true)
    if (local.skipped.has('telegram')) return question(ctx, 2, 'Telegram koppeln', '<div class="empty-note"><span>Übersprungen. Geht später unter „Mehr“ → „Erster Start“.</span></div>', true)
    let body
    if (!tg.configured && !tg.botUsername) {
      body = `<p>Mit Telegram erreichst du mich auch unterwegs. Dafür braucht es einen eigenen Bot:</p>
        <ol class="onboarding-steps"><li>Öffne <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> in Telegram.</li><li>Schicke <b>/newbot</b> und wähle einen Namen.</li><li>Kopiere das Token, das BotFather schickt, und füge es hier ein.</li></ol>
        <form class="form" data-onboarding-form="telegram-token"><label>Bot-Token<input name="token" type="password" autocomplete="off" spellcheck="false" required placeholder="Einfügen"></label><p>Ich prüfe es bei Telegram und speichere es nur auf diesem Rechner. Angezeigt wird es nie wieder.</p><div class="toolbar"><button class="primary" type="submit">Prüfen und speichern</button><button class="secondary" type="button" data-onboarding="skip-telegram">Später</button></div></form>`
    } else {
      const pair = local.pair
      const restart = tg.restartNeeded ? `<div class="empty-note">${icon('alert')}<span>Bot ${esc(tg.botUsername ? '@' + tg.botUsername : '')} ist gespeichert. Telegram startet beim nächsten Start von Xaventra; der Kopplungscode gilt 10 Minuten.</span></div>` : ''
      body = pair && pair.expiresAt && Date.parse(pair.expiresAt) > Date.now()
        ? `${restart}<div class="onboarding-pair">${pair.qr ? `<img src="${attr(pair.qr)}" alt="QR-Code zum Koppeln mit Telegram" width="200" height="200">` : ''}<div><p>Scanne den Code mit dem Handy oder öffne den Link. Telegram schickt dann „Start“ an deinen Bot, und ich weiß, dass du es bist.</p><p><a href="${attr(pair.link)}" target="_blank" rel="noreferrer">In Telegram öffnen</a></p><p class="section-note">Gültig bis ${esc(new Date(pair.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }))}, nur einmal.</p></div></div>`
        : `${restart}<p>Ein Knopf, dann zeige ich dir einen QR-Code. Kein Tippen von IDs.</p><div class="toolbar"><button class="primary" data-onboarding="pair">${icon('send', 'sm')}Koppeln</button><button class="secondary" data-onboarding="skip-telegram">Später</button></div>`
    }
    return question(ctx, 2, 'Telegram koppeln', body, false)
  }

  function connectionsQuestion(ctx, data) {
    const { esc, icon } = ctx
    const c = data.connections || {}
    if (!c.available) return question(ctx, 3, 'Gefundene Dienste verbinden', '<div class="empty-note"><span>Die Ansicht „Verbindungen“ ist gerade nicht erreichbar. Hier muss nichts getan werden.</span></div>', true)
    const text = c.gefunden
      ? `Ich habe ${c.gefunden} Dienst${c.gefunden === 1 ? '' : 'e'} gefunden: ${esc(c.beispiele.join(', '))}. Verbinden geht mit einem Knopf.`
      : 'Ich habe nichts gefunden, was sich verbinden lässt. In „Verbindungen“ siehst du, was möglich ist.'
    return question(ctx, 3, 'Gefundene Dienste verbinden', `<p>${text}</p><div class="toolbar"><button class="${c.gefunden ? 'primary' : 'secondary'}" data-section="${esc(c.view || 'verbindungen')}">${icon('plusCircle', 'sm')}Zu den Verbindungen</button></div>`, !c.gefunden)
  }

  function question(ctx, number, title, body, done) {
    return `<section class="section"><div class="section-head"><h2><span class="badge ${done ? 'good' : ''}">${done ? ctx.icon('check', 'sm') : number}</span>${ctx.esc(title)}</h2></div><div class="section-body">${body}</div></section>`
  }

  function page(ctx) {
    void load(ctx)
    const data = local.data
    const head = `<header class="page-head"><div><div class="eyebrow">Erster Start</div><h1>Willkommen bei Xaventra</h1><p>Ich richte mich selbst ein und sage dir, was ich getan habe. Danach höchstens drei Fragen; alles lässt sich auch später erledigen.</p></div></header>`
    if (!data) {
      const body = local.error
        ? `<section class="section"><div class="section-body"><div class="empty-note">${ctx.icon('alert')}<span>${ctx.esc(ctx.errorText(local.error))}</span></div></div></section>`
        : '<section class="section"><div class="section-body" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div></section>'
      return `${head}<div class="stack">${body}</div>`
    }
    if (data.state === null) return `${head}<div class="stack"><section class="section"><div class="section-body"><div class="empty-note">${ctx.icon('check')}<span>Diese Installation wurde ohne den Ersten Start eingerichtet. Hier gibt es nichts zu tun.</span></div></div></section></div>`
    const finish = data.firstStart
      ? `<div class="toolbar"><button class="primary" data-onboarding="done">${ctx.icon('check', 'sm')}Fertig</button></div>`
      : `<div class="empty-note">${ctx.icon('check')}<span>Die Einrichtung ist abgeschlossen.</span></div>`
    return `${head}<div class="stack">${reportSection(ctx, data)}${nameQuestion(ctx, data)}${telegramQuestion(ctx, data)}${connectionsQuestion(ctx, data)}${finish}</div>`
  }

  function bind(ctx) {
    schedule(ctx)
    const root = document.querySelector('#page')
    if (!root) return
    const busy = async (button, work) => {
      if (button) button.disabled = true
      try { await work() } catch (error) { ctx.fail(error) } finally { if (button) button.disabled = false }
    }
    root.querySelectorAll('[data-onboarding]').forEach(button => button.addEventListener('click', () => busy(button, async () => {
      const action = button.dataset.onboarding
      if (action === 'doctor') { await ctx.api.post(`${API}/doctor`, {}); ctx.toast('Ich prüfe noch einmal.'); await load(ctx, true) }
      if (action === 'pair') { local.pair = await ctx.api.post(`${API}/telegram/pair`, {}); await load(ctx, true); ctx.rerender() }
      if (action === 'skip-telegram') { local.skipped.add('telegram'); ctx.rerender() }
      if (action === 'done') { await ctx.api.post(`${API}/done`, {}); local.data = null; ctx.toast('Fertig. Ich bin bereit.'); ctx.navigate('heute') }
    })))
    root.querySelectorAll('[data-onboarding-form]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const kind = form.dataset.onboardingForm
      const values = new FormData(form)
      void busy(form.querySelector('button[type=submit]'), async () => {
        if (kind === 'name') await ctx.api.post(`${API}/name`, { name: String(values.get('name') || '') })
        if (kind === 'telegram-token') {
          const saved = await ctx.api.post(`${API}/telegram/token`, { token: String(values.get('token') || '') })
          form.reset()
          ctx.toast(`Bot @${saved.botUsername} gespeichert.`)
        }
        await load(ctx, true)
      })
    }))
  }

  window.XaventraOnboarding = Object.freeze({ page, bind, tryClaim })
})()
