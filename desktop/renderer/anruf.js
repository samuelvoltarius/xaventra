// „Anrufen“ (2.86 Paket O): mit Xaventra sprechen, ohne Sprechtaste.
// Übernommen aus dem Voice-Lab (Codex, 03.10.): Freisprechen mit VAD auf dem
// Sprachdienst, Dazwischenreden unterbricht, Antwort phrasenweise.
// Die zwei offenen Live-Fixes sind hier eingebaut:
//  1. Knacken: EIN durchgehender Wiedergabe-Graph (ein AudioContext, ein
//     Haupt-Regler), Phrasen lückenlos hintereinander geplant, jede mit
//     15-ms-Ein-/Ausblendung; Abbrechen blendet in 15 ms aus statt hart zu stoppen.
//  2. „Hört mich die halbe Zeit nicht“: 16-kHz-Aufnahme in 32-ms-Rahmen
//     (anruf-worklet.js), Rauschunterdrückung des Browsers AUS (sie schluckte
//     leise Satzanfänge), Echo-Unterdrückung an; empfindlicheres VAD + Pre-Roll
//     macht der Sprachdienst.
// Das Mikrofon wird einmal freigegeben; danach bleibt der Anruf offen, bis du auflegst.
;(function () {
  'use strict'

  const FADE = 0.015
  const CAPTURE = Object.freeze({
    audio: Object.freeze({ channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: false, autoGainControl: true }),
    video: false,
  })

  /** Durchgehender Player: plant dekodierte Phrasen lückenlos, je 15 ms Rampe. */
  function createPlayer(ctx) {
    const master = ctx.createGain()
    master.gain.value = 1
    master.connect(ctx.destination)
    let sources = []
    let nextTime = 0
    let generation = 0
    return {
      get playing() { return sources.length > 0 },
      get endsAt() { return nextTime },
      async enqueue(bytes) {
        const mine = generation
        const buffer = await ctx.decodeAudioData(bytes)
        if (mine !== generation) return null
        const start = Math.max(ctx.currentTime + 0.03, nextTime)
        const edge = Math.min(FADE, buffer.duration / 4)
        const end = start + buffer.duration
        const source = ctx.createBufferSource()
        const gain = ctx.createGain()
        source.buffer = buffer
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(1, start + edge)
        gain.gain.setValueAtTime(1, Math.max(start + edge, end - edge))
        gain.gain.linearRampToValueAtTime(0, end)
        source.connect(gain).connect(master)
        source.onended = () => { sources = sources.filter(item => item.source !== source); try { gain.disconnect() } catch { /* schon getrennt */ } }
        source.start(start)
        sources.push({ source, gain })
        nextTime = end
        return { start, end }
      },
      stop() {
        generation += 1
        const now = ctx.currentTime
        master.gain.cancelScheduledValues(now)
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(0, now + FADE)
        for (const { source } of sources) { try { source.stop(now + FADE) } catch { /* schon beendet */ } }
        sources = []
        nextTime = 0
        master.gain.setValueAtTime(1, now + FADE + 0.005)
      },
    }
  }

  const state = { status: null, loading: false, call: null, transcript: '', answer: '', line: '', live: false, error: '' }

  function base64Bytes(data) {
    const raw = atob(data)
    const out = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
    return out.buffer
  }

  async function loadStatus(h) {
    if (state.loading) return
    state.loading = true
    try { state.status = await h.api.get('/api/desktop/sprache'); state.error = '' } catch (error) { state.error = String((error && error.message) || error) }
    finally { state.loading = false; h.rerender() }
  }

  function setLine(h, text, live = state.live) { state.line = text; state.live = live; h.rerender() }

  async function startCall(h) {
    if (state.call) return
    const web = window.novaDesktop && window.novaDesktop.web === true
    if (!web) return h.toast('Anrufen geht im Browser oder auf dem Handy (Web-App).', true)
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return h.toast('Für das Mikrofon braucht die Seite eine sichere Adresse (https über das Tailnet).', true)
    const call = { ws: null, capture: null, playback: null, player: null, stream: null, node: null, source: null, mute: null }
    state.call = call
    try {
      setLine(h, 'Verbinde …', true)
      call.stream = await navigator.mediaDevices.getUserMedia(CAPTURE)
      call.playback = new AudioContext({ latencyHint: 'interactive' })
      call.player = createPlayer(call.playback)
      try { call.capture = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }) } catch { call.capture = new AudioContext({ latencyHint: 'interactive' }) }
      await Promise.all([call.capture.resume(), call.playback.resume()])
      await call.capture.audioWorklet.addModule('anruf-worklet.js')
      const issued = await h.api.post('/api/desktop/sprache/anruf', {})
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = call.ws = new WebSocket(`${scheme}://${location.host}${issued.pfad}?ticket=${encodeURIComponent(issued.ticket)}`)
      ws.binaryType = 'arraybuffer'
      ws.onmessage = event => handleEvent(h, call, event.data)
      ws.onclose = () => { if (state.call === call) stopCall(h, state.line && !state.live ? state.line : 'Aufgelegt.') }
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Verbindung fehlgeschlagen')) })
      call.source = call.capture.createMediaStreamSource(call.stream)
      call.node = new AudioWorkletNode(call.capture, 'xaventra-pcm16')
      call.mute = call.capture.createGain()
      call.mute.gain.value = 0
      call.node.port.onmessage = message => { if (ws.readyState === 1) ws.send(message.data) }
      call.source.connect(call.node).connect(call.mute).connect(call.capture.destination)
      setLine(h, 'Ich höre zu – sprich einfach los.', true)
    } catch (error) {
      stopCall(h, error && error.name === 'NotAllowedError' ? 'Ohne Mikrofon-Freigabe kann ich dich nicht hören.' : `Anruf ging nicht: ${(error && error.message) || error}`)
    }
  }

  function stopCall(h, line = 'Aufgelegt.') {
    const call = state.call
    state.call = null
    if (call) {
      try { if (call.ws && call.ws.readyState === 1) call.ws.send(JSON.stringify({ type: 'stop' })) } catch { /* zu */ }
      try { if (call.ws) call.ws.close() } catch { /* zu */ }
      try { if (call.player) call.player.stop() } catch { /* leer */ }
      try { if (call.node) call.node.disconnect(); if (call.source) call.source.disconnect(); if (call.mute) call.mute.disconnect() } catch { /* getrennt */ }
      if (call.stream) call.stream.getTracks().forEach(track => track.stop())
      void Promise.allSettled([call.capture && call.capture.close(), call.playback && call.playback.close()])
    }
    setLine(h, line, false)
  }

  function handleEvent(h, call, raw) {
    let event
    try { event = JSON.parse(String(raw)) } catch { return }
    if (event.type === 'speech_start') { if (call.player) call.player.stop(); state.transcript = '…'; setLine(h, 'Du sprichst …', true) }
    else if (event.type === 'partial') { state.transcript = event.text; h.rerender() }
    else if (event.type === 'final') { state.transcript = event.text; state.answer = ''; setLine(h, 'Ich denke nach …', true) }
    else if (event.type === 'answer') { state.answer = event.text; h.rerender() }
    else if (event.type === 'audio') { if (call.player) void call.player.enqueue(base64Bytes(event.data)).catch(() => undefined); setLine(h, 'Ich spreche – du kannst mich jederzeit unterbrechen.', true) }
    else if (event.type === 'cancelled') { if (call.player) call.player.stop(); setLine(h, 'Unterbrochen – ich höre dir zu.', true) }
    else if (event.type === 'done') setLine(h, 'Ich höre weiter zu.', true)
    else if (event.type === 'notice') { setLine(h, event.text, Boolean(state.call)); if (event.setup) void loadStatus(h) }
  }

  async function setPref(h, change) {
    try {
      const result = await h.api.patch('/api/desktop/sprache', change)
      state.status = Object.assign({}, state.status || {}, { einstellung: result.einstellung })
      h.rerender()
    } catch (error) { h.fail(error) }
    if (change.voice && state.call && state.call.ws && state.call.ws.readyState === 1) state.call.ws.send(JSON.stringify({ type: 'voice', voice: change.voice }))
  }

  async function setup(h, katalogId) {
    try {
      const result = await h.api.post('/api/desktop/werkzeugkasten/installieren', { katalogId })
      h.toast((result && result.message) || 'Karte angelegt – ein „Ja“ genügt.', result && result.ok === false)
    } catch (error) { h.fail(error) }
  }

  function view(h) {
    if (!state.status && !state.loading && !state.error) void loadStatus(h)
    const s = state.status
    const head = `<header class="page-head"><div><div class="eyebrow">Sprache</div><h1>Mit mir sprechen</h1><p>${h.esc((s && s.text) || 'Einmal das Mikrofon erlauben, dann einfach reden – ganz ohne Taste.')}</p></div></header>`
    if (state.error && !s) return `<div class="page"><div class="page-inner">${head}<div class="empty-note">${h.esc(state.error)}</div></div></div>`
    if (!s) return `<div class="page"><div class="page-inner">${head}<div class="empty-note">Ich schaue nach, ob der Sprachdienst läuft …</div></div></div>`
    const found = Boolean(s.dienst && s.dienst.gefunden === true)
    const prefs = s.einstellung || {}
    const active = Boolean(state.call)
    const callBlock = found
      ? `<section class="call-card${active ? ' active' : ''}" aria-label="Anruf">
          <button class="call-button ${active ? 'hangup' : 'primary'}" data-anruf="${active ? 'stop' : 'start'}" aria-pressed="${active}">${h.icon(active ? 'x' : 'phone')}${active ? 'Auflegen' : 'Anrufen'}</button>
          <p class="call-line" role="status" aria-live="polite"><span class="pulse ${state.live ? 'busy' : ''}"></span>${h.esc(state.line || `Der Sprachdienst läuft auf ${s.dienst.knoten}.`)}</p>
          ${state.transcript ? `<div class="call-bubble you"><span class="eyebrow">Du</span><p>${h.esc(state.transcript)}</p></div>` : ''}
          ${state.answer ? `<div class="call-bubble me"><span class="eyebrow">Xaventra</span><p>${h.esc(state.answer)}</p></div>` : ''}
          <p class="section-note">Tipp: Mit Kopfhörern hört sie dich beim Dazwischenreden besser.</p>
        </section>`
      : `<section class="call-card"><p>${h.esc(s.text)}</p>${s.knopf ? `<button class="primary" data-anruf-setup="${h.attr(s.knopf.katalogId)}">${h.icon('wrench', 'sm')}${h.esc(s.knopf.text)}</button>` : ''}</section>`
    const settings = `<section class="section" aria-label="Einstellungen Sprache"><div class="section-head"><h2>So antworte ich</h2></div><div class="section-body call-settings">
        <label class="switch-row"><input type="checkbox" data-anruf-pref="replyByVoice" ${prefs.replyByVoice ? 'checked' : ''}> In Telegram auf Sprachnachrichten auch mit Sprache antworten</label>
        <label>Stimme <select data-anruf-pref="voice"><option value="female" ${prefs.voice !== 'male' ? 'selected' : ''}>Ramona (weiblich)</option><option value="male" ${prefs.voice === 'male' ? 'selected' : ''}>Thorsten (männlich)</option></select></label>
        <p class="section-note">Du kannst auch einfach sagen: „Antworte ab jetzt per Sprache“ oder „Antworte wieder per Text“.</p>
      </div></section>`
    return `<div class="page"><div class="page-inner">${head}${callBlock}${settings}</div></div>`
  }

  function bind(h) {
    const on = (selector, type, fn) => { const node = document.querySelector(selector); if (node) node.addEventListener(type, fn) }
    on('[data-anruf="start"]', 'click', () => void startCall(h))
    on('[data-anruf="stop"]', 'click', () => stopCall(h))
    on('[data-anruf-setup]', 'click', event => void setup(h, event.currentTarget.dataset.anrufSetup))
    on('[data-anruf-pref="replyByVoice"]', 'change', event => void setPref(h, { replyByVoice: event.target.checked }))
    on('[data-anruf-pref="voice"]', 'change', event => void setPref(h, { voice: event.target.value }))
  }

  window.XaventraAnruf = Object.freeze({ view, bind, createPlayer, CAPTURE, handleEvent, _state: state })
})()
