const api = window.novaDesktop.api

const state = {
  section: 'chat',
  bootstrap: null,
  roomId: null,
  messages: [],
  selectedBots: new Set(),
  selectedNodes: new Set(),
  busy: false,
  busySince: 0,
  pendingMessage: null,
  busyTimer: null,
  connection: null,
  controlPolling: false,
  expertPanel: false,
  chatViews: new Map(),
  busyRoomId: null,
  connectionAttempt: 0,
  roomSelection: 0,
  roomLoading: null,
}

const nav = [
  ['chat', 'Arbeitsraum', '✦'], ['bots', 'Spezialisten', 'S'], ['nodes', 'Xaventra Nodes', 'X'],
  ['modules', 'Studio', 'S'], ['security', 'Defense', 'D'], ['trust', 'Evidence', 'T'], ['memory', 'Gedächtnis', 'M'],
]

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function attr(value) { return esc(value).replace(/`/g, '&#96;') }
function inlineMarkdown(value) {
  const parts = String(value ?? '').split(/(`[^`\n]+`)/g)
  return parts.map(part => {
    if (part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`
    let safe = esc(part)
    safe = safe.replace(/\[([^\]]{1,160})\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    safe = safe.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    safe = safe.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1<em>$2</em>')
    return safe
  }).join('')
}

function formatMessage(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let list = null
  let code = false
  let codeLines = []
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null } }
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList()
      if (code) { out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`); codeLines = [] }
      code = !code
      continue
    }
    if (code) { codeLines.push(line); continue }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/)
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (unordered || ordered) {
      const wanted = unordered ? 'ul' : 'ol'
      if (list !== wanted) { closeList(); list = wanted; out.push(`<${wanted}>`) }
      out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`)
      continue
    }
    closeList()
    if (!line.trim()) { out.push('<span class="paragraph-gap"></span>'); continue }
    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/)
    if (heading) { const level = Math.min(4, heading[1].length + 2); out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue }
    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) { out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); continue }
    out.push(`<p>${inlineMarkdown(line)}</p>`)
  }
  closeList()
  if (codeLines.length) out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`)
  return out.join('')
}
function fmtTime(value) {
  if (!value) return ''
  try { return new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(value)) } catch { return '' }
}
function fmtNumber(value, digits = 0) { return Number(value || 0).toLocaleString('de-AT', { maximumFractionDigits: digits }) }
function selectRoomDefaults(room) {
  const primary = room?.botIds?.includes('nova') ? 'nova' : room?.botIds?.[0]
  state.selectedBots = new Set(primary ? [primary] : [])
  state.selectedNodes = new Set()
  state.expertPanel = false
}
function botById(id) { return state.bootstrap?.bots?.find(bot => bot.id === id) }
function roomById(id = state.roomId) { return state.bootstrap?.rooms?.find(room => room.id === id) }
function currentRoom() { return roomById() }
function workspaceById(id) { return state.connection?.workspaces?.find(workspace => workspace.id === id) }
function modelRouteId(model) { return model?.routeId || `${model?.nodeId || 'local'}::${model?.runtime || model?.provider || 'local'}::${model?.id || 'unknown'}` }
function modelByRoute(routeId) { return state.bootstrap?.models?.models?.find(model => modelRouteId(model) === routeId) }
function chatModels() {
  const seen = new Set()
  return (state.bootstrap?.models?.models || []).filter(model => {
    if (/embed|nomic|bge|mxbai|voice|whisper|tts/i.test(String(model.id || ''))) return false
    const route = modelRouteId(model)
    if (seen.has(route)) return false
    seen.add(route)
    return true
  })
}
function routeForRoom(room = currentRoom()) {
  if (!room || room.modelMode !== 'pinned') return null
  return modelByRoute(room.pinnedRouteId) || state.bootstrap?.models?.models?.find(model => model.id === room.pinnedModel) || null
}
function modelLabel(model, compact = false) {
  if (!model) return 'Unbekannte Route'
  const speed = model.tokensPerSecond ? `${fmtNumber(model.tokensPerSecond, 1)} tok/s` : null
  const tools = model.toolSamples > 0 ? `${fmtNumber(model.toolSuccessRate * 100, 0)}% Tools` : model.supportsTools ? 'Tool-Schema ✓' : null
  return compact
    ? `${model.id} · ${model.nodeId}`
    : [model.id, model.runtime || model.provider, model.nodeId, speed, tools].filter(Boolean).join(' · ')
}

let toastTimer
function toast(message, error = false) {
  const node = document.querySelector('#toast')
  node.textContent = String(message)
  node.className = `toast show${error ? ' error' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.className = 'toast' }, 3600)
}

function fail(error) {
  console.error(error)
  toast(error?.message || String(error), true)
}

async function loadBootstrap(isCurrent = () => true) {
  const bootstrap = await api.get('/api/desktop/bootstrap')
  if (!isCurrent()) return false
  state.bootstrap = bootstrap

  // NovaOS-Bedienmodus auf das Wurzelelement legen. Das Aussehen steuert
  // dann CSS (html.novaos-standard blendet Technisches aus), statt jede
  // Stelle einzeln zu verzweigen. Eine Quelle: /etc/novaos/modus.
  const novaos = state.bootstrap?.novaos
  if (novaos?.istNovaOS) {
    const wurzel = document.documentElement
    wurzel.classList.toggle('novaos-standard', novaos.modus !== 'experte')
    wurzel.classList.toggle('novaos-experte', novaos.modus === 'experte')
    wurzel.classList.add('novaos')
  }

  if (state.bootstrap.controlPlane && state.bootstrap.controlPlane.authoritative !== true) {
    throw new Error('Der konfigurierte Endpunkt ist kein aktuell gefenctes Xaventra-Main-Control-Plane.')
  }
  if (!state.roomId || !roomById(state.roomId)) state.roomId = state.bootstrap.rooms?.[0]?.id || null

  // Im Normalmodus darf niemand vor einem leeren Formular stehen. Gibt es
  // noch keinen Raum, legen wir stillschweigend einen an — der Mensch sieht
  // sofort ein Chatfeld und tippt los. Im Expertenmodus bleibt die bewusste
  // Raumanlage erhalten.
  if (!state.roomId && document.documentElement.classList.contains('novaos-standard')) {
    try {
      const raum = await api.post('/api/desktop/rooms', {
        title: 'Xaventra', topic: '', botIds: ['nova'],
        preferredNodeIds: [], modelMode: 'auto'
      })
      state.bootstrap = await api.get('/api/desktop/bootstrap')
      state.roomId = raum?.id || state.bootstrap.rooms?.[0]?.id || null
    } catch { /* Kein Raum? Dann bleibt der Knopf — besser als ein Absturz. */ }
  }
  const room = currentRoom()
  selectRoomDefaults(room)
  const messages = room ? (await api.get(`/api/desktop/rooms/${encodeURIComponent(room.id)}/messages`)).messages || [] : []
  if (!isCurrent()) return false
  state.messages = messages
  return true
}

async function init() {
  const attempt = ++state.connectionAttempt
  const isCurrent = () => attempt === state.connectionAttempt
  renderConnectionError('Verbindung zum konfigurierten Main wird geprüft.', true)
  try { state.connection = await window.novaDesktop.config.get() }
  catch (error) { if (isCurrent()) renderConnectionError(error); return }
  // Bounded retries for a Core that is starting alongside Desktop. Settings
  // stay reachable throughout, and an older attempt cannot replace that form.
  for (let retry = 0; retry < 5 && isCurrent(); retry++) {
    try {
      if (!await loadBootstrap(isCurrent) || !isCurrent()) return
      render()
      startControlPolling()
      return
    } catch (error) {
      if (!isCurrent()) return
      renderConnectionError(error, retry < 4)
      if (retry === 4) return
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

function shell(main, inspector = '') {
  const rooms = state.bootstrap?.rooms || []
  const classes = ['shell', state.connection?.showInspector === false ? 'inspector-hidden' : '', state.connection?.compactMode ? 'compact' : ''].filter(Boolean).join(' ')
  return `<div class="${classes}">
    <nav class="rail" aria-label="Hauptnavigation">
      <div class="brand-mark" title="Xaventra Desktop"><span>X</span><i></i></div><div class="brand-name">XAVENTRA</div>
      ${nav.map(([id, label, short]) => `<button class="rail-button ${state.section === id ? 'active' : ''}" data-section="${id}" title="${label}"><span class="nav-glyph">${short}</span><span class="nav-label">${label}</span></button>`).join('')}
      <div class="rail-spacer"></div>
      <div class="rail-status" title="Control Plane verbunden"><span class="status-dot online"></span><small>LIVE</small></div>
      <button class="rail-button ${state.section === 'settings' ? 'active' : ''}" data-section="settings" title="Einstellungen"><span class="nav-glyph">⚙</span><span class="nav-label">Setup</span></button>
    </nav>
    <aside class="sidebar">
      <div class="panel-head"><div><div class="eyebrow">Workspace</div><h1>Themen & Aufgaben</h1></div><button class="icon-button" data-action="new-room" title="Neuer Themenraum">+</button></div>
      <div class="room-list">
        ${rooms.length ? rooms.map(room => `<button class="room ${room.id === state.roomId ? 'active' : ''}" data-room="${attr(room.id)}"><span class="room-kicker">${room.workspaceId ? 'PROJECT' : 'TOPIC'}</span><span class="room-title">${esc(room.title)}</span><span class="room-meta"><span>${room.botIds.length} Spezialist${room.botIds.length === 1 ? '' : 'en'}</span><span>${room.memoryAssetIds?.length || 0} Assets</span></span></button>`).join('') : '<div class="empty small"><p>Noch kein Themenraum.</p></div>'}
      </div>
    </aside>
    <main class="workspace">${main}</main>
    <aside class="inspector"><div class="panel-head"><div><div class="eyebrow">Live Context</div><h2>Kontrollzentrum</h2></div><span class="badge good">verified</span></div><div class="inspector-content">${inspector || inspectorView()}</div></aside>
  </div>`
}

function rememberChatView() {
  const composer = document.querySelector('#composer')
  const box = document.querySelector('.messages')
  if (!composer || !box) return
  const previous = state.chatViews.get(composer.dataset.roomId)
  state.chatViews.set(composer.dataset.roomId, {
    draft: composer.value,
    scrollTop: box.dataset.loading === 'true' ? previous?.scrollTop || 0 : box.scrollTop,
    atBottom: box.dataset.loading === 'true' ? previous?.atBottom !== false : box.scrollHeight - box.clientHeight - box.scrollTop < 40,
  })
}

function render() {
  rememberChatView()
  const app = document.querySelector('#app')
  if (!state.bootstrap) return
  if (state.section === 'chat') app.innerHTML = shell(chatView())
  else if (state.section === 'bots') app.innerHTML = shell(botsView())
  else if (state.section === 'nodes') app.innerHTML = shell(nodesView())
  else if (state.section === 'modules') app.innerHTML = shell(modulesView())
  else if (state.section === 'security') app.innerHTML = shell(securityView())
  else if (state.section === 'trust') { app.innerHTML = shell(loadingView('Outcome Ledger wird geladen')); void loadTrust() }
  else if (state.section === 'memory') { app.innerHTML = shell(loadingView('Governed Memory wird geladen')); void loadMemory() }
  else app.innerHTML = shell(settingsView())
  bind()
  if (state.section === 'chat') {
    const roomId = state.roomId
    const view = state.chatViews.get(roomId)
    const composer = document.querySelector('#composer')
    if (composer) composer.value = view?.draft || ''
    requestAnimationFrame(() => {
      if (state.section !== 'chat' || state.roomId !== roomId) return
      const box = document.querySelector('.messages')
      if (box) box.scrollTop = view?.atBottom === false ? view.scrollTop : box.scrollHeight
    })
  }
}

function topbar(room) {
  const catalog = state.bootstrap.models || { models: [] }
  const routes = chatModels()
  const control = state.bootstrap.controlPlane || {}
  const selected = room?.modelMode === 'pinned' ? (room.pinnedRouteId || modelRouteId(routeForRoom(room)) || '') : 'auto'
  const active = routes.find(model => model.id === catalog.activeModel && model.status === 'running')
  return `<header class="topbar">
    <div class="room-heading"><h1>${esc(room?.title || 'Xaventra Desktop')}</h1><p>${esc(room?.topic || (document.documentElement.classList.contains('novaos-standard')
        ? 'Ich bin da. Frag mich einfach.'
        : 'Ein Arbeitsraum mit Xaventra, gezielten Spezialisten und verifizierten Tools.'))}</p></div>
    <div class="main-presence"><span class="status-dot online"></span><span>${esc(control.hostname || control.nodeId || 'Main')}</span><small>MAIN</small></div>
    ${room ? `<select class="model-select" id="model-picker" aria-label="Modellwahl">
      <option value="auto" ${selected === 'auto' ? 'selected' : ''}>Auto · ${esc(active ? modelLabel(active, true) : 'Outcome Router')}</option>
      ${routes.map(model => `<option value="${attr(modelRouteId(model))}" ${selected === modelRouteId(model) ? 'selected' : ''}>${esc(modelLabel(model))}</option>`).join('')}
    </select>` : ''}
  </header>`
}

function chatView() {
  const room = currentRoom()
  if (!room) return `${topbar(null)}<div class="empty"><div class="empty-mark">X</div><div class="eyebrow">Dein Xaventra Workspace</div><h2>Von der Frage bis zum verifizierten Ergebnis</h2><p>Ein Themenraum hält Kontext, Modelle, Spezialisten, Nodes, Tool-Evidence und Memory zusammen.</p><div class="toolbar" style="justify-content:center"><button class="primary" data-action="new-room">Ersten Raum erstellen</button></div></div>`
  const bots = room.botIds.map(botById).filter(Boolean)
  const nodeIds = room.preferredNodeIds || []
  const workspace = workspaceById(room.workspaceId)
  const pendingMessage = state.busyRoomId === room.id ? state.pendingMessage : null
  return `${topbar(room)}
    <div class="workspace-context-bar"><div><span class="context-icon">⌘</span><span class="context-label">Projekt</span><strong>${esc(workspace?.name || 'Kein lokaler Ordner verbunden')}</strong>${workspace?.path ? `<small>${esc(workspace.path)}</small>` : ''}</div><div class="workspace-actions">${(state.connection?.workspaces || []).length ? `<select id="workspace-picker" aria-label="Projektordner"><option value="">Ohne Workspace</option>${state.connection.workspaces.map(item => `<option value="${attr(item.id)}" ${room.workspaceId === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : ''}<button class="secondary" id="select-workspace">${workspace ? 'Anderen Ordner' : 'Ordner verbinden'}</button></div></div>
    <section class="messages" data-loading="${state.roomLoading === room.id}" aria-live="polite">
      ${state.messages.length || pendingMessage ? state.messages.map(messageView).join('') : `<div class="empty"><div class="empty-mark">${esc(bots[0]?.avatar || 'N')}</div><div class="eyebrow">Bereit auf ${esc(state.bootstrap.controlPlane?.hostname || 'Nova Main')}</div><h2>${esc(room.title)}</h2><p>${esc(room.topic || 'Sag Nova in normaler Sprache, was erreicht werden soll. Sie entscheidet selbst, ob Memory, Modell oder Tools nötig sind.')}</p><div class="prompt-grid"><button data-prompt="Ich will ins Internet">Ins Internet</button><button data-prompt="Zeig mir meine Fotos">Meine Fotos</button><button data-prompt="Was kannst du alles?">Was kannst du?</button></div></div>`}
      ${pendingMessage ? messageView(pendingMessage) : ''}
      ${state.busy && state.busyRoomId === room.id ? pendingReplyView() : ''}
    </section>
    <footer class="composer ${state.busy ? 'loading' : ''}">
      <div class="selection-row" aria-label="Aktive Spezialisten">
        ${bots.filter(bot => state.selectedBots.has(bot.id)).map(bot => `<span class="chip active">${esc(bot.name)}</span>`).join('')}
        <button class="chip" data-action="toggle-experts">${state.expertPanel ? 'Auswahl schließen' : '+ Spezialist'}</button>
        <span class="routing-note">${state.selectedNodes.size ? `${state.selectedNodes.size} Node${state.selectedNodes.size === 1 ? '' : 's'} festgelegt` : 'Node automatisch'}</span>
      </div>
      ${state.expertPanel ? `<div class="selection-row expert-picker"><span class="context-label">Spezialisten für diese Nachricht</span>${bots.map(bot => `<button class="chip ${state.selectedBots.has(bot.id) ? 'active' : ''}" data-toggle-bot="${attr(bot.id)}">${esc(bot.name)}${bot.source !== 'nova' ? ` · ${esc(bot.source)}` : ''}</button>`).join('')}<span class="context-label">Ausführender Nova-Node (optional)</span>${nodeIds.map(id => { const node = (state.bootstrap.inventory?.nodes || []).find(item => item.id === id || item.nodeId === id); return `<button class="chip ${state.selectedNodes.has(id) ? 'active' : ''}" data-toggle-node="${attr(id)}">${esc(node?.name || node?.displayName || id)}</button>` }).join('') || '<span class="routing-note">Auto-Routing über alle gesunden Nova-Nodes.</span>'}</div>` : ''}
      <form class="compose-box" id="compose-form"><textarea id="composer" data-room-id="${attr(room.id)}" placeholder="${document.documentElement.classList.contains('novaos-standard') ? 'Schreib hier, was du brauchst …' : 'Beschreibe das Ziel – Xaventra plant, nutzt Tools und belegt das Ergebnis.'}" aria-label="Nachricht" ${state.busy || state.roomLoading ? 'disabled' : ''}></textarea><button class="send-button" type="submit" title="Senden" ${state.busy || state.roomLoading ? 'disabled' : ''}>${state.busy ? '···' : '↑'}</button></form>
      <div class="compose-context"><span>${state.connection?.sendOnEnter === false ? 'Enter neue Zeile · Pfeil senden' : 'Enter senden · Shift+Enter neue Zeile'}</span><span>${esc(workspace?.name || 'kein Projekt')}</span><span>${room.memoryAssetIds?.length || 0} Memory Assets</span><span>${esc(routeForRoom()?.nodeId || 'Auto-Routing')}</span></div>
    </footer>`
}

function pendingReplyView() {
  const seconds = Math.max(0, Math.floor((Date.now() - state.busySince) / 1000))
  const stage = pendingStage(seconds)
  return `<article class="message pending"><div class="avatar">X</div><div class="message-body"><div class="message-head"><span>Xaventra</span><span class="origin">in Arbeit</span><time data-busy-seconds>${seconds}s</time></div><div class="message-content" data-busy-stage>${esc(stage)}</div><div class="progress-line"><span></span></div></div></article>`
}

function pendingStage(seconds) {
  return seconds < 4 ? 'Nachricht wird an den Main gesendet.' : seconds < 15 ? 'Antwort vom Main steht noch aus.' : 'Die Anfrage läuft noch. Es liegt noch kein Ergebnis vor.'
}

function updateBusyProgress() {
  if (!state.busy) return
  const seconds = Math.max(0, Math.floor((Date.now() - state.busySince) / 1000))
  const time = document.querySelector('[data-busy-seconds]')
  const stage = document.querySelector('[data-busy-stage]')
  if (time) time.textContent = `${seconds}s`
  if (stage) stage.textContent = pendingStage(seconds)
}

function messageView(message) {
  const bot = botById(message.authorId)
  const isUser = message.authorType === 'user'
  const label = isUser ? 'Du' : bot?.name || (message.authorType === 'system' ? 'System' : message.authorId)
  const origin = bot?.source && bot.source !== 'nova' ? bot.source : message.node
  const evidence = message.evidence
  const actionLabel = evidence?.action?.awaitingApproval ? 'Freigabe nötig' : evidence?.action?.fulfilled ? 'Ergebnis verifiziert' : message.verifiedEvidence > 0 ? 'Evidence geprüft' : ''
  return `<article class="message ${isUser ? 'user' : ''}">
    <div class="avatar" style="${bot ? `border-color:${attr(bot.color)}` : ''}">${esc(isUser ? 'A' : bot?.avatar || '!')}</div>
    <div class="message-body"><div class="message-head"><span>${esc(label)}</span>${origin ? `<span class="origin">${esc(origin)}</span>` : ''}${message.model ? `<span class="origin">${esc(message.model)}</span>` : ''}<time>${fmtTime(message.createdAt)}</time></div><div class="message-content">${formatMessage(message.content)}</div>${!isUser && (message.runId || evidence) ? `<div class="evidence-strip"><span class="evidence-state ${message.verifiedEvidence > 0 ? 'verified' : ''}">${esc(actionLabel || 'Keine Tool-Evidence nötig')}</span>${evidence?.tools?.map(tool => `<span class="tool-pill ${tool.success ? 'ok' : 'failed'}">${tool.success ? '✓' : '×'} ${esc(tool.name)}</span>`).join('') || ''}${evidence?.durationMs ? `<span>${fmtNumber(evidence.durationMs / 1000, 1)}s</span>` : ''}${message.runId ? `<button class="run-link" data-run-id="${attr(message.runId)}">Run ansehen</button>` : ''}</div>` : ''}</div>
  </article>`
}

function inspectorView() {
  const room = currentRoom()
  const models = state.bootstrap?.models
  const inventory = state.bootstrap?.inventory
  const online = (inventory?.nodes || []).filter(node => ['online', 'active'].includes(String(node.status || node.lifecycle))).length
  const red = state.bootstrap?.security?.redTeam
  const control = state.bootstrap?.controlPlane || {}
  const recent = [...(state.messages || [])].reverse().find(message => message.authorType === 'bot' && message.evidence)
  const pinned = routeForRoom(room)
  return `<div class="metric-grid">
    <div class="metric"><strong>${online}</strong><span>aktive Nodes</span></div>
    <div class="metric"><strong>${room?.botIds?.length || 0}</strong><span>Spezialisten</span></div>
    <div class="metric"><strong>${fmtNumber((models?.autoRouter?.cells || []).reduce((sum, cell) => sum + Number(cell.samples || 0), 0))}</strong><span>Router-Samples</span></div>
    <div class="metric"><strong>${red?.score ?? '—'}</strong><span>Self-Test Score</span></div>
  </div>
  <div class="card"><div class="eyebrow">Main Control Plane</div><h3>${esc(control.hostname || control.nodeId || 'Nova Main')}</h3><p>${control.authoritative ? `Fencing aktiv · Main-Epoche ${esc(control.mainEpoch || '—')} · Dashboard-Epoche ${esc(control.dashboardEpoch || '—')}` : 'Main-Identität wird beim nächsten Update bestätigt.'}</p></div>
  <div class="card"><div class="eyebrow">Aktive Modellroute</div><h3>${esc(pinned ? modelLabel(pinned, true) : `Auto · ${models?.activeModel || 'Router'}`)}</h3><p>${pinned ? `${esc(pinned.runtime || pinned.provider)} · ${pinned.toolSamples > 0 ? `${fmtNumber(pinned.toolSuccessRate * 100, 0)} % erfolgreiche Tools aus ${fmtNumber(pinned.toolSamples)} Runs` : pinned.supportsTools ? 'Tool-Schema getestet · Produktionssamples fehlen noch' : 'keine Tool-Probe'} · ${pinned.tokensPerSecond ? `${fmtNumber(pinned.tokensPerSecond, 1)} tok/s` : 'Tempo noch nicht gemessen'}` : 'Auto schaltet erst nach validierten Produktions-Outcomes.'}</p></div>
  <div class="card"><div class="eyebrow">Letzter Arbeitslauf</div><h3>${recent?.verifiedEvidence ? `${recent.verifiedEvidence} verifizierte Ergebnisse` : 'Noch keine Tool-Evidence'}</h3><p>${recent?.evidence?.tools?.length ? recent.evidence.tools.map(tool => `${tool.success ? '✓' : '×'} ${tool.name}`).join(' · ') : 'Wenn Nova ein Tool ausführt, erscheinen Tool, Ergebnisstatus und Run-ID direkt an der Antwort.'}</p>${recent?.runId ? `<button class="secondary run-card-link" data-run-id="${attr(recent.runId)}">Vollständigen Run öffnen</button>` : ''}</div>
  <div class="card"><div class="eyebrow">Arbeitsprinzip</div><h3>Verstehen → ausführen → belegen</h3><p>Eine Modellantwort allein gilt nie als erledigte Aktion. Änderungen, Tools und Freigaben bleiben sichtbar.</p></div>`
}

function botsView() {
  const bots = state.bootstrap.bots || []
  return `<div class="view"><div class="view-header"><div><div class="eyebrow">Specialist Registry</div><h1>Spezialisten und Rollen</h1><p>Aufgabenbezogene Nova-Profile sowie kontrolliert angebundene Hermes- und OpenClaw-Spezialisten. Sie sind keine eigenständigen Nova-Nodes.</p></div><button class="primary" data-action="add-external">Spezialist hinzufügen</button></div>
    <div class="grid">${bots.map(bot => `<article class="bot-card"><div class="card-title"><div class="avatar" style="border-color:${attr(bot.color)}">${esc(bot.avatar)}</div><div><h2>${esc(bot.name)}</h2><span class="badge ${bot.source === 'nova' ? 'good' : 'warn'}">${esc(bot.source)}</span></div></div><p style="margin-top:12px;color:var(--muted);font-size:12px;line-height:1.5">${esc(bot.description)}</p><dl class="details"><dt>Bereich</dt><dd>${esc(bot.specialization)}</dd><dt>Autonomie</dt><dd>${esc(bot.autonomy)}</dd><dt>Modell</dt><dd>${esc(bot.modelPolicy?.mode || 'auto')}</dd><dt>Nodes</dt><dd>${esc(bot.preferredNodeIds?.join(', ') || 'Router')}</dd></dl></article>`).join('')}</div>
  </div>`
}

function nodesView() {
  const inventory = state.bootstrap.inventory || { nodes: [], enrollments: [] }
  return `<div class="view"><div class="view-header"><div><div class="eyebrow">Xaventra Agent Mesh</div><h1>Xaventra-Instanzen inventarisieren und aufnehmen</h1><p>Jeder Xaventra-Agent läuft auf einem echten Gerät. Worker sind standardmäßig weder Main-fähig noch Telegram-berechtigt; die Aufnahme benötigt einen verifizierten SSH-Fingerprint.</p></div><button class="primary" data-action="add-node">Xaventra-Agent aufnehmen</button></div>
    <div class="grid">${(inventory.nodes || []).map(node => `<article class="node-card"><div class="card-title"><span class="status-dot ${['online','active'].includes(String(node.status || node.lifecycle)) ? 'online' : ''}"></span><div><h2>${esc(node.name || node.id)}</h2><span class="badge ${['online','active'].includes(String(node.status || node.lifecycle)) ? 'good' : 'bad'}">${esc(node.lifecycle || node.status)}</span></div></div><dl class="details"><dt>ID</dt><dd class="mono">${esc(node.id)}</dd><dt>Host</dt><dd>${esc(node.host || '—')}</dd><dt>Version</dt><dd>${esc(node.version || '—')}</dd><dt>Tools</dt><dd>${fmtNumber(node.tools)}</dd><dt>Runtimes</dt><dd>${esc((node.runtimes || []).map(r => `${r.type}:${r.status}`).join(', ') || '—')}</dd><dt>Main</dt><dd>${node.mainEligible ? 'geeignet' : 'gesperrt'}</dd></dl></article>`).join('')}</div>
    ${(inventory.enrollments || []).length ? `<h2 style="margin:28px 0 12px">Offene Aufnahmen</h2><div class="grid">${inventory.enrollments.map(enrollmentCard).join('')}</div>` : ''}
  </div>`
}

function modulesView() {
  const modules = state.bootstrap.modules || []
  const forge = state.bootstrap.forge || []
  return `<div class="view"><div class="view-header"><div><div class="eyebrow">Xaventra Studio · governed capabilities</div><h1>Voice, Vision, CAD, Automation und Skill Forge</h1><p>Bewährte Ideen aus ADA Local, ADA v2 und Ada-SI als Xaventra-native Module – mit einem Execution Kernel, einem Memory und überprüfbarer Evidence.</p></div></div>
    <div class="grid">${modules.map(module => `<article class="bot-card"><div class="card-title"><div class="avatar">${esc(module.category.slice(0, 1).toUpperCase())}</div><div><h2>${esc(module.name)}</h2><span class="badge ${module.status === 'ready' ? 'good' : module.status === 'partial' ? 'warn' : 'bad'}">${esc(module.status)}</span></div></div><p style="margin-top:12px;color:var(--muted);font-size:12px;line-height:1.5">${esc(module.description)}</p><dl class="details"><dt>Inspiration</dt><dd>${esc(module.inspiration || 'Nova')}</dd><dt>Bereit</dt><dd>${esc(module.availableTools?.join(', ') || '—')}</dd><dt>Fehlt</dt><dd>${esc(module.missingTools?.join(', ') || 'nichts')}</dd></dl>${module.limitation ? `<div class="card" style="margin-top:12px;margin-bottom:0"><p>${esc(module.limitation)}</p></div>` : ''}<div class="toolbar"><button class="primary" data-launch-module="${attr(module.id)}">Arbeitsraum öffnen</button></div></article>`).join('')}</div>
    <div class="view-header" style="margin-top:32px"><div><div class="eyebrow">Ada-SI pattern · hardened</div><h1>Skill Forge</h1><p>Entwürfe bleiben inert, bis Sandbox, Benchmark, Canary und Owner-Freigabe vollständig belegt sind.</p></div></div>
    <div class="grid">${forge.map(forgeCard).join('') || '<div class="card"><h3>Noch keine Skill-Entwürfe</h3><p>Nova legt fehlende Fähigkeiten hier als prüfbare Vorschläge ab.</p></div>'}</div>
  </div>`
}

function forgeCard(item) {
  const canDecide = item.status === 'proposed'
  return `<article class="run-card"><div class="card-title"><div><h2>${esc(item.name)}</h2><span class="badge ${item.status === 'active' ? 'good' : item.status === 'rejected' || item.status === 'degraded' ? 'bad' : 'warn'}">${esc(item.status)}</span></div></div><p style="margin-top:12px;color:var(--muted);line-height:1.5">${esc(item.description)}</p><dl class="details"><dt>Hash</dt><dd class="mono">${esc(String(item.codeHash || '').slice(0, 18))}…</dd><dt>Owner</dt><dd>${esc(item.ownerId)}</dd><dt>Dependencies</dt><dd>${esc(item.dependencies?.join(', ') || 'keine')}</dd><dt>Evidence</dt><dd>${item.evidence?.length || 0}</dd><dt>Erstellt</dt><dd>${fmtTime(item.createdAt)}</dd></dl>${item.activationBlockedReason ? `<div class="card" style="margin-top:12px;margin-bottom:0"><p>${esc(item.activationBlockedReason)}</p></div>` : ''}${canDecide ? `<div class="toolbar"><button class="primary" data-forge-action="authorize-sandbox" data-id="${attr(item.id)}">Sandbox freigeben</button><button class="danger-button" data-forge-action="reject" data-id="${attr(item.id)}">Ablehnen</button></div>` : ''}</article>`
}

function enrollmentCard(entry) {
  return `<article class="node-card"><div class="card-title"><div><h2>${esc(entry.displayName)}</h2><span class="badge warn">${esc(entry.status)}</span></div></div><dl class="details"><dt>Node</dt><dd>${esc(entry.nodeId)}</dd><dt>Ziel</dt><dd>${esc(entry.sshUser)}@${esc(entry.host)}:${entry.sshPort}</dd><dt>Rolle</dt><dd>${esc(entry.role)}</dd><dt>Runtime</dt><dd>${esc(entry.runtime)}</dd></dl><div class="toolbar">${entry.status === 'draft' ? `<button class="primary" data-enrollment-action="approve" data-id="${attr(entry.id)}">Freigeben</button>` : ''}${entry.status === 'approved' ? `<button class="primary" data-enrollment-action="ready" data-id="${attr(entry.id)}">Aufnahme vorbereiten</button>` : ''}${!['cancelled','verified'].includes(entry.status) ? `<button class="danger-button" data-enrollment-action="cancel" data-id="${attr(entry.id)}">Abbrechen</button>` : ''}</div></article>`
}

function securityView() {
  const security = state.bootstrap.security || {}
  const red = security.redTeam
  return `<div class="view"><div class="view-header"><div><div class="eyebrow">Defense Workspace</div><h1>Blue Team und Red Team Lab</h1><p>Defensive Incident-Arbeit mit Evidence Chain; offensive Simulation ausschließlich gegen Novas eigene Guards.</p></div><button class="primary" data-action="run-red-team">Nova Self-Test starten</button></div>
    <div class="metric-grid" style="max-width:560px;margin-bottom:20px"><div class="metric"><strong>${security.blueTeamIncidents?.length || 0}</strong><span>Blue-Team Incidents</span></div><div class="metric"><strong>${red?.score ?? '—'}</strong><span>Red-Team Score</span></div><div class="metric"><strong>${red?.vectorsTested || 0}</strong><span>lokale Vektoren</span></div><div class="metric"><strong>${red?.bypasses?.filter(item => item.bypassed).length || 0}</strong><span>Bypasses</span></div></div>
    <div class="grid">${(security.blueTeamIncidents || []).map(incident => `<article class="bot-card"><div class="card-title"><div><h2>${esc(incident.title)}</h2><span class="badge ${incident.status === 'closed' ? 'good' : 'warn'}">${esc(incident.status)}</span></div></div><dl class="details"><dt>Severity</dt><dd>${esc(incident.severity)}</dd><dt>Scope</dt><dd>${esc(incident.scope)}</dd><dt>Evidence</dt><dd>${incident.evidence?.length || 0}</dd><dt>Aktualisiert</dt><dd>${fmtTime(incident.updatedAt)}</dd></dl></article>`).join('') || '<div class="card"><h3>Keine offenen Incidents</h3><p>Blue Team wartet auf defensive Evidence oder einen Incident-Auftrag.</p></div>'}</div>
  </div>`
}

function loadingView(label) { return `<div class="view"><div class="empty"><div class="empty-mark">N</div><p>${esc(label)} …</p></div></div>` }

async function loadTrust() {
  try {
    const data = await api.get('/api/desktop/trust/runs?limit=100')
    if (state.section !== 'trust') return
    document.querySelector('.workspace').innerHTML = `<div class="view"><div class="view-header"><div><div class="eyebrow">Outcome Ledger</div><h1>Trust und Tool-Evidence</h1><p>Keine Selbsteinschätzung: Status, Tools, Tests, Kosten und Validator-Ergebnis stammen aus der kanonischen Ergebnisakte.</p></div></div><div class="metric-grid" style="max-width:700px;margin-bottom:20px">${Object.entries(data.summary || {}).map(([key, value]) => `<div class="metric"><strong>${fmtNumber(value)}</strong><span>${esc(key)}</span></div>`).join('')}</div><div class="grid">${(data.runs || []).map(run => `<article class="run-card"><div class="card-title"><div><h2>${esc(run.contract?.goal || run.runId)}</h2><span class="badge ${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${esc(run.status)}</span></div></div><dl class="details"><dt>Run</dt><dd class="mono">${esc(run.runId)}</dd><dt>Model</dt><dd>${esc(run.model || '—')}</dd><dt>Node</dt><dd>${esc(run.node || '—')}</dd><dt>Tools</dt><dd>${run.tools?.length || 0}</dd><dt>Tests</dt><dd>${run.tests?.length || 0}</dd><dt>Validiert</dt><dd>${run.validation?.success ? 'ja' : 'nein'}</dd><dt>Kosten</dt><dd>$${Number(run.totalCostUsd || 0).toFixed(6)}</dd></dl></article>`).join('') || '<div class="card"><h3>Noch keine Runs für diesen Benutzer</h3></div>'}</div></div>`
  } catch (error) { fail(error) }
}

async function loadMemory() {
  try {
    const [data, catalog] = await Promise.all([api.get('/api/desktop/memory?limit=200'), api.get('/api/desktop/memory-assets')])
    if (state.section !== 'memory') return
    state.bootstrap.memoryAssets = catalog
    const room = currentRoom()
    const equipped = new Set(room?.memoryAssetIds || [])
    document.querySelector('.workspace').innerHTML = `<div class="view"><div class="view-header"><div><div class="eyebrow">Memory Asset Catalog</div><h1>Wissen gezielt ausrüsten</h1><p>Chat Memory, Skills, Wiki und CodeGraph werden nicht pauschal injiziert, sondern passend an User, Agent oder Themenraum gebunden.</p></div><button class="primary" data-action="new-memory-asset">Asset erstellen</button></div>
      <div class="metric-grid summary-metrics"><div class="metric"><strong>${catalog.assets?.length || 0}</strong><span>Memory Assets</span></div><div class="metric"><strong>${catalog.bindings?.filter(item => item.enabled).length || 0}</strong><span>aktive Loadouts</span></div><div class="metric"><strong>${data.stats?.canonical || 0}</strong><span>kanonische Fakten</span></div><div class="metric"><strong>${room?.memoryAssetIds?.length || 0}</strong><span>im aktuellen Raum</span></div></div>
      <div class="section-heading"><div><div class="eyebrow">Loadout · ${esc(room?.title || 'kein Raum')}</div><h2>Wiederverwendbare Assets</h2></div></div>
      <div class="grid asset-grid">${(catalog.assets || []).map(asset => `<article class="run-card asset-card ${equipped.has(asset.id) ? 'equipped' : ''}"><div class="asset-icon">${asset.kind === 'chat-memory' ? 'C' : asset.kind === 'skill' ? 'S' : asset.kind === 'wiki' ? 'W' : 'G'}</div><div class="card-title"><div><h2>${esc(asset.name)}</h2><div class="badge-row"><span class="badge ${asset.status === 'active' ? 'good' : 'warn'}">${esc(asset.status)}</span><span class="badge">${esc(asset.kind)}</span><span class="badge">v${asset.version}</span></div></div></div><p>${esc(asset.description || asset.content || 'Noch keine Beschreibung')}</p><dl class="details"><dt>Sichtbarkeit</dt><dd>${esc(asset.visibility)}</dd><dt>Quelle</dt><dd>${esc(asset.source)}</dd><dt>Aktualisiert</dt><dd>${fmtTime(asset.updatedAt)}</dd></dl>${room ? `<button class="${equipped.has(asset.id) ? 'secondary' : 'primary'} full-button" data-memory-equip="${attr(asset.id)}" data-equipped="${equipped.has(asset.id)}">${equipped.has(asset.id) ? 'Aus Raum entfernen' : 'Diesem Raum zuweisen'}</button>` : ''}</article>`).join('') || '<div class="empty-state"><h3>Noch keine Memory Assets</h3><p>Erstelle ein kuratiertes Asset, statt alle Rohdaten in jeden Prompt zu laden.</p></div>'}</div>
      <div class="section-heading"><div><div class="eyebrow">Canonical facts · ${esc(data.scope)}</div><h2>Verifizierte Quellen</h2></div><span class="badge">${data.records?.length || 0} Einträge</span></div>
      <div class="fact-list">${(data.records || []).slice(0, 50).map(record => `<article><span class="fact-kind">${esc(record.kind)}</span><div><p>${esc(record.content)}</p><small>${esc(record.status)} · ${Math.round(Number(record.confidence || 0) * 100)}% · ${esc(record.provenance?.at(-1)?.source || '—')}</small></div></article>`).join('') || '<div class="empty-state"><p>Noch keine verifizierten Erinnerungen in diesem Scope.</p></div>'}</div></div>`
    bind()
  } catch (error) { fail(error) }
}

function settingsView() {
  const connection = state.connection || {}
  const control = state.bootstrap?.controlPlane || {}
  return `<div class="view settings-view"><div class="view-header"><div><div class="eyebrow">Einstellungen</div><h1>Xaventra Desktop kontrolliert konfigurieren</h1><p>Verbindung, Chat-Verhalten, Layout und Sicherheitsgrenzen sind getrennt und nachvollziehbar.</p></div></div>
    <form class="form settings-grid" id="settings-form">
      <section class="card settings-card"><div class="eyebrow">01 · Verbindung & Identität</div><h2>Main Control Plane</h2><label>Nova-Main Endpoint<input name="endpoint" value="${attr(connection.endpoint || 'http://127.0.0.1:3011')}" required></label><label>Benutzer-Prinzipal<input name="principal" value="${attr(connection.principal || 'desktop-owner')}" required></label><label>Desktop API-Token<input name="token" type="password" placeholder="${connection.hasToken ? 'Gespeichert – leer lassen zum Behalten' : 'Optional bei lokalem SSH-Tunnel'}"></label><p>${connection.encryptionAvailable ? 'Tokens werden mit der OS-Credential-Verschlüsselung gespeichert.' : 'OS-Verschlüsselung fehlt; ein Token wird nicht gespeichert.'}</p></section>
      <section class="card settings-card"><div class="eyebrow">02 · Main & Fencing</div><h2>${esc(control.hostname || control.nodeId || 'nicht verbunden')}</h2><dl class="details"><dt>Autoritativ</dt><dd>${control.authoritative ? 'ja' : 'nein'}</dd><dt>Main-Epoche</dt><dd>${esc(control.mainEpoch || '—')}</dd><dt>Dashboard</dt><dd>${esc(control.dashboardEpoch || '—')}</dd><dt>Beobachtet</dt><dd>${fmtTime(control.observedAt)}</dd></dl><p>Die Desktop-App akzeptiert nur ein aktuell gefenctes Main-Control-Plane.</p></section>
      <section class="card settings-card"><div class="eyebrow">03 · Chat</div><h2>Antwortverhalten</h2><label>Request-Timeout<select name="requestTimeoutMs"><option value="60000" ${connection.requestTimeoutMs === 60000 ? 'selected' : ''}>60 Sekunden</option><option value="120000" ${!connection.requestTimeoutMs || connection.requestTimeoutMs === 120000 ? 'selected' : ''}>120 Sekunden</option><option value="180000" ${connection.requestTimeoutMs === 180000 ? 'selected' : ''}>180 Sekunden</option><option value="300000" ${connection.requestTimeoutMs === 300000 ? 'selected' : ''}>300 Sekunden</option></select></label><label class="check-row"><input type="checkbox" name="sendOnEnter" ${connection.sendOnEnter !== false ? 'checked' : ''}> Enter sendet, Shift+Enter erzeugt eine neue Zeile</label><p>Der Chat zeigt Laufzeit und den aktuellen Verarbeitungsschritt. Erst Tool-Evidence oder ein Validator bestätigen eine ausgeführte Aktion.</p></section>
      <section class="card settings-card"><div class="eyebrow">04 · Workspace & Darstellung</div><h2>Lokales Projekt verbinden</h2><div class="workspace-setting"><strong>${esc(workspaceById(connection.activeWorkspaceId)?.name || 'Kein aktiver Ordner')}</strong><span>${fmtNumber(connection.workspaces?.length || 0)} registrierte Projekte</span></div><button class="secondary" type="button" id="settings-select-workspace">Projektordner auswählen</button><label class="check-row"><input type="checkbox" name="showInspector" ${connection.showInspector !== false ? 'checked' : ''}> Evidence-Inspector anzeigen</label><label class="check-row"><input type="checkbox" name="compactMode" ${connection.compactMode ? 'checked' : ''}> Kompakte Chat-Darstellung</label><p>Nova erhält nur typisierte Listen-, Lese- und Suchzugriffe. Secrets, Build-Artefakte und Pfade außerhalb des gewählten Ordners bleiben gesperrt.</p></section>
      <section class="card settings-card"><div class="eyebrow">05 · Sicherheit</div><h2>Credentials bleiben lokal</h2><p>Codex OAuth gehört zu User × Node. Refresh-Tokens werden nie über Mesh, Supabase oder Memory kopiert. Hermes/OpenClaw speichern nur den Namen einer node-lokalen Secret-Variable.</p></section>
      <section class="card settings-card"><div class="eyebrow">06 · Aktionen</div><h2>Prüfen und speichern</h2><p>Ein Verbindungstest liest nur den gefencten Bootstrap. Speichern ändert keine Node- oder Main-Rolle.</p><div class="toolbar"><button class="secondary" type="button" id="test-connection">Verbindung prüfen</button><button class="primary" type="submit">Einstellungen speichern</button></div></section>
    </form></div>`
}

function startControlPolling() {
  if (state.controlPolling) return
  state.controlPolling = true
  const poll = async () => {
    try {
      if (!state.connection?.clientId) state.connection = await window.novaDesktop.config.get()
      const result = await api.get(`/api/desktop/control/next?clientId=${encodeURIComponent(state.connection.clientId)}`)
      if (result?.command) await applyDesktopCommand(result.command)
    } catch (error) {
      console.warn('Desktop control poll failed:', error?.message || error)
    } finally {
      setTimeout(poll, 1500)
    }
  }
  void poll()
}

async function applyDesktopCommand(command) {
  let success = false
  let error = ''
  let result
  try {
    const payload = command.payload || {}
    if (command.action === 'navigate') {
      state.section = payload.section
      render()
    } else if (command.action === 'open_room') {
      const room = roomById(payload.roomId)
      if (!room) throw new Error('Themenraum existiert nicht')
      state.roomId = room.id
      selectRoomDefaults(room)
      state.messages = (await api.get(`/api/desktop/rooms/${encodeURIComponent(room.id)}/messages`)).messages || []
      state.section = 'chat'
      render()
    } else if (command.action === 'select_model') {
      const room = currentRoom()
      if (!room) throw new Error('Kein aktiver Themenraum')
      const selected = modelByRoute(payload.routeId) || state.bootstrap.models.models.find(model => model.id === payload.model && model.status === 'running')
      if (payload.model !== 'auto' && !selected) throw new Error('Modellroute ist nicht verifiziert')
      const update = payload.model === 'auto'
        ? { modelMode: 'auto', pinnedModel: '', pinnedRouteId: '', preferredNodeIds: [] }
        : { modelMode: 'pinned', pinnedModel: selected.id, pinnedRouteId: modelRouteId(selected), preferredNodeIds: [selected.nodeId] }
      const saved = await api.patch(`/api/desktop/rooms/${encodeURIComponent(room.id)}`, update)
      const index = state.bootstrap.rooms.findIndex(item => item.id === saved.id)
      state.bootstrap.rooms[index] = saved
      state.selectedNodes = new Set(saved.preferredNodeIds || [])
      render()
    } else if (command.action === 'refresh') {
      await loadBootstrap()
      render()
    } else if (command.action === 'focus') {
      await window.novaDesktop.window.focus()
    } else if (command.action === 'notify') {
      toast(payload.message)
      await window.novaDesktop.window.focus()
    } else if (command.action === 'capture_screen') {
      result = await window.novaDesktop.desktop.capture()
    } else if (command.action === 'workspace_operation') {
      result = await window.novaDesktop.workspace.execute(payload)
    } else throw new Error('Unbekannte Desktop-Aktion')
    success = true
  } catch (cause) {
    error = cause?.message || String(cause)
    fail(cause)
  }
  try {
    await api.post(`/api/desktop/control/${encodeURIComponent(command.id)}/ack`, { clientId: state.connection.clientId, success, error, ...(result ? { result } : {}) })
  } catch (ackError) { console.warn('Desktop control acknowledgement failed:', ackError?.message || ackError) }
}

function renderConnectionError(error, connecting = false) {
  document.querySelector('#app').innerHTML = `<div class="connection-error"><div class="card"><div class="eyebrow">${connecting ? 'Verbindung wird hergestellt' : 'Verbindung nicht verfügbar'}</div><h1>${connecting ? 'Mit Xaventra verbinden' : 'Xaventra Main ist nicht erreichbar'}</h1><p role="status">${esc(error?.message || error)}</p><p>Prüfe Endpoint und Anmeldung. Die Einstellungen sind auch ohne laufenden Main verfügbar.</p><div class="toolbar"><button class="primary" id="open-settings">Verbindung einrichten</button><button class="secondary" id="retry">Erneut versuchen</button></div></div></div>`
  document.querySelector('#open-settings').addEventListener('click', async () => {
    ++state.connectionAttempt
    state.connection = await window.novaDesktop.config.get()
    state.bootstrap = { rooms: [], bots: [], models: { models: [] }, inventory: { nodes: [], enrollments: [] }, security: {} }
    state.section = 'settings'
    render()
  })
  document.querySelector('#retry').addEventListener('click', init)
}

function bind() {
  document.querySelectorAll('[data-section]').forEach(node => node.addEventListener('click', () => { state.section = node.dataset.section; render() }))
  document.querySelectorAll('[data-room]').forEach(node => node.addEventListener('click', async () => {
    const selection = ++state.roomSelection
    state.roomId = node.dataset.room
    const room = currentRoom()
    selectRoomDefaults(room)
    state.roomLoading = room.id
    state.messages = []
    state.section = 'chat'; render()
    try {
      const messages = (await api.get(`/api/desktop/rooms/${encodeURIComponent(room.id)}/messages`)).messages || []
      if (selection !== state.roomSelection || state.roomId !== room.id) return
      state.messages = messages
    } catch (error) { if (selection === state.roomSelection) fail(error) }
    finally { if (selection === state.roomSelection) { state.roomLoading = null; render() } }
  }))
  document.querySelectorAll('[data-action="new-room"]').forEach(node => node.addEventListener('click', showNewRoom))
  document.querySelector('[data-action="add-external"]')?.addEventListener('click', showExternalBot)
  document.querySelector('[data-action="add-node"]')?.addEventListener('click', showNodeEnrollment)
  document.querySelector('[data-action="new-memory-asset"]')?.addEventListener('click', showMemoryAsset)
  document.querySelector('[data-action="run-red-team"]')?.addEventListener('click', runRedTeam)
  document.querySelectorAll('[data-launch-module]').forEach(node => node.addEventListener('click', () => launchModule(node.dataset.launchModule)))
  document.querySelectorAll('[data-forge-action]').forEach(node => node.addEventListener('click', () => forgeAction(node.dataset.id, node.dataset.forgeAction)))
  document.querySelectorAll('[data-toggle-bot]').forEach(node => node.addEventListener('click', () => { const id = node.dataset.toggleBot; state.selectedBots.has(id) ? state.selectedBots.delete(id) : state.selectedBots.add(id); render() }))
  document.querySelectorAll('[data-toggle-node]').forEach(node => node.addEventListener('click', () => { const id = node.dataset.toggleNode; state.selectedNodes.has(id) ? state.selectedNodes.delete(id) : state.selectedNodes.add(id); render() }))
  document.querySelector('[data-action="toggle-experts"]')?.addEventListener('click', () => { state.expertPanel = !state.expertPanel; render() })
  document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => {
    const composer = document.querySelector('#composer')
    if (!composer) return
    composer.value = node.dataset.prompt
    composer.focus()
  }))
  document.querySelectorAll('[data-run-id]').forEach(node => node.addEventListener('click', () => openRunDetail(node.dataset.runId)))
  document.querySelector('#compose-form')?.addEventListener('submit', sendMessage)
  document.querySelector('#composer')?.addEventListener('keydown', event => { if (state.connection?.sendOnEnter !== false && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.querySelector('#compose-form').requestSubmit() } })
  document.querySelector('#model-picker')?.addEventListener('change', updateRoomModel)
  document.querySelector('#workspace-picker')?.addEventListener('change', updateRoomWorkspace)
  document.querySelector('#select-workspace')?.addEventListener('click', selectRoomWorkspace)
  document.querySelector('#settings-select-workspace')?.addEventListener('click', selectRoomWorkspace)
  document.querySelector('#settings-form')?.addEventListener('submit', saveSettings)
  document.querySelector('#test-connection')?.addEventListener('click', async () => {
    try {
      const data = await api.get('/api/desktop/bootstrap')
      const authoritative = data?.controlPlane?.authoritative === true
      toast(authoritative ? `Main ${data.controlPlane.hostname || data.controlPlane.nodeId} ist autoritativ erreichbar.` : 'Endpunkt antwortet, ist aber nicht autoritativ.', !authoritative)
    } catch (error) { fail(error) }
  })
  document.querySelectorAll('[data-enrollment-action]').forEach(node => node.addEventListener('click', () => enrollmentAction(node.dataset.id, node.dataset.enrollmentAction)))
  document.querySelectorAll('[data-memory-equip]').forEach(node => node.addEventListener('click', () => toggleRoomMemoryAsset(node.dataset.memoryEquip, node.dataset.equipped === 'true')))
}

async function toggleRoomMemoryAsset(assetId, equipped) {
  const room = currentRoom()
  if (!room) return
  const ids = new Set(room.memoryAssetIds || [])
  equipped ? ids.delete(assetId) : ids.add(assetId)
  try {
    const saved = await api.patch(`/api/desktop/rooms/${encodeURIComponent(room.id)}`, { memoryAssetIds: [...ids] })
    state.bootstrap.rooms[state.bootstrap.rooms.findIndex(item => item.id === saved.id)] = saved
    toast(equipped ? 'Asset aus dem Raum entfernt.' : 'Asset ist für diesen Raum ausgerüstet.')
    await loadMemory()
  } catch (error) { fail(error) }
}

function showMemoryAsset() {
  showModal('Neues Memory Asset', `<form class="form" id="memory-asset-form"><label>Name<input name="name" required maxlength="120" placeholder="Nova Release-Wissen"></label><label>Typ<select name="kind"><option value="chat-memory">Chat Memory</option><option value="skill">Validierter Skill</option><option value="wiki">Wiki / Dokumentation</option><option value="code-graph">CodeGraph</option></select></label><label>Beschreibung<input name="description" maxlength="500" placeholder="Wann dieses Wissen hilfreich ist"></label><label>Kuratiertes Wissen<textarea name="content" rows="7" maxlength="40000" required placeholder="Nur bestätigte Fakten, Entscheidungen oder validierte Abläufe."></textarea></label><label>Sichtbarkeit<select name="visibility"><option value="private">Privat</option><option value="agent">Nur gezielt ausgerüstete Agenten</option><option value="restricted">Eingeschränkt</option><option value="team">Team</option></select></label><label>Status<select name="status"><option value="draft">Entwurf</option><option value="verified">Verifiziert</option><option value="active">Aktiv</option></select></label><p>Ein Asset wird nur in den Prompt geladen, wenn es aktiv und dem User, Agenten oder Raum zugewiesen ist.</p><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Asset erstellen</button></div></form>`)
  document.querySelector('#memory-asset-form [data-close-modal]').addEventListener('click', closeModal)
  document.querySelector('#memory-asset-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.target).entries())
    try { await api.post('/api/desktop/memory-assets', { ...form, source: 'nova-desktop' }); closeModal(); await loadBootstrap(); await loadMemory(); toast('Memory Asset erstellt.') } catch (error) { fail(error) }
  })
}

async function updateRoomWorkspace(event) {
  try {
    const workspaceId = event.target.value
    state.connection = await window.novaDesktop.workspace.setActive(workspaceId)
    const room = await api.patch(`/api/desktop/rooms/${encodeURIComponent(state.roomId)}`, { workspaceId })
    const index = state.bootstrap.rooms.findIndex(item => item.id === room.id)
    state.bootstrap.rooms[index] = room
    toast(workspaceId ? `Projekt ${workspaceById(workspaceId)?.name || ''} ist an diesen Raum gebunden.` : 'Workspace-Bindung entfernt.')
    render()
  } catch (error) { fail(error); render() }
}

async function selectRoomWorkspace() {
  try {
    state.connection = await window.novaDesktop.workspace.select()
    const workspaceId = state.connection.activeWorkspaceId || ''
    if (state.roomId && workspaceId) {
      const room = await api.patch(`/api/desktop/rooms/${encodeURIComponent(state.roomId)}`, { workspaceId })
      const index = state.bootstrap.rooms.findIndex(item => item.id === room.id)
      state.bootstrap.rooms[index] = room
    }
    render()
    if (workspaceId) toast(`Projekt ${workspaceById(workspaceId)?.name || ''} verbunden. Nova kann es jetzt typisiert lesen und durchsuchen.`)
  } catch (error) { fail(error) }
}

async function openRunDetail(runId) {
  try {
    const run = await api.get(`/api/desktop/trust/runs/${encodeURIComponent(runId)}`)
    const tools = run.tools || []
    showModal('Verifizierter Arbeitslauf', `<div class="run-detail"><div class="run-summary"><span class="badge ${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${esc(run.status)}</span><h3>${esc(run.contract?.goal || run.runId)}</h3><p class="mono">${esc(run.runId)}</p></div><dl class="details"><dt>Modell</dt><dd>${esc(run.model || '—')}</dd><dt>Node</dt><dd>${esc(run.node || '—')}</dd><dt>Validator</dt><dd>${run.validation?.success ? 'bestanden' : 'nicht bestanden'}</dd><dt>Kosten</dt><dd>$${Number(run.totalCostUsd || 0).toFixed(6)}</dd></dl><div class="evidence-list">${tools.map(tool => `<article><span class="tool-pill ${tool.success === false ? 'failed' : 'ok'}">${tool.success === false ? '×' : '✓'} ${esc(tool.toolName || tool.tool || 'tool')}</span><p>${esc(String(tool.result || '').slice(0, 500))}</p></article>`).join('') || '<p>Dieser Lauf benötigte keine Tools.</p>'}</div></div>`)
  } catch (error) { fail(error) }
}

async function sendMessage(event) {
  event.preventDefault()
  const content = document.querySelector('#composer').value.trim()
  if (!content || state.busy) return
  if (!state.selectedBots.size) return toast('Wähle mindestens einen Spezialisten.', true)
  const roomId = state.roomId
  const request = { content, botIds: [...state.selectedBots], nodeIds: [...state.selectedNodes] }
  document.querySelector('#composer').value = ''
  const box = document.querySelector('.messages')
  if (box) box.scrollTop = box.scrollHeight
  state.busy = true
  state.busyRoomId = roomId
  state.busySince = Date.now()
  state.pendingMessage = { authorType: 'user', authorId: state.connection?.principal || 'desktop-owner', content, createdAt: new Date().toISOString() }
  clearInterval(state.busyTimer)
  state.busyTimer = setInterval(updateBusyProgress, 1000)
  render()
  let progressLoading = false
  const progressPoll = setInterval(async () => {
    if (progressLoading || !state.busy) return
    progressLoading = true
    try {
      // Only this room's messages are evidence; a global progress label could
      // belong to another request and elapsed time does not prove tool usage.
      const latest = (await api.get(`/api/desktop/rooms/${encodeURIComponent(roomId)}/messages`)).messages || []
      if (state.busy && state.busyRoomId === roomId && state.roomId === roomId && latest.length !== state.messages.length) {
        state.messages = latest
        if (latest.some(message => message.authorType === 'user' && message.content === content)) state.pendingMessage = null
        if (state.section === 'chat') render()
      }
    } catch { /* The main request owns user-visible error handling. */ }
    finally { progressLoading = false }
  }, 2000)
  try {
    await api.post(`/api/desktop/rooms/${encodeURIComponent(roomId)}/messages`, request)
    const messages = (await api.get(`/api/desktop/rooms/${encodeURIComponent(roomId)}/messages`)).messages || []
    if (state.roomId === roomId) state.messages = messages
  } catch (error) {
    rememberChatView()
    const view = state.chatViews.get(roomId) || { atBottom: true }
    state.chatViews.set(roomId, { ...view, draft: content })
    const composer = document.querySelector('#composer')
    if (composer?.dataset.roomId === roomId) composer.value = content
    fail(error)
  }
  finally {
    clearInterval(progressPoll)
    clearInterval(state.busyTimer)
    state.busyTimer = null
    state.busy = false
    state.busyRoomId = null
    state.busySince = 0
    state.pendingMessage = null
    // A reply must not recreate settings/modals and discard in-progress edits.
    if (state.section === 'chat') render()
  }
}

async function updateRoomModel(event) {
  const value = event.target.value
  try {
    const selected = modelByRoute(value)
    if (value !== 'auto' && !selected) throw new Error('Diese Modellroute ist nicht mehr verifiziert.')
    const room = await api.patch(`/api/desktop/rooms/${encodeURIComponent(state.roomId)}`, value === 'auto'
      ? { modelMode: 'auto', pinnedModel: '', pinnedRouteId: '', preferredNodeIds: [] }
      : { modelMode: 'pinned', pinnedModel: selected.id, pinnedRouteId: modelRouteId(selected), preferredNodeIds: [selected.nodeId] })
    const index = state.bootstrap.rooms.findIndex(item => item.id === room.id)
    state.bootstrap.rooms[index] = room
    state.selectedNodes = new Set(room.preferredNodeIds || [])
    toast(value === 'auto' ? 'Outcome Router ist aktiv.' : `Route fixiert: ${modelLabel(selected, true)}.`)
    render()
  } catch (error) { fail(error); render() }
}

function showModal(title, body) {
  const root = document.querySelector('#modal-root')
  root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-close-modal>×</button></div>${body}</section></div>`
  root.querySelector('[data-close-modal]').addEventListener('click', closeModal)
  root.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target.classList.contains('modal-backdrop')) closeModal() })
}
function closeModal() { document.querySelector('#modal-root').innerHTML = '' }

function showNewRoom() {
  showModal('Neuer Themenraum', `<form class="form" id="room-form"><label>Titel<input name="title" required maxlength="120" placeholder="z. B. Nova Release 2.76"></label><label>Thema<textarea name="topic" rows="3" maxlength="500" placeholder="Ziel und Kontext dieses Raums"></textarea></label><p>Nova ist die zentrale Ansprechpartnerin. Sie wählt Modell und Node automatisch und zieht Spezialisten nur hinzu, wenn du sie in einer Nachricht ausdrücklich auswählst.</p><div class="toolbar"><button class="primary" type="submit">Raum erstellen</button></div></form>`)
  document.querySelector('#room-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target)
    try {
      const room = await api.post('/api/desktop/rooms', { title: form.get('title'), topic: form.get('topic'), botIds: ['nova'], preferredNodeIds: [], modelMode: 'auto' })
      closeModal(); await loadBootstrap(); state.roomId = room.id; state.section = 'chat'; await loadBootstrap(); render()
    } catch (error) { fail(error) }
  })
}

function showExternalBot() {
  showModal('Hermes- oder OpenClaw-Bot anbinden', `<form class="form" id="external-form"><label>Typ<select name="kind"><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select></label><label>Name<input name="name" required maxlength="80" placeholder="Hermes Research"></label><label>Endpoint<input name="baseUrl" required placeholder="https://gateway.example.net"></label><label>Modell / Agent-ID<input name="model" placeholder="hermes-agent oder openclaw/research"></label><label>Node-lokale Credential-Variable<input name="credentialEnv" required value="NOVA_EXTERNAL_AGENT_HERMES_TOKEN" pattern="NOVA_EXTERNAL_AGENT_[A-Z0-9_]+_TOKEN"></label><label>Bot-Anweisung<textarea name="instructions" rows="3" placeholder="Recherche mit Quellen; keine Nova-Tool-Ausführung behaupten."></textarea></label><p>Der Tokenwert wird nicht über die Desktop API übertragen. Lege ihn auf dem Nova-Main als Umgebungsvariable an.</p><div class="toolbar"><button class="primary" type="submit">Verbindung und Bot anlegen</button></div></form>`)
  const formNode = document.querySelector('#external-form')
  formNode.querySelector('[name="kind"]').addEventListener('change', event => { formNode.querySelector('[name="credentialEnv"]').value = event.target.value === 'hermes' ? 'NOVA_EXTERNAL_AGENT_HERMES_TOKEN' : 'NOVA_EXTERNAL_AGENT_OPENCLAW_TOKEN' })
  formNode.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const kind = form.get('kind'); const name = form.get('name')
    try {
      const connection = await api.post('/api/desktop/external-agents', { kind, name, baseUrl: form.get('baseUrl'), model: form.get('model'), credentialEnv: form.get('credentialEnv') })
      await api.post('/api/desktop/bots', { name, handle: `${kind}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 32), avatar: kind === 'hermes' ? 'H' : 'O', color: '#14B8A6', description: `${kind} agent via ${connection.baseUrl}`, specialization: 'general', source: kind, externalConnectionId: connection.id, instructions: form.get('instructions'), toolPacks: [], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true })
      closeModal(); await loadBootstrap(); render(); toast(`${name} wurde als externer Bot registriert.`)
    } catch (error) { fail(error) }
  })
}

function showNodeEnrollment() {
  showModal('Nova-Node aufnehmen', `<form class="form" id="node-form"><label>Node-ID<input name="nodeId" required placeholder="nova-nas"></label><label>Anzeigename<input name="displayName" required placeholder="NAS Worker"></label><label>Host / IP<input name="host" required placeholder="192.0.2.30"></label><label>SSH-Benutzer<input name="sshUser" required placeholder="nova"></label><label>SSH-Port<input name="sshPort" type="number" min="1" max="65535" value="22"></label><label>Verifizierter SSH Host-Key Fingerprint<input name="expectedHostKeyFingerprint" required placeholder="SHA256:..."></label><label>Rolle<select name="role"><option value="worker">Worker · kein Main, keine Channels</option><option value="standby">Standby · Main-Kandidat mit Fencing</option></select></label><label>Runtime<select name="runtime"><option value="docker">Hardened Docker</option><option value="systemd">systemd</option></select></label><p>Nova führt keine freien SSH-Strings aus. Nach der Owner-Freigabe folgt ein signierter, schrittweise verifizierter Enrollment-Workflow.</p><div class="toolbar"><button class="primary" type="submit">Entwurf anlegen</button></div></form>`)
  document.querySelector('#node-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.target).entries()); form.sshPort = Number(form.sshPort)
    try { await api.post('/api/desktop/nodes/enrollments', form); closeModal(); await loadBootstrap(); render(); toast('Enrollment-Entwurf angelegt; noch wurde nichts installiert.') } catch (error) { fail(error) }
  })
}

async function enrollmentAction(id, action) {
  try { await api.post(`/api/desktop/nodes/enrollments/${encodeURIComponent(id)}/${action}`, {}); await loadBootstrap(); render(); toast(`Enrollment: ${action}`) } catch (error) { fail(error) }
}

async function runRedTeam() {
  try { toast('Nova Self-Test läuft …'); await api.post('/api/desktop/security/red-team/run', {}); await loadBootstrap(); render(); toast('Lokaler Red-Team Self-Test abgeschlossen.') } catch (error) { fail(error) }
}

async function forgeAction(id, action) {
  try {
    await api.post(`/api/desktop/forge/${encodeURIComponent(id)}/${action}`, {})
    await loadBootstrap(); render()
    toast(action === 'authorize-sandbox' ? 'Sandbox-Prüfung autorisiert; der Skill ist noch nicht aktiv.' : 'Skill-Entwurf abgelehnt.')
  } catch (error) { fail(error) }
}

async function launchModule(id) {
  const module = (state.bootstrap.modules || []).find(item => item.id === id)
  if (!module) return
  const botMap = {
    'local-voice': ['nova'], 'visual-awareness': ['nova'], 'cad-studio': ['developer'],
    'print-lab': ['operator'], 'smart-home': ['operator'], 'browser-workspace': ['researcher'],
    'project-workspace': ['nova', 'memory-curator'],
    'skill-forge': ['developer', 'doctor'],
  }
  const botIds = (botMap[id] || ['nova']).filter(botId => botById(botId))
  try {
    const room = await api.post('/api/desktop/rooms', {
      title: module.name,
      topic: `${module.description} Nutze nur verifizierte Nova-Tools. ${module.limitation || ''}`,
      botIds,
      preferredNodeIds: [],
      modelMode: 'auto',
    })
    await loadBootstrap(); state.roomId = room.id; state.section = 'chat'; await loadBootstrap(); render()
    toast(`${module.name} ist als Nova-Arbeitsraum geöffnet.`)
  } catch (error) { fail(error) }
}

async function saveSettings(event) {
  event.preventDefault(); const form = new FormData(event.target); const token = form.get('token')
  if (state.busy) return toast('Bitte warte auf die laufende Nachricht, bevor du die Verbindung änderst.', true)
  const previousScope = `${state.connection?.endpoint}\n${state.connection?.principal}`
  const attempt = ++state.connectionAttempt
  try {
    state.connection = await window.novaDesktop.config.set({
      endpoint: form.get('endpoint'), principal: form.get('principal'), ...(token ? { token } : {}),
      requestTimeoutMs: Number(form.get('requestTimeoutMs')),
      sendOnEnter: form.get('sendOnEnter') === 'on',
      showInspector: form.get('showInspector') === 'on',
      compactMode: form.get('compactMode') === 'on',
    })
    if (`${state.connection.endpoint}\n${state.connection.principal}` !== previousScope) {
      state.chatViews.clear()
      state.roomId = null
      state.messages = []
      state.bootstrap = null
      ++state.roomSelection
      state.roomLoading = null
      renderConnectionError('Die neue Verbindung wird geprüft.', true)
    }
    if (!await loadBootstrap(() => state.connectionAttempt === attempt)) return
    state.section = 'chat'; render(); startControlPolling(); toast('Xaventra Desktop ist verbunden.')
  } catch (error) { fail(error) }
}

document.addEventListener('DOMContentLoaded', init)
