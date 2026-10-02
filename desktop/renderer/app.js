const api = window.novaDesktop.api
// Same files in Electron (preload) and in the browser (bridge.js over HTTP).
const WEB = window.novaDesktop.web === true

// Xaventra arbeitet selbstständig. Diese Oberfläche ist ein Fenster zum
// Mitschauen und Knöpfe-Drücken: Heute (was sie tut, wo sie dich braucht),
// Unterhaltung, Arbeit, System, Gedächtnis. Fachwerkzeuge liegen unter „Mehr“.

const state = {
  section: 'heute',
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
  modelSaving: new Set(),
  views: {},
  viewKeys: {},
  viewAt: {},
  viewErrors: {},
  viewLoading: new Set(),
  cardBusy: new Set(),
  tabs: { arbeit: 'missionen', gedaechtnis: 'entscheidungen' },
  showAllThoughts: false,
  refreshTimer: null,
}

const NAV_MAIN = [
  ['heute', 'Heute', 'sun'],
  ['chat', 'Unterhaltung', 'message'],
  ['arbeit', 'Arbeit', 'briefcase'],
  ['system', 'System', 'server'],
  ['gedaechtnis', 'Gedächtnis', 'brain'],
]
const NAV_BOTTOM = [['mehr', 'Mehr', 'grid'], ['settings', 'Einstellungen', 'settings']]
// Fachseiten unter „Mehr“: bleiben erreichbar, stehen aber nicht im Weg.
const MORE_PAGES = {
  trust: { title: 'Belege & Reparaturen', icon: 'fileCheck', text: 'Jeder Arbeitslauf mit Werkzeugen, Prüfung und Kosten. Doctor-Reparaturen, die eine PATCH_GATE-Freigabe brauchen.' },
  bots: { title: 'Spezialisten', icon: 'users', text: 'Aufgaben-Profile und angebundene Hermes-/OpenClaw-Agenten. Xaventra zieht sie selbst hinzu.' },
  modules: { title: 'Studio', icon: 'sparkles', text: 'Sprache, Sehen, CAD, Druck, Smart Home: Arbeitsräume für einzelne Fähigkeiten.' },
  security: { title: 'Abwehr', icon: 'shield', text: 'Blue-Team-Vorfälle und der lokale Selbsttest gegen Xaventras eigene Schutzschichten.' },
  nodes: { title: 'Knoten aufnehmen', icon: 'plusCircle', text: 'Neue Geräte ins Netz aufnehmen (verifizierter SSH-Fingerabdruck, Owner-Freigabe).' },
  start: { title: 'Erster Start', icon: 'sparkles', text: 'Was Xaventra beim Einrichten selbst getan hat; Name, Telegram koppeln, gefundene Dienste.' },
}
const SECTION_ALIAS = { memory: 'gedaechtnis' }
const KNOWN_SECTIONS = new Set(['heute', 'chat', 'arbeit', 'system', 'gedaechtnis', 'mehr', 'settings', ...Object.keys(MORE_PAGES)])

// ── Symbole (eine Linienfamilie, 24er Raster) ───────────────
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  message: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V18h6v-1.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  dot: '<circle cx="12" cy="12" r="3"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pointer: '<path d="m4 4 7 17 2.5-7.5L21 11z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  fileCheck: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>',
  plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l2.3-2.3a4 4 0 0 0 5-5L14 2z"/>',
  scale: '<path d="M12 3v18M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0zM8 21h8"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
}
function icon(name, cls = '') { return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.dot}</svg>` }

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
    const unordered = line.match(/^\s*[-*•]\s+(.+)$/)
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
function fmtClock(value) {
  if (!value) return ''
  try { return new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) } catch { return '' }
}
function relTime(value) {
  const ms = Date.parse(value || '')
  if (!Number.isFinite(ms)) return ''
  const diff = Math.round((Date.now() - ms) / 1000)
  const future = diff < 0
  const s = Math.abs(diff)
  const text = s < 60 ? 'wenigen Sekunden' : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} Std.` : `${Math.round(s / 86400)} Tagen`
  return future ? `in ${text}` : s < 60 ? 'gerade eben' : `vor ${text}`
}
function fmtNumber(value, digits = 0) { return Number(value || 0).toLocaleString('de-AT', { maximumFractionDigits: digits }) }
function gb(bytes) { const value = Number(bytes || 0) / 1024 ** 3; return `${fmtNumber(value, value >= 100 ? 0 : 1)} GB` }
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
  return compact ? `${model.id} · ${model.nodeId}` : [model.id, model.runtime || model.provider, model.nodeId, speed, tools].filter(Boolean).join(' · ')
}
function isStandardMode() { return document.documentElement.classList.contains('novaos-standard') }
function normalizeSection(section) {
  const value = SECTION_ALIAS[section] || section
  return KNOWN_SECTIONS.has(value) ? value : 'heute'
}

let toastTimer
function toast(message, error = false) {
  const node = document.querySelector('#toast')
  node.textContent = String(message)
  node.className = `toast show${error ? ' error' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.className = 'toast' }, error ? 5200 : 3600)
}
// Server messages stay English in the API; the UI says what to do, in German.
const ERROR_TEXT = [
  [/Desktop authentication required|Dashboard token required/i, 'Anmeldung nötig: Trage in den Einstellungen das Desktop-Token des Mains ein.'],
  [/Owner authorization required|owner access requires/i, 'Nur für den Owner: Dafür braucht es das Desktop-Token des Mains.'],
  [/Zeitüberschreitung|aborted|timed? ?out/i, 'Der Main antwortet nicht rechtzeitig. Später noch einmal versuchen.'],
  [/ECONNREFUSED|Failed to fetch|NetworkError|fetch failed/i, 'Der Main ist nicht erreichbar. Läuft er, und stimmt die Adresse?'],
]
function errorText(error) {
  const raw = String(error?.message || error || '')
  const hit = ERROR_TEXT.find(([pattern]) => pattern.test(raw))
  return hit ? hit[1] : raw
}
function fail(error) {
  console.error(error)
  toast(errorText(error), true)
}

function applyTheme() {
  const theme = state.connection?.theme
  if (theme === 'hell' || theme === 'dunkel') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

// ── Verbindung ──────────────────────────────────────────────
async function loadBootstrap(isCurrent = () => true) {
  const bootstrap = await api.get('/api/desktop/bootstrap')
  if (!isCurrent()) return false
  state.bootstrap = bootstrap

  // NovaOS-Bedienmodus: eine Quelle (/etc/novaos/modus), Klasse auf <html>.
  const novaos = state.bootstrap?.novaos
  if (novaos?.istNovaOS) {
    const wurzel = document.documentElement
    wurzel.classList.toggle('novaos-standard', novaos.modus !== 'experte')
    wurzel.classList.toggle('novaos-experte', novaos.modus === 'experte')
    wurzel.classList.add('novaos')
  }

  if (state.bootstrap.controlPlane?.authoritative !== true) {
    throw new Error('Der konfigurierte Endpunkt ist kein aktuell gefenctes Xaventra-Main-Control-Plane.')
  }
  if (!state.roomId || !roomById(state.roomId)) state.roomId = state.bootstrap.rooms?.[0]?.id || null

  // Im NovaOS-Normalmodus steht niemand vor einem leeren Formular: ohne Raum
  // wird still einer angelegt, und die Oberfläche ist nur das Gespräch.
  if (!state.roomId && isStandardMode()) {
    try {
      const raum = await api.post('/api/desktop/rooms', { title: 'Xaventra', topic: '', botIds: ['nova'], preferredNodeIds: [], modelMode: 'auto' })
      state.bootstrap = await api.get('/api/desktop/bootstrap')
      state.roomId = raum?.id || state.bootstrap.rooms?.[0]?.id || null
    } catch { /* Kein Raum? Dann bleibt der Knopf — besser als ein Absturz. */ }
  }
  if (isStandardMode()) state.section = 'chat'
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
  try { state.connection = await window.novaDesktop.config.get(); applyTheme() }
  catch (error) { if (isCurrent()) renderConnectionError(error); return }
  // Bounded retries for a Core that is starting alongside Desktop. Settings
  // stay reachable throughout, and an older attempt cannot replace that form.
  for (let retry = 0; retry < 5 && isCurrent(); retry++) {
    try {
      if (!await loadBootstrap(isCurrent) || !isCurrent()) return
      // A fresh installation opens on its first-start page once.
      if (state.bootstrap?.onboarding?.pending && !state.onboardingShown) { state.onboardingShown = true; state.section = 'start' }
      render()
      startControlPolling()
      startRefresh()
      return
    } catch (error) {
      if (!isCurrent()) return
      // Fresh local installation: the app takes over the owner token once (main process only).
      if (!state.claimTried && await window.XaventraOnboarding?.tryClaim(error, state.connection)) {
        state.claimTried = true
        state.connection = await window.novaDesktop.config.get()
        retry--
        continue
      }
      state.claimTried = true
      renderConnectionError(error, retry < 4)
      if (retry === 4) return
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

// ── Gerüst ──────────────────────────────────────────────────
function openCardCount() { return (state.views.heute?.karten || []).filter(card => card.status === 'offen').length }
function railButton([id, label, glyph]) {
  const active = state.section === id || (id === 'mehr' && MORE_PAGES[state.section])
  const badge = id === 'heute' && openCardCount() ? `<span class="rail-badge" aria-label="${openCardCount()} offene Fragen">${openCardCount()}</span>` : ''
  return `<button class="rail-button ${active ? 'active' : ''}" data-section="${id}" title="${attr(label)}" ${active ? 'aria-current="page"' : ''}>${icon(glyph, 'lg')}<span class="label">${esc(label)}</span>${badge}</button>`
}
function shell(main) {
  const control = state.bootstrap?.controlPlane || {}
  return `<div class="shell ${state.connection?.compactMode ? 'compact' : ''}">
    <nav class="rail" aria-label="Hauptbereiche">
      <div class="brand" title="Xaventra · verbunden mit ${attr(control.hostname || control.nodeId || 'Main')}"><div class="brand-mark ${control.authoritative ? '' : 'offline'}"><span>X</span><i></i></div></div>
      ${NAV_MAIN.map(railButton).join('')}
      <div class="rail-spacer"></div>
      ${NAV_BOTTOM.map(railButton).join('')}
    </nav>
    <main class="workspace" id="main-content"><div id="page">${main}</div></main>
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

function rememberPageScroll() {
  const page = document.querySelector('.page')
  if (page) state.pageScroll = { section: state.section, top: page.scrollTop }
}

function pageFor(section) {
  if (section === 'chat') return chatView()
  if (section === 'heute') return heuteView()
  if (section === 'arbeit') return arbeitView()
  if (section === 'system') return systemView()
  if (section === 'gedaechtnis') return gedaechtnisView()
  if (section === 'mehr') return moreView()
  if (section === 'bots') return subPage('bots', botsView())
  if (section === 'modules') return subPage('modules', modulesView())
  if (section === 'security') return subPage('security', securityView())
  if (section === 'nodes') return subPage('nodes', nodesView())
  if (section === 'trust') return subPage('trust', loadingBlock('Belege werden geladen'))
  if (section === 'start') return subPage('start', window.XaventraOnboarding ? window.XaventraOnboarding.page(onboardingContext()) : '')
  return settingsView()
}

// Erster Start (2.85): eigene Datei onboarding.js; hier nur die Hilfsfunktionen.
function onboardingContext() {
  return {
    api, esc, attr, icon, toast, fail, errorText, navigate,
    isActive: () => state.section === 'start',
    rerender: () => { if (state.section === 'start' && !document.querySelector('.modal')) render() },
  }
}

function render() {
  rememberChatView()
  rememberPageScroll()
  const app = document.querySelector('#app')
  if (!state.bootstrap) return
  state.section = normalizeSection(state.section)
  app.innerHTML = shell(pageFor(state.section))
  bind()
  const page = document.querySelector('.page')
  if (page && state.pageScroll?.section === state.section) page.scrollTop = state.pageScroll.top
  if (state.section === 'trust') void loadTrust()
  if (state.section === 'start') window.XaventraOnboarding?.bind(onboardingContext())
  if (['heute', 'arbeit', 'system', 'gedaechtnis'].includes(state.section)) void ensureView(state.section)
  if (state.section === 'system') void ensureView('vms')
  if (state.section === 'gedaechtnis' && state.tabs.gedaechtnis === 'wissen') void ensureView('wissen')
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

// Daten der Lesesichten: zwischengespeichert, still aktualisiert.
const VIEW_PATHS = {
  heute: '/api/desktop/heute', arbeit: '/api/desktop/arbeit', system: '/api/desktop/system',
  gedaechtnis: '/api/desktop/gedaechtnis', vms: '/api/desktop/system/vms', wissen: null,
}
const VIEW_SECTION = { heute: 'heute', arbeit: 'arbeit', system: 'system', gedaechtnis: 'gedaechtnis', vms: 'system', wissen: 'gedaechtnis' }
const VIEW_MAX_AGE = { heute: 15_000, arbeit: 20_000, system: 30_000, gedaechtnis: 30_000, vms: 120_000, wissen: 30_000 }

async function fetchView(name) {
  if (name === 'wissen') {
    const [data, catalog] = await Promise.all([api.get('/api/desktop/memory?limit=200'), api.get('/api/desktop/memory-assets')])
    return { data, catalog }
  }
  return api.get(VIEW_PATHS[name])
}

async function ensureView(name, { force = false } = {}) {
  const fresh = Date.now() - (state.viewAt[name] || 0) < VIEW_MAX_AGE[name]
  if ((!force && fresh && state.views[name]) || state.viewLoading.has(name)) return
  state.viewLoading.add(name)
  const connection = state.connectionAttempt
  try {
    const data = await fetchView(name)
    if (connection !== state.connectionAttempt) return
    const key = JSON.stringify(data)
    const changed = key !== state.viewKeys[name] || state.viewErrors[name]
    state.views[name] = data
    state.viewKeys[name] = key
    state.viewAt[name] = Date.now()
    delete state.viewErrors[name]
    if (changed) rerenderFor(name)
  } catch (error) {
    if (connection !== state.connectionAttempt) return
    const message = String(error?.message || error)
    // Lost owner access: never keep showing owner data from before.
    const ownerLost = /owner authorization/i.test(message) && state.views[name]
    if (ownerLost) { delete state.views[name]; delete state.viewKeys[name] }
    const changed = state.viewErrors[name] !== message || ownerLost
    state.viewErrors[name] = message
    state.viewAt[name] = Date.now()
    if (changed) rerenderFor(name)
  } finally { state.viewLoading.delete(name) }
}

function rerenderFor(name) {
  // Never replace a page while a dialog is open or a chat is being typed.
  if (document.querySelector('.modal')) return
  if (state.section === VIEW_SECTION[name]) render()
  else if (name === 'heute') updateBadge()
}
function updateBadge() {
  const rail = document.querySelector('.rail')
  if (!rail) return
  const button = rail.querySelector('[data-section="heute"]')
  if (!button) return
  button.outerHTML = railButton(NAV_MAIN[0])
  rail.querySelector('[data-section="heute"]').addEventListener('click', () => navigate('heute'))
}

function startRefresh() {
  clearInterval(state.refreshTimer)
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === 'hidden' || !state.bootstrap) return
    void ensureView('heute')
    if (['arbeit', 'system', 'gedaechtnis'].includes(state.section)) void ensureView(state.section)
  }, 20_000)
  void ensureView('heute')
}

function navigate(section) {
  state.section = normalizeSection(section)
  render()
  document.querySelector('#main-content')?.focus?.({ preventScroll: true })
}

function viewState(name) {
  const data = state.views[name]
  const error = state.viewErrors[name]
  return { data, error, loading: !data && !error }
}
function viewErrorBlock(error) {
  const ownerOnly = /owner authorization|403/i.test(error)
  return `<div class="section"><div class="section-body"><div class="empty-note">${icon('alert')}<span>${ownerOnly
    ? 'Diese Ansicht ist nur für den Owner. Trage in den Einstellungen das Desktop-Token des Mains ein.'
    : `Nicht verfügbar: ${esc(error)}`}</span></div></div></div>`
}
function loadingBlock(label) {
  return `<div class="page"><div class="page-inner"><div class="section"><div class="section-body" aria-busy="true"><span class="sr-only">${esc(label)} …</span><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton tall"></div></div></div></div></div>`
}
function skeletonSection(title) {
  return `<section class="section"><div class="section-head"><h2>${esc(title)}</h2></div><div class="section-body" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div></section>`
}
function problemsNote(list) {
  return list?.length ? `<div class="problem-note">Teilweise nicht lesbar: ${esc(list.join(' · '))}</div>` : ''
}
function pageHead(eyebrow, title, text, name) {
  const at = state.viewAt[name]
  return `<header class="page-head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ''}</div>
    ${name ? `<div class="head-actions">${at ? `<span class="stamp">Stand ${esc(fmtClock(at))}</span>` : ''}<button class="icon-button" data-refresh="${attr(name)}" title="Aktualisieren" aria-label="Aktualisieren">${icon('refresh')}</button></div>` : ''}
  </header>`
}

// ── Heute ───────────────────────────────────────────────────
function greeting() {
  const hour = new Date().getHours()
  return hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend'
}
const IMPACT = {
  intern: ['Nur Xaventra selbst', 'layers'], infra: ['Virtuelle Maschinen', 'server'],
  physisch: ['Wirkt im Raum', 'alert'], extern: ['Verlässt das Haus', 'alert'],
}
const ANSWER_LABEL = { ja: 'Ja', nein: 'Nein', spaeter: 'Später', immer: 'Immer erlauben' }
function askCard(card) {
  const [impactText, impactIcon] = IMPACT[card.wirkung] || ['Wirkung unbekannt', 'dot']
  const busy = state.cardBusy.has(card.id)
  const order = ['ja', 'nein', 'spaeter', 'immer'].filter(answer => card.antworten.includes(answer))
  const later = card.status === 'spaeter'
  return `<article class="ask-card wirkung-${attr(card.wirkung)}" aria-label="${attr(card.titel)}">
    <header><div><h3>${esc(card.titel)}</h3>${card.vorschlag ? `<p class="proposal">${esc(card.vorschlag)}</p>` : ''}</div>${later ? '<span class="pill warn">später</span>' : ''}</header>
    <div class="ask-meta"><span>${icon(impactIcon, 'sm')}${esc(impactText)}</span>${card.expiresAt ? `<span>${icon('clock', 'sm')}gültig bis ${esc(fmtClock(card.expiresAt))}</span>` : ''}<span class="nur-experte">${esc(card.quelle || card.art)}${card.node ? ` · ${esc(card.node)}` : ''}</span></div>
    ${card.beleg ? `<details><summary>Warum sie fragt</summary><p>${esc(card.beleg)}</p></details>` : ''}
    ${order.length ? `<div class="answer-row" role="group" aria-label="Antwort">${order.map(answer => `<button class="${answer === 'ja' ? 'primary' : answer === 'nein' ? 'secondary' : 'ghost'}" data-card-answer="${answer}" data-card-id="${attr(card.id)}" ${busy ? 'disabled' : ''}>${answer === 'ja' ? icon('check', 'sm') : answer === 'nein' ? icon('x', 'sm') : answer === 'spaeter' ? icon('clock', 'sm') : ''}${ANSWER_LABEL[answer]}</button>`).join('')}</div>`
      : `<p class="section-note">${later ? 'Sie fragt zur angegebenen Zeit noch einmal nach.' : 'Diese Karte wartet auf ihre Zustellung.'}</p>`}
  </article>`
}

function reportBlock(report) {
  if (!report) return '<div class="empty-note">Kein Bericht verfügbar.</div>'
  const labels = { erledigt: 'erledigt', repariert: 'repariert', installiert: 'installiert', wartet: 'wartet auf dich', ideen: 'Ideen', gesammelt: 'Fragen gesammelt', gemerkt: 'neu gemerkt' }
  const chips = Object.entries(labels).filter(([key]) => Number(report.zahlen?.[key]) > 0)
    .map(([key, label]) => `<span class="count-chip"><strong>${fmtNumber(report.zahlen[key])}</strong>${esc(label)}</span>`).join('')
  const lines = String(report.text || '').split('\n').slice(1)
  const parts = []
  let list = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('•')) {
      if (!list) { parts.push('<ul>'); list = true }
      parts.push(`<li>${esc(line.replace(/^•\s*/, ''))}</li>`)
      continue
    }
    if (list) { parts.push('</ul>'); list = false }
    parts.push(/:$/.test(line) ? `<h4>${esc(line.slice(0, -1))}</h4>` : `<p>${esc(line)}</p>`)
  }
  if (list) parts.push('</ul>')
  const next = report.geplant ? (report.art === 'morgen' ? report.geplant.morgen : report.geplant.abend) : null
  return `${chips ? `<div class="counts">${chips}</div>` : ''}
    <div class="report-text">${parts.join('') || '<p>Seit dem letzten Bericht ist nichts Neues passiert.</p>'}</div>
    <p class="section-note">Seit ${esc(fmtTime(report.seit))}${next && report.geplant?.an ? ` · wird um ${esc(next)} zugestellt` : report.geplant && !report.geplant.an ? ' · Zustellung ist ausgeschaltet' : ''}</p>`
}

const THOUGHT_STYLE = {
  vorgeschlagen: ['idea', 'bulb', 'Vorschlag'], vorschlag: ['idea', 'bulb', 'Vorschlag'], offen: ['idea', 'bulb', 'offen'], 'wartet-auf-knopf': ['warn', 'clock', 'wartet auf dich'],
  angenommen: ['good', 'check', 'angenommen'], erledigt: ['good', 'check', 'erledigt'], geheilt: ['good', 'check', 'selbst repariert'],
  abgelehnt: ['', 'x', 'abgelehnt'], verworfen: ['', 'x', 'verworfen'], abgelaufen: ['', 'clock', 'abgelaufen'], später: ['', 'clock', 'später'],
  zurueckgerollt: ['warn', 'refresh', 'zurückgerollt'], 'rueckweg-gescheitert': ['bad', 'alert', 'Rückweg gescheitert'], 'gesperrt-fence': ['warn', 'shield', 'gesperrt'],
}
function thoughtItem(item) {
  const [tone, glyph, label] = THOUGHT_STYLE[item.status] || ['', 'dot', item.status]
  return `<li><span class="tl-icon ${tone}">${icon(glyph, 'sm')}</span><div><div class="tl-text">${esc(item.text)}</div><div class="tl-meta"><span>${esc(label)}</span><span>${esc(relTime(item.at))}</span><span class="nur-experte">${esc(item.quelle)}</span></div></div></li>`
}

function heuteView() {
  const { data, error } = viewState('heute')
  const control = state.bootstrap?.controlPlane || {}
  const head = `<header class="page-head"><div><div class="eyebrow">${esc(new Intl.DateTimeFormat('de-AT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()))}</div><h1>${greeting()}</h1><p>Xaventra arbeitet selbstständig. Hier siehst du, was sie tut – und wo sie dich braucht.</p></div>
    <div class="head-actions">${state.viewAt.heute ? `<span class="stamp">Stand ${esc(fmtClock(state.viewAt.heute))}</span>` : ''}<button class="icon-button" data-refresh="heute" title="Aktualisieren" aria-label="Aktualisieren">${icon('refresh')}</button></div></header>`
  if (error && !data) return `<div class="page"><div class="page-inner">${head}${viewErrorBlock(error)}</div></div>`
  if (!data) return `<div class="page"><div class="page-inner">${head}<div class="grid-2"><div class="stack">${skeletonSection('Braucht dich')}${skeletonSection('Bericht')}</div><div class="stack">${skeletonSection('Gedanken')}</div></div></div></div>`
  const tasks = data.jetzt?.aufgaben || []
  const queue = data.jetzt?.warteschlange || []
  const open = data.karten || []
  const thoughts = data.gedanken || []
  const shownThoughts = state.showAllThoughts ? thoughts : thoughts.slice(0, 12)
  const strip = `<section class="now-strip" aria-label="Was sie gerade tut"><span class="pulse ${tasks.length ? 'busy' : ''}" aria-hidden="true"></span>
    <div class="now-main"><strong>${tasks.length ? esc(tasks[0].text) : 'Ruhig – gerade keine laufende Aufgabe'}</strong>
      <span>${tasks.length ? `${esc(tasks[0].quelle)} · seit ${esc(relTime(tasks[0].seit).replace(/^vor /, ''))}` : 'Sie beobachtet und meldet sich, wenn etwas zu tun ist.'}${queue.length ? ` · ${queue.length} in der Warteschlange` : ''}</span>
      ${tasks.length > 1 || queue.length ? `<ul class="now-list">${tasks.slice(1, 4).map(task => `<li>${esc(task.text)}</li>`).join('')}${queue.slice(0, 3).map(item => `<li>Wartet: ${esc(String(item).replace(/^\[(?:queued|running)\]\s*/, ''))}</li>`).join('')}</ul>` : ''}</div>
    <span class="pill ${control.authoritative ? 'good' : 'bad'}" title="Verbunden mit ${attr(control.hostname || control.nodeId || 'Main')}">${control.authoritative ? 'verbunden' : 'nicht verbunden'}</span></section>`
  const askSection = `<section class="section" aria-labelledby="ask-title"><div class="section-head"><h2 id="ask-title">${icon('bulb')}Braucht dich <span class="count">${open.length ? `· ${open.length}` : ''}</span></h2></div>
    <div class="section-body">${open.length ? open.map(askCard).join('') : `<div class="empty-note">${icon('check')}Nichts offen. Sie meldet sich, wenn sie dich braucht.</div>`}</div></section>`
  const report = data.bericht
  const reportSection = `<section class="section" aria-labelledby="report-title"><div class="section-head"><h2 id="report-title">${icon('book')}${report ? esc(report.art === 'morgen' ? 'Morgenbericht' : 'Abendbericht') : 'Bericht'}</h2>${report ? '<span class="pill">Vorschau</span>' : ''}</div><div class="section-body">${reportBlock(report)}</div></section>`
  const decided = data.entschieden || []
  const decidedSection = decided.length ? `<section class="section"><div class="section-head"><h2>${icon('check')}Zuletzt entschieden</h2></div><div class="rows">${decided.map(card => `<div class="row"><div><div class="row-title">${esc(card.titel)}</div><div class="row-sub">${esc(ANSWER_LABEL[card.antwort] || card.status)} · ${esc(relTime(card.decidedAt))}${card.entschiedenUeber ? ` · über ${esc(card.entschiedenUeber === 'desktop' ? 'diese App' : card.entschiedenUeber === 'even-g2' ? 'die Brille' : 'Telegram')}` : ''}${card.ergebnis ? ` · ${esc(card.ergebnis.text)}` : ''}</div></div><div class="row-side">${card.ergebnis ? `<span class="pill ${card.ergebnis.ok ? 'good' : 'bad'}">${card.ergebnis.ok ? 'ausgeführt' : 'nicht ausgeführt'}</span>` : ''}</div></div>`).join('')}</div></section>` : ''
  const thoughtSection = `<section class="section" aria-labelledby="thought-title"><div class="section-head"><h2 id="thought-title">${icon('brain')}Gedanken</h2><span class="section-note">auch Verworfenes</span></div>
    ${thoughts.length ? `<ul class="timeline">${shownThoughts.map(thoughtItem).join('')}</ul>${thoughts.length > 12 ? `<div class="show-more"><button class="ghost" data-action="toggle-thoughts">${state.showAllThoughts ? 'Weniger zeigen' : `Alle ${thoughts.length} zeigen`}</button></div>` : ''}` : `<div class="section-body"><div class="empty-note">Noch keine Gedanken aufgezeichnet.</div></div>`}</section>`
  return `<div class="page"><div class="page-inner">${head}${strip}${problemsNote(data.probleme)}
    <div class="grid-2"><div class="stack">${askSection}${reportSection}</div><div class="stack">${thoughtSection}${decidedSection}</div></div></div></div>`
}

async function answerCard(cardId, answer) {
  const card = (state.views.heute?.karten || []).find(item => item.id === cardId)
  if (!card) return
  const send = async () => {
    state.cardBusy.add(cardId)
    render()
    try {
      const result = await api.post(`/api/desktop/karten/${encodeURIComponent(cardId)}/antwort`, { answer })
      toast(result?.message || 'Antwort gespeichert.')
    } catch (error) { fail(error) }
    finally {
      state.cardBusy.delete(cardId)
      await ensureView('heute', { force: true })
      render()
    }
  }
  if (answer === 'immer') {
    showModal('Dauerhaft erlauben?', `<p>„${esc(card.titel)}“ – Xaventra fragt bei dieser Art von Aktion künftig nicht mehr, sondern macht sie selbst.</p><p class="section-note">Zurücknehmen geht jederzeit: „das wieder fragen“ in der Unterhaltung.</p><div class="toolbar"><button class="secondary" data-close-modal>Abbrechen</button><button class="primary" id="confirm-always">Immer erlauben</button></div>`)
    document.querySelector('#confirm-always').addEventListener('click', () => { closeModal(); void send() })
    return
  }
  await send()
}

// ── Arbeit ──────────────────────────────────────────────────
const MISSION_STATUS = {
  geplant: ['', 'geplant'], 'in-arbeit': ['info', 'in Arbeit'], 'wartet-auf-alfred': ['warn', 'wartet auf dich'], 'wartet-auf-delegation': ['info', 'wartet auf Helfer'],
  blockiert: ['bad', 'blockiert'], abgeschlossen: ['good', 'abgeschlossen'], fehlgeschlagen: ['bad', 'fehlgeschlagen'],
  planning: ['info', 'plant'], active: ['info', 'läuft'], paused: ['warn', 'pausiert'], done: ['good', 'fertig'], failed: ['bad', 'fehlgeschlagen'], cancelled: ['', 'abgebrochen'],
}
function statusPill(status) { const [tone, label] = MISSION_STATUS[status] || ['', status]; return `<span class="pill ${tone}">${esc(label)}</span>` }
function stepDot(status) {
  if (['erledigt', 'done'].includes(status)) return `<span class="dot good">${icon('check', 'sm')}</span>`
  if (['laeuft', 'active'].includes(status)) return `<span class="dot run">${icon('activity', 'sm')}</span>`
  if (['fehlgeschlagen', 'failed', 'abgelehnt'].includes(status)) return `<span class="dot bad">${icon('x', 'sm')}</span>`
  if (['wartet'].includes(status)) return `<span class="dot wait">${icon('clock', 'sm')}</span>`
  return `<span class="dot">${icon('dot', 'sm')}</span>`
}
function missionTile(mission) {
  return `<article class="tile"><header><div><h3>${esc(mission.titel)}</h3><div class="sub">Versuch ${mission.versuch}/${mission.maxVersuche} · ${esc(relTime(mission.updatedAt))}</div></div>${statusPill(mission.status)}</header>
    ${mission.anlass?.length ? `<p>${esc(mission.anlass[0])}</p>` : ''}
    <ol class="steps">${(mission.schritte || []).map(step => `<li>${stepDot(step.status)}<span>${esc(step.titel)}${step.ergebnis ? ` <span class="row-sub">– ${esc(step.ergebnis)}</span>` : ''}</span></li>`).join('')}</ol>
    ${mission.uebergabe ? `<div class="problem-note">${esc(mission.uebergabe)}</div>` : ''}
    ${mission.fertigWenn?.length ? `<details><summary class="section-note">Fertig, wenn …</summary><ul>${mission.fertigWenn.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}</article>`
}
function auftragTile(auftrag, active = false) {
  return `<article class="tile"><header><div><h3>${esc(auftrag.ziel)}</h3><div class="sub">${esc(fmtTime(auftrag.createdAt))}${auftrag.finishedAt ? ` – ${esc(fmtTime(auftrag.finishedAt))}` : ''}</div></div>${statusPill(auftrag.status)}</header>
    ${auftrag.schritte?.length ? `<ol class="steps">${auftrag.schritte.slice(0, active ? 15 : 5).map(step => `<li>${stepDot(step.status)}<span>${esc(step.text)}</span></li>`).join('')}</ol>` : ''}
    ${active && auftrag.fortschritt?.length ? `<p class="row-sub">${esc(auftrag.fortschritt.at(-1))}</p>` : ''}</article>`
}
function arbeitView() {
  const { data, error } = viewState('arbeit')
  const head = pageHead('Arbeit', 'Woran sie arbeitet', 'Missionen entstehen aus ihren Verantwortungen, Aufträge kommen von dir. Sie plant, führt aus und belegt das Ergebnis selbst.', 'arbeit')
  if (error && !data) return `<div class="page"><div class="page-inner">${head}${viewErrorBlock(error)}</div></div>`
  if (!data) return `<div class="page"><div class="page-inner">${head}${skeletonSection('Missionen')}</div></div>`
  const missions = data.missionen || []
  const activeMissions = missions.filter(item => !['abgeschlossen', 'fehlgeschlagen'].includes(item.status))
  const doneMissions = missions.filter(item => ['abgeschlossen', 'fehlgeschlagen'].includes(item.status))
  const auftraege = data.auftraege || {}
  const tabs = [
    ['missionen', 'Missionen', activeMissions.length], ['auftraege', 'Aufträge', (auftraege.aktiv ? 1 : 0)],
    ['delegationen', 'Delegationen', (data.delegationen || []).length], ['verantwortungen', 'Verantwortungen', (data.verantwortungen || []).length],
    ['geplant', 'Geplant', (data.geplant || []).filter(job => job.an).length],
  ]
  const tab = state.tabs.arbeit
  let body = ''
  if (tab === 'missionen') {
    body = `${activeMissions.length ? `<div class="tiles">${activeMissions.map(missionTile).join('')}</div>` : `<div class="section"><div class="section-body"><div class="empty-note">${icon('check')}Keine offene Mission – alles, wofür sie verantwortlich ist, ist in Ordnung.</div></div></div>`}
      ${doneMissions.length ? `<section class="section"><div class="section-head"><h2>Zuletzt abgeschlossen</h2></div><div class="rows">${doneMissions.slice(0, 8).map(item => `<div class="row"><div><div class="row-title">${esc(item.titel)}</div><div class="row-sub">${esc(fmtTime(item.updatedAt))}${item.uebergabe ? ` · ${esc(item.uebergabe)}` : ''}</div></div><div class="row-side">${statusPill(item.status)}</div></div>`).join('')}</div></section>` : ''}`
  } else if (tab === 'auftraege') {
    body = `${auftraege.aktiv ? `<div class="tiles">${auftragTile(auftraege.aktiv, true)}</div>` : `<div class="section"><div class="section-body"><div class="empty-note">Gerade kein laufender Auftrag. Aufträge gibst du ihr in der Unterhaltung.</div></div></div>`}
      ${(auftraege.verlauf || []).length ? `<section class="section"><div class="section-head"><h2>Frühere Aufträge</h2></div><div class="rows">${auftraege.verlauf.map(item => `<div class="row"><div><div class="row-title">${esc(item.ziel)}</div><div class="row-sub">${esc(fmtTime(item.createdAt))} · ${item.schritte?.length || 0} ${item.schritte?.length === 1 ? 'Schritt' : 'Schritte'}</div></div><div class="row-side">${statusPill(item.status)}</div></div>`).join('')}</div></section>` : ''}`
  } else if (tab === 'geplant') {
    const jobs = data.geplant
    body = jobs === null || jobs === undefined ? `<div class="section"><div class="section-body"><div class="empty-note">Der Planer läuft nicht (autonomy.planner).</div></div></div>`
      : jobs.length ? `<section class="section"><div class="rows">${jobs.map(job => `<div class="row"><div><div class="row-title">${esc(job.titel)}</div><div class="row-sub">${esc(job.rhythmus)}${job.naechster ? ` · nächstes Mal ${esc(fmtTime(job.naechster))}` : ''}${job.zuletzt ? ` · zuletzt ${esc(relTime(job.zuletzt))}${job.letzterStatus ? ` (${esc(job.letzterStatus)})` : ''}` : ''}</div></div><div class="row-side"><span class="pill ${job.an ? 'good' : ''}">${job.an ? 'an' : 'aus'}</span></div></div>`).join('')}</div></section><p class="section-note">Erinnerungen und Routinen legst du in der Unterhaltung an („erinnere mich morgen um 8 …“).</p>`
        : `<div class="section"><div class="section-body"><div class="empty-note">Nichts geplant.</div></div></div>`
  } else if (tab === 'delegationen') {
    const list = data.delegationen || []
    body = list.length ? `<section class="section"><div class="rows">${list.map(item => `<div class="row"><div><div class="row-title">${esc(item.auftrag)}</div><div class="row-sub">an ${esc(item.an)} · Stufe ${esc(item.stufe)} · Frist ${esc(fmtTime(item.frist))}${item.pruefung ? ` · Prüfung: ${esc(item.pruefung.ergebnis)} – ${esc(item.pruefung.detail)}` : ''}</div></div><div class="row-side"><span class="pill ${item.pruefung?.ergebnis === 'verifiziert' ? 'good' : ['fehler', 'abgelehnt', 'abgelaufen'].includes(item.status) ? 'bad' : ''}">${esc(item.status)}</span></div></div>`).join('')}</div></section>`
      : `<div class="section"><div class="section-body"><div class="empty-note">Keine Delegationen. Wenn sie Arbeit an Helfer (Claude, Codex, Hermes) abgibt, steht sie hier – mit Prüfung des Ergebnisses.</div></div></div>`
  } else {
    const list = data.verantwortungen || []
    const trust = data.vertrauen || []
    const granted = data.erlaubt || []
    body = `${data.an === false ? '<div class="problem-note">Verantwortungen sind ausgeschaltet (autonomy.responsibilities.enabled=false).</div>' : ''}
      ${list.length ? `<div class="tiles">${list.map(item => {
        const check = item.letztePruefung
        const tone = item.status === 'pausiert' ? ['warn', 'pausiert'] : item.status === 'vorgeschlagen' ? ['info', 'Vorschlag'] : !check ? ['', 'noch nicht gemessen'] : check.erfuellt === true ? ['good', 'erfüllt'] : check.erfuellt === false ? ['bad', 'verletzt'] : ['', 'unbekannt']
        return `<article class="tile"><header><div><h3>${esc(item.titel)}</h3><div class="sub">${esc(item.herkunft)} · darf bis ${esc(item.bisStufe)}</div></div><span class="pill ${tone[0]}">${esc(tone[1])}</span></header><p>${esc(item.ziel)}</p>${check?.befunde?.length && check.erfuellt === false ? `<div class="problem-note">${esc(check.befunde.join(' · '))}</div>` : ''}${check ? `<div class="row-sub">Zuletzt geprüft ${esc(relTime(check.at))}</div>` : ''}</article>`
      }).join('')}</div>` : `<div class="section"><div class="section-body"><div class="empty-note">Noch keine Verantwortungen.</div></div></div>`}
      <section class="section"><div class="section-head"><h2>${icon('scale')}Macht sie inzwischen selbst</h2></div><div class="rows">${trust.length || granted.length ? [...trust.map(item => `<div class="row"><div><div class="row-title">${esc(item.text)}</div><div class="row-sub">nach dreimal Ja ohne Rückweg · seit ${esc(fmtTime(item.seit))}</div></div><div class="row-side"><span class="pill good">selbst</span></div></div>`), ...granted.map(item => `<div class="row"><div><div class="row-title">${esc(item.art)}: ${esc(item.was)}</div><div class="row-sub">dauerhaft erlaubt seit ${esc(fmtTime(item.seit))}</div></div><div class="row-side"><span class="pill info">erlaubt</span></div></div>`)].join('') : '<div class="row"><div class="row-sub">Noch nichts – sie fragt bei allem, was über ihr eigenes System hinausgeht.</div></div>'}</div></section>`
  }
  return `<div class="page"><div class="page-inner">${head}${problemsNote(data.probleme)}
    <nav class="tabs" aria-label="Arbeit">${tabs.map(([id, label, count]) => `<button class="tab ${tab === id ? 'active' : ''}" data-tab="arbeit:${id}" ${tab === id ? 'aria-current="true"' : ''}>${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</nav>
    ${body}</div></div>`
}

// ── System ──────────────────────────────────────────────────
function meter(label, value, unit = '%') {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return ''
  const pct = Math.max(0, Math.min(100, Number(value)))
  const tone = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : ''
  return `<div class="meter"><span>${esc(label)}</span><div class="meter-bar" role="img" aria-label="${attr(`${label} ${Math.round(pct)} ${unit}`)}"><span class="${tone}" data-pct="${pct}"></span></div><b>${fmtNumber(value)} ${esc(unit)}</b></div>`
}
function sparkline(points, key, label) {
  const values = (points || []).map(point => point[key]).filter(value => Number.isFinite(value))
  if (values.length < 2) return ''
  const w = 300, h = 40
  const step = w / (values.length - 1)
  const coords = values.map((value, index) => `${(index * step).toFixed(1)},${(h - 2 - (Math.max(0, Math.min(100, value)) / 100) * (h - 4)).toFixed(1)}`)
  const min = Math.min(...values), max = Math.max(...values)
  return `<div><svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${attr(`${label} der letzten 24 Stunden: niedrigst ${Math.round(min)} %, höchst ${Math.round(max)} %, jetzt ${Math.round(values.at(-1))} %`)}"><polygon class="area" points="0,${h} ${coords.join(' ')} ${w},${h}"/><polyline points="${coords.join(' ')}"/></svg>
    <div class="spark-legend"><span>${esc(label)} · 24 Std.</span><span>${Math.round(min)}–${Math.round(max)} %</span></div></div>`
}
function nodeTiles(data) {
  const inventory = state.bootstrap?.inventory?.nodes || []
  const watched = data?.waechter?.knoten || []
  const ids = [...new Set([...inventory.map(node => node.id), ...watched.map(node => node.id)])]
  if (!ids.length) return `<div class="empty-note">Noch keine Knoten bekannt.</div>`
  return `<div class="tiles">${ids.map(id => {
    const node = inventory.find(item => item.id === id) || {}
    const watch = watched.find(item => item.id === id)
    const online = ['online', 'active'].includes(String(node.status || node.lifecycle)) || (watch && watch.alterMin < 15)
    const disk = watch?.platten?.length ? watch.platten.reduce((a, b) => (b.belegt > a.belegt ? b : a)) : null
    return `<article class="tile"><header><div><h3>${esc(node.name || id)}</h3><div class="sub node-id">${esc(id)}${node.version ? ` · ${esc(node.version)}` : ''}</div></div><span class="pill ${online ? 'good' : 'bad'}">${online ? 'erreichbar' : 'still'}</span></header>
      ${watch ? `<div class="meters">${meter('Arbeitsspeicher', watch.ram)}${disk ? meter(`Platte ${disk.mount}`, disk.belegt) : ''}${watch.cpu !== null && watch.cpu !== undefined ? `<div class="meter"><span>Last</span><div></div><b>${fmtNumber(watch.cpu, 2)}</b></div>` : ''}${watch.tempC ? `<div class="meter"><span>Temperatur</span><div></div><b>${fmtNumber(watch.tempC)} °C</b></div>` : ''}</div>
        ${sparkline(data?.verlauf?.[id], 'ram', 'Arbeitsspeicher')}
        ${watch.dienstAus?.length ? `<div class="problem-note">Dienst aus: ${esc(watch.dienstAus.join(', '))}</div>` : ''}
        <div class="row-sub">gemessen ${esc(relTime(watch.at))}</div>` : '<div class="row-sub">Noch keine Messwerte vom Wächter.</div>'}
    </article>`
  }).join('')}</div>`
}
function vmsSection() {
  const { data, error } = viewState('vms')
  const head = `<div class="section-head"><h2>${icon('layers')}Virtuelle Maschinen</h2>${data?.ok ? `<span class="section-note">Pool ${esc(data.pool || '')}${data.usage ? ` · ${fmtNumber(data.usage.count)} eigene, ${fmtNumber(data.usage.ramGB)} GB RAM belegt` : ''}</span>` : ''}</div>`
  if (error) return `<section class="section">${head}<div class="section-body"><div class="empty-note">${icon('alert')}${/owner/i.test(error) ? 'Nur für den Owner.' : esc(error)}</div></div></section>`
  if (!data) return skeletonSection('Virtuelle Maschinen')
  if (!data.ok) return `<section class="section">${head}<div class="section-body"><div class="empty-note">Proxmox ist nicht eingerichtet: ${esc(data.reason || 'aus')}.</div></div></section>`
  const guests = (data.guests || []).filter(guest => !guest.template).sort((a, b) => Number(b.eigene) - Number(a.eigene) || a.vmid - b.vmid)
  return `<section class="section">${head}<div class="rows">${guests.map(guest => `<div class="row"><div><div class="row-title">${esc(guest.name || guest.vmid)} <span class="row-sub">#${guest.vmid}</span></div><div class="row-sub">${esc(guest.type === 'lxc' ? 'Container' : 'VM')} auf ${esc(guest.node)} · ${guest.maxcpu} Kerne · ${gb(guest.maxmem)} RAM · ${gb(guest.maxdisk)}${guest.selbst ? ' · hier läuft Xaventra' : ''}</div></div><div class="row-side">${guest.eigene ? '<span class="pill info">eigene</span>' : ''}<span class="pill ${guest.status === 'running' ? 'good' : ''}">${guest.status === 'running' ? 'läuft' : guest.status === 'stopped' ? 'aus' : esc(guest.status)}</span></div></div>`).join('') || '<div class="row"><div class="row-sub">Keine Gäste.</div></div>'}</div>
    <div class="section-body"><p class="section-note">Starten, Stoppen oder neue VMs schlägt sie selbst als Karte vor – die Antwort gibst du unter „Heute“.</p></div></section>`
}
function desktopsSection(data) {
  const direct = data?.desktops || { enabled: false, desktops: [] }
  const canOpen = typeof window.novaDesktop.desktopDirect?.open === 'function'
  return `<section class="section"><div class="section-head"><h2>${icon('monitor')}Desktops</h2></div>
    ${direct.enabled && direct.desktops.length ? `<div class="rows">${direct.desktops.map(desktop => `<div class="row"><div><div class="row-title">${esc(desktop.label)}</div><div class="row-sub">${desktop.active.length ? `Gerade offen: ${desktop.active.map(mode => mode === 'control' ? 'übernommen' : 'angesehen').join(', ')}` : 'Einmal-Link über das Tailnet, ohne Passwort'}${desktop.agentInput ? ' · Übernehmen pausiert Xaventras Eingaben' : ''}</div></div>
      <div class="row-side"><button class="secondary" data-desktop-open="${attr(desktop.id)}" data-mode="view" ${canOpen ? '' : 'disabled'}>${icon('eye', 'sm')}Ansehen</button>${desktop.allowControl ? `<button class="secondary" data-desktop-open="${attr(desktop.id)}" data-mode="control" ${canOpen ? '' : 'disabled'}>${icon('pointer', 'sm')}Übernehmen</button>` : ''}</div></div>`).join('')}</div>`
      : `<div class="section-body"><div class="empty-note">Desktop-Direktverbindung ist aus (desktop.direct.enabled).</div></div>`}</section>`
}
function modelsSection() {
  const models = chatModels()
  const active = state.bootstrap?.models?.activeModel
  return `<section class="section"><div class="section-head"><h2>${icon('cpu')}Modelle</h2><span class="section-note">Sie wählt selbst; fixieren kannst du je Raum in der Unterhaltung.</span></div>
    <div class="rows">${models.map(model => `<div class="row"><div><div class="row-title">${esc(model.id)}</div><div class="row-sub">${esc(model.runtime || model.provider || '')} auf ${esc(model.nodeId || '—')}${model.tokensPerSecond ? ` · ${fmtNumber(model.tokensPerSecond, 1)} tok/s` : ''}${model.toolSamples > 0 ? ` · ${fmtNumber(model.toolSuccessRate * 100)} % Werkzeuge erfolgreich` : ''}</div></div><div class="row-side">${model.id === active ? '<span class="pill info">aktiv</span>' : ''}<span class="pill ${model.status === 'running' ? 'good' : ''}">${model.status === 'running' ? 'bereit' : esc(model.status || '—')}</span></div></div>`).join('') || '<div class="row"><div class="row-sub">Keine Modelle gemeldet.</div></div>'}</div></section>`
}
function systemView() {
  const { data, error } = viewState('system')
  const head = pageHead('System', 'Geräte, Wächter, Maschinen', 'Der Wächter misst alle Knoten, prüft Erreichbarkeit, Zertifikate und Sicherungen und meldet Abweichungen als Gedanken.', 'system')
  if (error && !data) return `<div class="page"><div class="page-inner">${head}${viewErrorBlock(error)}${modelsSection()}</div></div>`
  if (!data) return `<div class="page"><div class="page-inner">${head}${skeletonSection('Knoten')}</div></div>`
  const watch = data.waechter
  const reach = watch?.erreichbarkeit || []
  const failing = reach.filter(item => !item.ok)
  const extras = [
    ...(watch?.prognosen || []).map(item => ({ title: item.art === 'platte' ? 'Platte läuft voll' : 'Arbeitsspeicher steigt', sub: `${item.text}${item.tage !== null ? ` · in etwa ${fmtNumber(item.tage)} Tagen` : ''}`, tone: item.schwere === 'critical' ? 'bad' : 'warn', label: 'Prognose' })),
    ...(watch?.zertifikate || []).filter(item => item.schwere !== 'ok').map(item => ({ title: `Zertifikat ${item.name}`, sub: item.tage === null ? 'Ablauf unbekannt' : `läuft in ${fmtNumber(item.tage)} Tagen ab`, tone: item.schwere === 'critical' ? 'bad' : 'warn', label: 'Zertifikat' })),
    ...(watch?.sicherungen || []).filter(item => item.schwere !== 'ok').map(item => ({ title: `Sicherung ${item.name}`, sub: item.alterStd === null ? 'keine gefunden' : `zuletzt vor ${fmtNumber(item.alterStd)} Std. (erlaubt ${fmtNumber(item.maxStd)})`, tone: item.schwere === 'critical' ? 'bad' : 'warn', label: 'Sicherung' })),
  ]
  const night = watch?.nachtwache
  return `<div class="page"><div class="page-inner">${head}${problemsNote(data.probleme)}
    ${watch && !watch.an ? '<div class="problem-note">Der Wächter ist ausgeschaltet – Messwerte können veraltet sein.</div>' : ''}
    <section class="section"><div class="section-head"><h2>${icon('server')}Knoten</h2>${watch?.stand ? `<span class="section-note">letzte Runde ${esc(relTime(watch.stand))}</span>` : ''}</div><div class="section-body">${nodeTiles(data)}</div></section>
    <div class="grid-2"><div class="stack">
      <section class="section"><div class="section-head"><h2>${icon('activity')}Erreichbarkeit</h2><span class="pill ${failing.length ? 'bad' : 'good'}">${failing.length ? `${failing.length} gestört` : reach.length ? 'alles erreichbar' : 'keine Ziele'}</span></div>
        <div class="rows">${reach.slice(0, 20).map(item => `<div class="row"><div><div class="row-title">${esc(item.name)}</div><div class="row-sub">${esc(item.art)}${item.ms !== null ? ` · ${fmtNumber(item.ms)} ms` : ''}${!item.ok && item.detail ? ` · ${esc(item.detail)}` : ''}</div></div><div class="row-side"><span class="pill ${item.ok ? 'good' : 'bad'}">${item.ok ? 'ok' : item.alarm ? 'Alarm' : 'gestört'}</span></div></div>`).join('') || '<div class="row"><div class="row-sub">Keine Ziele konfiguriert.</div></div>'}</div></section>
      ${desktopsSection(data)}
    </div><div class="stack">
      <section class="section"><div class="section-head"><h2>${icon('alert')}Vorausschau</h2></div><div class="rows">${extras.map(item => `<div class="row"><div><div class="row-title">${esc(item.title)}</div><div class="row-sub">${esc(item.sub)}</div></div><div class="row-side"><span class="pill ${item.tone}">${esc(item.label)}</span></div></div>`).join('') || '<div class="row"><div class="row-sub">Keine Prognose, kein ablaufendes Zertifikat, keine überfällige Sicherung.</div></div>'}</div></section>
      ${night ? `<section class="section"><div class="section-head"><h2>${icon('moon')}Nachtwache</h2><span class="section-note">${esc(relTime(night.at))}</span></div><div class="rows">${night.fehler.length ? night.fehler.map(item => `<div class="row"><div><div class="row-title">${esc(item.label)}</div><div class="row-sub">${esc(item.text)}</div></div><div class="row-side"><span class="pill bad">${esc(item.status)}</span></div></div>`).join('') : `<div class="row"><div class="row-sub">Alle ${fmtNumber(night.gesamt)} Prüfungen bestanden.</div></div>`}</div></section>` : ''}
    </div></div>
    ${vmsSection()}
    ${modelsSection()}
  </div></div>`
}

async function openDesktop(desktopId, mode) {
  const desktop = (state.views.system?.desktops?.desktops || []).find(item => item.id === desktopId)
  const go = async () => {
    try {
      const result = await window.novaDesktop.desktopDirect.open({ desktopId, mode })
      toast(`${result?.label || 'Desktop'} öffnet sich in einem eigenen Fenster. Schließen beendet die Sitzung.`)
      setTimeout(() => void ensureView('system', { force: true }), 4000)
    } catch (error) { fail(error) }
  }
  if (mode === 'control') {
    showModal('Desktop übernehmen?', `<p>Du bedienst „${esc(desktop?.label || desktopId)}“ mit Maus und Tastatur.${desktop?.agentInput ? ' Solange du übernimmst, pausiert Xaventra ihre eigenen Eingaben auf diesem Desktop.' : ''}</p><p class="section-note">Zurückgeben: einfach das Fenster schließen.</p><div class="toolbar"><button class="secondary" data-close-modal>Abbrechen</button><button class="primary" id="confirm-control">Übernehmen</button></div>`)
    document.querySelector('#confirm-control').addEventListener('click', () => { closeModal(); void go() })
    return
  }
  await go()
}

// ── Gedächtnis ──────────────────────────────────────────────
const DECISION_STATUS = { aktiv: ['good', 'gilt'], rueckfrage: ['warn', 'Rückfrage'], ersetzt: ['', 'ersetzt'], widerrufen: ['', 'widerrufen'], abgelaufen: ['', 'abgelaufen'], verworfen: ['', 'verworfen'] }
const FORGE_STATUS = { proposed: ['info', 'Entwurf'], tested: ['info', 'getestet'], 'awaiting-approval': ['warn', 'wartet auf Freigabe'], active: ['good', 'aktiv'], degraded: ['bad', 'gestört'], disabled: ['', 'aus'], rejected: ['', 'abgelehnt'] }
function gedaechtnisView() {
  const { data, error } = viewState('gedaechtnis')
  const head = pageHead('Gedächtnis', 'Was sie sich merkt', 'Entscheidungen, die sie aus deinen Worten und Antworten abgeleitet hat, die Werkzeuge, die sie sich selbst gebaut hat, und kuratiertes Wissen.', 'gedaechtnis')
  const tab = state.tabs.gedaechtnis
  const decisions = data?.entscheidungen || []
  const tools = data?.werkzeuge || []
  const tabs = [['entscheidungen', 'Entscheidungen', decisions.filter(item => item.status === 'aktiv').length], ['werkzeuge', 'Werkzeuge', tools.filter(item => item.status === 'active').length], ['wissen', 'Wissen', 0]]
  const nav = `<nav class="tabs" aria-label="Gedächtnis">${tabs.map(([id, label, count]) => `<button class="tab ${tab === id ? 'active' : ''}" data-tab="gedaechtnis:${id}" ${tab === id ? 'aria-current="true"' : ''}>${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</button>`).join('')}</nav>`
  if (tab === 'wissen') return `<div class="page"><div class="page-inner">${head}${nav}${wissenBody()}</div></div>`
  if (error && !data) return `<div class="page"><div class="page-inner">${head}${nav}${viewErrorBlock(error)}</div></div>`
  if (!data) return `<div class="page"><div class="page-inner">${head}${nav}${skeletonSection('Entscheidungen')}</div></div>`
  let body
  if (tab === 'entscheidungen') {
    body = decisions.length ? `<section class="section"><div class="rows">${decisions.map(item => {
      const [tone, label] = DECISION_STATUS[item.status] || ['', item.status]
      return `<div class="row"><div><div class="row-title">${esc(item.text)}</div><div class="row-sub">${item.warum ? `${esc(item.warum)} · ` : ''}${esc(fmtTime(item.at))}${item.gueltigBis ? ` · gilt bis ${esc(fmtTime(item.gueltigBis))}` : ''}${!item.wirksam && item.nichtWirksamGrund ? ` · nicht wirksam: ${esc(item.nichtWirksamGrund)}` : ''}</div>${item.themen?.length ? `<div class="chips spaced">${item.themen.map(topic => `<span class="pill">${esc(topic)}</span>`).join('')}</div>` : ''}</div>
        <div class="row-side">${item.bindend ? '<span class="pill info">bindend</span>' : ''}<span class="pill ${tone}">${esc(label)}</span></div></div>`
    }).join('')}</div></section><p class="section-note">Ändern oder zurücknehmen: sag es ihr in der Unterhaltung („das gilt nicht mehr“).</p>`
      : `<div class="section"><div class="section-body"><div class="empty-note">Noch keine Entscheidungen gemerkt.</div></div></div>`
  } else {
    body = tools.length ? `<div class="tiles">${tools.map(item => {
      const [tone, label] = FORGE_STATUS[item.status] || ['', item.status]
      return `<article class="tile"><header><div><h3>${esc(item.name)}</h3><div class="sub">Version ${item.version}${item.wirkung ? ` · Wirkung: ${esc(item.wirkung)}` : ''}</div></div><span class="pill ${tone}">${esc(label)}</span></header>
        <p>${esc(item.beschreibung)}</p>
        <dl class="facts">${item.tests ? `<dt>Tests</dt><dd>${item.tests.bestanden}/${item.tests.gesamt} bestanden</dd>` : ''}${item.aufrufe ? `<dt>Aufrufe</dt><dd>${fmtNumber(item.aufrufe.gesamt)} (${fmtNumber(item.aufrufe.fehler)} Fehler)${item.aufrufe.zuletzt ? ` · zuletzt ${esc(relTime(item.aufrufe.zuletzt))}` : ''}</dd>` : ''}${item.warum ? `<dt>Warum</dt><dd>${esc(item.warum)}</dd>` : ''}</dl>
        ${item.gesperrt ? `<div class="problem-note">${esc(item.gesperrt)}</div>` : ''}
        ${item.status === 'proposed' ? `<div class="toolbar"><button class="primary" data-forge-action="authorize-sandbox" data-id="${attr(item.id)}">Testen lassen</button><button class="danger-button" data-forge-action="reject" data-id="${attr(item.id)}">Ablehnen</button></div>` : ''}
        ${item.status === 'awaiting-approval' && item.karte ? '<div class="row-sub">Die Freigabe-Karte steht unter „Heute“.</div>' : ''}</article>`
    }).join('')}</div>` : `<div class="section"><div class="section-body"><div class="empty-note">Sie hat sich noch kein eigenes Werkzeug gebaut.</div></div></div>`
  }
  return `<div class="page"><div class="page-inner">${head}${problemsNote(data.probleme)}${nav}${body}</div></div>`
}
const ASSET_KIND = { 'chat-memory': 'Gesprächswissen', skill: 'Fähigkeit', wiki: 'Dokumentation', 'code-graph': 'Code-Übersicht' }
const ASSET_STATUS = { active: ['good', 'aktiv'], draft: ['', 'Entwurf'], verified: ['info', 'geprüft'], archived: ['', 'archiviert'] }
const VISIBILITY = { private: 'privat', agent: 'nur zugewiesene Spezialisten', restricted: 'eingeschränkt', team: 'Team' }
const FACT_KIND = { fact: 'Fakt', preference: 'Vorliebe', decision: 'Entscheidung', procedure: 'Ablauf' }
const FACT_STATUS = { canonical: ['good', 'bestätigt'], candidate: ['', 'Vorschlag'], disputed: ['warn', 'umstritten'], retracted: ['', 'zurückgezogen'] }
function wissenBody() {
  const { data, error } = viewState('wissen')
  if (error && !data) return viewErrorBlock(error)
  if (!data) return skeletonSection('Wissen')
  const { data: memory, catalog } = data
  const room = currentRoom()
  const equipped = new Set(room?.memoryAssetIds || [])
  return `<section class="section"><div class="section-head"><h2>${icon('book')}Wissenspakete</h2><button class="secondary" data-action="new-memory-asset">${icon('plus', 'sm')}Paket anlegen</button></div>
    <div class="section-body"><p class="section-note">Ein Paket wird nur geladen, wenn es aktiv und einem Raum, Spezialisten oder dir zugewiesen ist${room ? ` – Zuweisung hier gilt für den Raum „${esc(room.title)}“` : ''}.</p>
    <div class="tiles">${(catalog.assets || []).map(asset => `<article class="tile asset-card ${equipped.has(asset.id) ? 'equipped' : ''}"><header><div><h3>${esc(asset.name)}</h3><div class="sub">${esc(ASSET_KIND[asset.kind] || asset.kind)} · Version ${asset.version} · ${esc(VISIBILITY[asset.visibility] || asset.visibility)}</div></div><span class="pill ${(ASSET_STATUS[asset.status] || [''])[0]}">${esc((ASSET_STATUS[asset.status] || ['', asset.status])[1])}</span></header><p>${esc(asset.description || asset.content || '')}</p>${room ? `<button class="${equipped.has(asset.id) ? 'secondary' : 'ghost'}" data-memory-equip="${attr(asset.id)}" data-equipped="${equipped.has(asset.id)}">${equipped.has(asset.id) ? 'Aus dem Raum nehmen' : 'Dem Raum zuweisen'}</button>` : ''}</article>`).join('') || '<div class="empty-note">Noch keine Wissenspakete.</div>'}</div></div></section>
    <section class="section"><div class="section-head"><h2>Bestätigte Fakten</h2><span class="section-note">${fmtNumber(memory.records?.length || 0)} Einträge</span></div>
      <div class="rows">${(memory.records || []).slice(0, 50).map(record => `<div class="row"><div><div class="row-title plain">${esc(record.content)}</div><div class="row-sub">${esc(FACT_KIND[record.kind] || record.kind)} · ${Math.round(Number(record.confidence || 0) * 100)} % sicher · Quelle: ${esc(record.provenance?.at(-1)?.source || '—')}</div></div><div class="row-side"><span class="pill ${(FACT_STATUS[record.status] || [''])[0]}">${esc((FACT_STATUS[record.status] || ['', record.status])[1])}</span></div></div>`).join('') || '<div class="row"><div class="row-sub">Noch keine bestätigten Fakten.</div></div>'}</div></section>`
}

// ── Mehr ────────────────────────────────────────────────────
function moreView() {
  return `<div class="page"><div class="page-inner">${pageHead('Mehr', 'Fachwerkzeuge', 'Für Nachweise, Spezialisten und Einrichtung. Im Alltag nicht nötig – Xaventra nutzt das alles selbst.')}
    <div class="tiles">${Object.entries(MORE_PAGES).map(([id, page]) => `<button class="tile tile-link" data-section="${id}"><span class="tile-icon">${icon(page.icon)}</span><h3>${esc(page.title)}</h3><p>${esc(page.text)}</p></button>`).join('')}</div></div></div>`
}
function subPage(id, content) {
  const page = MORE_PAGES[id]
  return `<div class="page"><div class="page-inner"><button class="back-link" data-section="mehr">${icon('back', 'sm')}Mehr</button>${content}</div></div>`
}

function botsView() {
  const bots = state.bootstrap.bots || []
  return `<header class="page-head"><div><h1>Spezialisten</h1><p>Aufgaben-Profile von Xaventra sowie angebundene Hermes- und OpenClaw-Agenten. Externe Antworten gelten nie als Werkzeug-Beleg.</p></div><div class="head-actions"><button class="secondary" data-action="add-external">${icon('plus', 'sm')}Agent anbinden</button></div></header>
    <div class="grid">${bots.map(bot => `<article class="bot-card"><div class="card-title"><div class="avatar" data-color="${attr(bot.color)}">${esc(bot.avatar)}</div><div><h2>${esc(bot.name)}</h2><span class="badge ${bot.source === 'nova' ? 'good' : 'warn'}">${esc(bot.source)}</span></div></div><p class="row-sub">${esc(bot.description)}</p><dl class="details"><dt>Bereich</dt><dd>${esc(bot.specialization)}</dd><dt>Autonomie</dt><dd>${esc(bot.autonomy)}</dd><dt>Modell</dt><dd>${esc(bot.modelPolicy?.mode || 'auto')}</dd><dt>Knoten</dt><dd>${esc(bot.preferredNodeIds?.join(', ') || 'automatisch')}</dd></dl></article>`).join('')}</div>`
}

function nodesView() {
  const inventory = state.bootstrap.inventory || { nodes: [], enrollments: [] }
  return `<header class="page-head"><div><h1>Knoten aufnehmen</h1><p>Jeder Xaventra-Knoten läuft auf einem echten Gerät. Neue Knoten sind weder Main-fähig noch Telegram-berechtigt; die Aufnahme braucht einen verifizierten SSH-Fingerabdruck und deine Freigabe.</p></div><div class="head-actions"><button class="primary" data-action="add-node">${icon('plus', 'sm')}Knoten aufnehmen</button></div></header>
    <div class="grid">${(inventory.nodes || []).map(node => `<article class="node-card"><div class="card-title"><div><h2>${esc(node.name || node.id)}</h2><span class="badge ${['online', 'active'].includes(String(node.status || node.lifecycle)) ? 'good' : 'bad'}">${esc(node.lifecycle || node.status)}</span></div></div><dl class="details"><dt>ID</dt><dd class="mono">${esc(node.id)}</dd><dt>Host</dt><dd>${esc(node.host || '—')}</dd><dt>Version</dt><dd>${esc(node.version || '—')}</dd><dt>Werkzeuge</dt><dd>${fmtNumber(node.tools)}</dd><dt>Laufzeiten</dt><dd>${esc((node.runtimes || []).map(r => `${r.type}:${r.status}`).join(', ') || '—')}</dd><dt>Main</dt><dd>${node.mainEligible ? 'geeignet' : 'gesperrt'}</dd></dl></article>`).join('')}</div>
    ${(inventory.enrollments || []).length ? `<h2>Offene Aufnahmen</h2><div class="grid">${inventory.enrollments.map(enrollmentCard).join('')}</div>` : ''}`
}

function modulesView() {
  const modules = state.bootstrap.modules || []
  return `<header class="page-head"><div><h1>Studio</h1><p>Arbeitsräume für einzelne Fähigkeiten. Ein Raum öffnet sich als Unterhaltung mit passenden Spezialisten.</p></div></header>
    <div class="grid">${modules.map(module => `<article class="bot-card"><div class="card-title"><div class="avatar">${esc(String(module.category || '?').slice(0, 1).toUpperCase())}</div><div><h2>${esc(module.name)}</h2><span class="badge ${module.status === 'ready' ? 'good' : module.status === 'partial' ? 'warn' : 'bad'}">${esc(module.status)}</span></div></div><p class="row-sub">${esc(module.description)}</p><dl class="details"><dt>Bereit</dt><dd>${esc(module.availableTools?.join(', ') || '—')}</dd><dt>Fehlt</dt><dd>${esc(module.missingTools?.join(', ') || 'nichts')}</dd></dl>${module.limitation ? `<p class="row-sub">${esc(module.limitation)}</p>` : ''}<div class="toolbar"><button class="secondary" data-launch-module="${attr(module.id)}">Arbeitsraum öffnen</button></div></article>`).join('') || '<div class="card"><p>Keine Module gemeldet.</p></div>'}</div>`
}

function enrollmentCard(entry) {
  return `<article class="node-card"><div class="card-title"><div><h2>${esc(entry.displayName)}</h2><span class="badge warn">${esc(entry.status)}</span></div></div><dl class="details"><dt>Knoten</dt><dd>${esc(entry.nodeId)}</dd><dt>Ziel</dt><dd>${esc(entry.sshUser)}@${esc(entry.host)}:${entry.sshPort}</dd><dt>Rolle</dt><dd>${esc(entry.role)}</dd><dt>Laufzeit</dt><dd>${esc(entry.runtime)}</dd></dl><div class="toolbar">${entry.status === 'draft' ? `<button class="primary" data-enrollment-action="approve" data-id="${attr(entry.id)}">Freigeben</button>` : ''}${entry.status === 'approved' ? `<button class="primary" data-enrollment-action="ready" data-id="${attr(entry.id)}">Aufnahme vorbereiten</button>` : ''}${!['cancelled', 'verified'].includes(entry.status) ? `<button class="danger-button" data-enrollment-action="cancel" data-id="${attr(entry.id)}">Abbrechen</button>` : ''}</div></article>`
}

function securityView() {
  const security = state.bootstrap.security || {}
  const red = security.redTeam
  return `<header class="page-head"><div><h1>Abwehr</h1><p>Defensive Vorfallsarbeit mit Belegkette. Der Selbsttest greift ausschließlich Xaventras eigene Schutzschichten an.</p></div><div class="head-actions"><button class="secondary" data-action="run-red-team">${icon('shield', 'sm')}Selbsttest starten</button></div></header>
    <div class="metric-grid"><div class="metric"><strong>${security.blueTeamIncidents?.length || 0}</strong><span>Vorfälle</span></div><div class="metric"><strong>${red?.score ?? '—'}</strong><span>Selbsttest-Wert</span></div><div class="metric"><strong>${red?.vectorsTested || 0}</strong><span>geprüfte Angriffswege</span></div><div class="metric"><strong>${red?.bypasses?.filter(item => item.bypassed).length || 0}</strong><span>Durchbrüche</span></div></div>
    <div class="grid">${(security.blueTeamIncidents || []).map(incident => `<article class="bot-card"><div class="card-title"><div><h2>${esc(incident.title)}</h2><span class="badge ${incident.status === 'closed' ? 'good' : 'warn'}">${esc(incident.status)}</span></div></div><dl class="details"><dt>Schwere</dt><dd>${esc(incident.severity)}</dd><dt>Bereich</dt><dd>${esc(incident.scope)}</dd><dt>Belege</dt><dd>${incident.evidence?.length || 0}</dd><dt>Aktualisiert</dt><dd>${fmtTime(incident.updatedAt)}</dd></dl></article>`).join('') || '<div class="card"><h3>Keine offenen Vorfälle</h3></div>'}</div>`
}

async function loadTrust() {
  try {
    const [data, repairs] = await Promise.all([
      api.get('/api/desktop/trust/runs?limit=100'),
      api.get('/api/desktop/trust/repairs?limit=100').catch(() => null),
    ])
    if (state.section !== 'trust') return
    const repairCards = (repairs?.proposals || []).map(item => {
      const evidence = item.evidence || {}
      const activation = item.activation || null
      const complete = ['verified', 'reproductionPassed', 'regressionPassed', 'cleanupVerified', 'rollbackPassed', 'recoveryPassed'].every(key => evidence[key] === true)
      const receipt = activation ? `<dt>Live-Nachweis</dt><dd>${activation.independentlyVerified ? 'unabhängig bestätigt' : esc(activation.status || 'offen')}</dd><dt>Release</dt><dd class="mono">${esc(activation.previousReleaseId || '—')} → ${esc(activation.releaseId || '—')}</dd><dt>Versuch</dt><dd class="mono">${esc(activation.attemptId || '—')}</dd>` : ''
      return `<article class="run-card repair-card"><div class="card-title"><div><h2>${esc(item.description || item.file)}</h2><span class="badge ${item.status === 'applied' ? 'good' : item.status === 'rolled-back' || item.status === 'blocked' ? 'bad' : 'warn'}">${esc(item.status)}</span></div></div><dl class="details"><dt>Datei</dt><dd class="mono">${esc(item.file)}</dd><dt>Doctor-Fall</dt><dd class="mono">${esc(item.doctorCorrelation?.caseId || '—')}</dd><dt>Sandbox</dt><dd>${evidence.verified ? 'bestanden' : 'offen'}</dd><dt>Reproduktion</dt><dd>${evidence.reproductionPassed ? 'bestanden' : 'offen'}</dd><dt>Regression</dt><dd>${evidence.regressionPassed ? 'bestanden' : 'offen'}</dd><dt>Rollback</dt><dd>${evidence.rollbackPassed ? 'bestanden' : 'offen'}</dd><dt>Recovery</dt><dd>${evidence.recoveryPassed ? 'bestanden' : 'offen'}</dd><dt>Candidate</dt><dd class="mono">${esc(String(evidence.candidateHash || '—').slice(0, 16))}</dd>${receipt}</dl>${item.status === 'queued' ? `<button class="primary full-button" data-repair-approve="${attr(item.id)}" ${!repairs.authoritative || !complete ? 'disabled' : ''}>PATCH_GATE freigeben</button>` : ''}</article>`
    }).join('')
    const labels = { total: 'Läufe', running: 'laufen', awaitingApproval: 'warten auf Freigabe', completed: 'fertig', failed: 'fehlgeschlagen', verified: 'geprüft' }
    document.querySelector('#page').innerHTML = subPage('trust', `<header class="page-head"><div><h1>Belege & Reparaturen</h1><p>Keine Selbsteinschätzung: Status, Werkzeuge, Tests, Kosten und Prüfergebnis stammen aus der Ergebnisakte.</p></div></header>
      <div class="metric-grid">${Object.entries(data.summary || {}).map(([key, value]) => `<div class="metric"><strong>${fmtNumber(value)}</strong><span>${esc(labels[key] || key)}</span></div>`).join('')}</div>
      ${repairs ? `<div class="section-heading"><div><div class="eyebrow">Doctor-Selbstreparatur</div><h2>Sandbox-geprüfte Reparaturen</h2></div><span class="badge ${repairs.authoritative ? 'good' : 'bad'}">${repairs.authoritative ? 'Main gefenct' : 'nicht autoritativ'}</span></div><div class="grid repair-grid">${repairCards || '<div class="card"><h3>Keine Doctor-Reparatur wartet</h3></div>'}</div>` : ''}
      <div class="section-heading"><div><div class="eyebrow">Ergebnisakte</div><h2>Arbeitsläufe</h2></div></div>
      <div class="grid">${(data.runs || []).map(run => `<article class="run-card" data-run-id="${attr(run.runId)}"><div class="card-title"><div><h2>${esc(run.contract?.goal || run.runId)}</h2><span class="badge ${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${esc(run.status)}</span></div></div><dl class="details"><dt>Lauf</dt><dd class="mono">${esc(run.runId)}</dd><dt>Modell</dt><dd>${esc(run.model || '—')}</dd><dt>Knoten</dt><dd>${esc(run.node || '—')}</dd><dt>Werkzeuge</dt><dd>${run.tools?.length || 0}</dd><dt>Tests</dt><dd>${run.tests?.length || 0}</dd><dt>Geprüft</dt><dd>${run.validation?.success ? 'ja' : 'nein'}</dd><dt>Kosten</dt><dd>$${Number(run.totalCostUsd || 0).toFixed(6)}</dd></dl></article>`).join('') || '<div class="card"><h3>Noch keine Läufe für diesen Benutzer</h3></div>'}</div>`)
    bind()
  } catch (error) { fail(error) }
}

// ── Einstellungen ───────────────────────────────────────────
function settingsView() {
  const connection = state.connection || {}
  const control = state.bootstrap?.controlPlane || {}
  const theme = connection.theme || 'system'
  return `<div class="page"><div class="page-inner">${pageHead('Einstellungen', 'Verbindung und Darstellung', WEB ? 'Im Browser bleibt das Token nur in diesem Tab; Darstellung und Benutzer merkt sich dieser Browser.' : 'Was hier steht, bleibt auf diesem Gerät. Das Token liegt verschlüsselt im Schlüsselbund des Betriebssystems.')}
    <form class="form settings-grid" id="settings-form">
      <section class="card settings-card"><h2>Verbindung</h2><label>Adresse des Mains<input name="endpoint" value="${attr(connection.endpoint || 'http://127.0.0.1:3011')}" required ${WEB ? 'readonly' : ''}></label><label>Benutzer<input name="principal" value="${attr(connection.principal || 'desktop-owner')}" required></label><label>Desktop-Token<input name="token" type="password" autocomplete="off" placeholder="${connection.hasToken ? 'Gespeichert – leer lassen zum Behalten' : 'Für den Owner-Zugang nötig'}"></label><p>${WEB ? 'Die Adresse ist im Browser immer dieser Main.' : connection.encryptionAvailable === true ? 'Verschlüsselung des Betriebssystems geprüft.' : connection.encryptionAvailable === false ? 'Keine Verschlüsselung verfügbar – ein Token wird nicht gespeichert.' : 'Der Schlüsselbund wird erst beim Speichern eines Tokens geprüft.'} Ohne Token sind „Heute“, „Arbeit“, „System“ und „Gedächtnis“ gesperrt.${WEB ? ' Im Browser bleibt das Token nur in diesem Tab und ist beim Schließen weg.' : ''}</p></section>
      <section class="card settings-card"><h2>Darstellung</h2><label>Farbschema<select name="theme"><option value="system" ${theme === 'system' ? 'selected' : ''}>Wie das System</option><option value="hell" ${theme === 'hell' ? 'selected' : ''}>Hell</option><option value="dunkel" ${theme === 'dunkel' ? 'selected' : ''}>Dunkel</option></select></label><label class="check-row"><input type="checkbox" name="compactMode" ${connection.compactMode ? 'checked' : ''}> Kompakte Unterhaltung</label><label class="check-row"><input type="checkbox" name="showInspector" ${connection.showInspector !== false ? 'checked' : ''}> Seitenleiste „Was gerade passiert“ in der Unterhaltung</label></section>
      <section class="card settings-card"><h2>Unterhaltung</h2><label>Wartezeit auf eine Antwort<select name="requestTimeoutMs"><option value="60000" ${connection.requestTimeoutMs === 60000 ? 'selected' : ''}>60 Sekunden</option><option value="120000" ${!connection.requestTimeoutMs || connection.requestTimeoutMs === 120000 ? 'selected' : ''}>120 Sekunden</option><option value="180000" ${connection.requestTimeoutMs === 180000 ? 'selected' : ''}>180 Sekunden</option><option value="300000" ${connection.requestTimeoutMs === 300000 ? 'selected' : ''}>300 Sekunden</option></select></label><label class="check-row"><input type="checkbox" name="sendOnEnter" ${connection.sendOnEnter !== false ? 'checked' : ''}> Enter sendet, Shift+Enter macht eine neue Zeile</label></section>
      ${WEB ? '<section class="card settings-card"><h2>Projektordner</h2><p>Lokale Projektordner und Bildschirmaufnahmen gibt es nur in der Desktop-App.</p></section>' : `<section class="card settings-card"><h2>Projektordner</h2><div class="workspace-setting"><strong>${esc(workspaceById(connection.activeWorkspaceId)?.name || 'Kein aktiver Ordner')}</strong><span>${fmtNumber(connection.workspaces?.length || 0)} verbundene Ordner</span></div><button class="secondary" type="button" id="settings-select-workspace">Ordner auswählen</button><p>Xaventra kann einen verbundenen Ordner nur auflisten, lesen und durchsuchen. Geheimnisse, Build-Ausgaben und Pfade außerhalb bleiben gesperrt.</p></section>`}
      <section class="card settings-card"><h2>Main</h2><dl class="details"><dt>Name</dt><dd>${esc(control.hostname || control.nodeId || 'nicht verbunden')}</dd><dt>Autoritativ</dt><dd>${control.authoritative ? 'ja' : 'nein'}</dd><dt>Main-Epoche</dt><dd>${esc(control.mainEpoch || '—')}</dd><dt>Dashboard</dt><dd>${esc(control.dashboardEpoch || '—')}</dd></dl><p>Die App verbindet sich nur mit einem aktuell gefencten Main.</p></section>
      <section class="card settings-card"><h2>Speichern</h2><p>Der Verbindungstest liest nur die Startdaten. Speichern ändert keine Rolle eines Knotens.</p><div class="toolbar"><button class="secondary" type="button" id="test-connection">Verbindung prüfen</button><button class="primary" type="submit">Speichern</button></div></section>
    </form></div></div>`
}

// ── Unterhaltung ────────────────────────────────────────────
function topbar(room) {
  const catalog = state.bootstrap.models || { models: [] }
  const routes = chatModels()
  const control = state.bootstrap.controlPlane || {}
  const selected = room?.modelMode === 'pinned' ? (room.pinnedRouteId || modelRouteId(routeForRoom(room)) || '') : 'auto'
  const active = routes.find(model => model.id === catalog.activeModel && model.status === 'running')
  return `<header class="topbar">
    <div class="room-heading"><h1>${esc(room?.title || 'Unterhaltung')}</h1><p>${esc(room?.topic || (isStandardMode() ? 'Ich bin da. Frag mich einfach.' : 'Sag in normaler Sprache, was erreicht werden soll.'))}</p></div>
    <span class="pill good main-presence" title="Main">${esc(control.hostname || control.nodeId || 'Main')}</span>
    ${room ? `<select class="model-select" id="model-picker" aria-label="Modellwahl" aria-busy="${state.modelSaving.has(room.id)}" ${state.modelSaving.has(room.id) ? 'disabled title="Modellwahl wird gespeichert"' : ''}>
      <option value="auto" ${selected === 'auto' ? 'selected' : ''}>Automatisch · ${esc(active ? modelLabel(active, true) : 'sie wählt selbst')}</option>
      ${routes.map(model => `<option value="${attr(modelRouteId(model))}" ${selected === modelRouteId(model) ? 'selected' : ''}>${esc(modelLabel(model))}</option>`).join('')}
    </select>` : ''}
  </header>`
}

function chatView() {
  const room = currentRoom()
  const rooms = state.bootstrap?.rooms || []
  const sidebar = `<aside class="sidebar" aria-label="Räume"><div class="panel-head"><h2>Räume</h2><button class="icon-button" data-action="new-room" title="Neuer Raum" aria-label="Neuer Raum">${icon('plus')}</button></div>
    <div class="room-list">${rooms.length ? rooms.map(item => `<button class="room ${item.id === state.roomId ? 'active' : ''}" data-room="${attr(item.id)}"><span class="room-title">${esc(item.title)}</span><span class="room-meta">${item.workspaceId ? 'Projekt' : 'Thema'}${item.memoryAssetIds?.length ? ` · ${item.memoryAssetIds.length} Wissenspakete` : ''}</span></button>`).join('') : '<p class="row-sub inset">Noch kein Raum.</p>'}</div></aside>`
  const layoutClass = `chat-layout ${state.connection?.showInspector === false ? 'inspector-hidden' : ''}`
  if (!room) return `<div class="${layoutClass}">${sidebar}<section class="conversation">${topbar(null)}<div class="empty"><div class="empty-mark">X</div><h2>Noch keine Unterhaltung</h2><p>Ein Raum hält ein Thema zusammen: Verlauf, Projektordner und Wissen.</p><button class="primary" data-action="new-room">Ersten Raum anlegen</button></div></section><aside class="inspector">${inspectorView()}</aside></div>`
  const bots = room.botIds.map(botById).filter(Boolean)
  const nodeIds = room.preferredNodeIds || []
  const workspace = workspaceById(room.workspaceId)
  const pendingMessage = state.busyRoomId === room.id ? state.pendingMessage : null
  return `<div class="${layoutClass}">${sidebar}<section class="conversation">${topbar(room)}
    <div class="workspace-context-bar ${WEB ? 'hidden' : ''}"><div>${icon('book', 'sm')}<strong>${esc(workspace?.name || 'Kein Projektordner')}</strong>${workspace?.path ? `<small>${esc(workspace.path)}</small>` : ''}</div><div class="workspace-actions">${(state.connection?.workspaces || []).length ? `<select id="workspace-picker" aria-label="Projektordner"><option value="">Ohne Ordner</option>${state.connection.workspaces.map(item => `<option value="${attr(item.id)}" ${room.workspaceId === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>` : ''}<button class="secondary" id="select-workspace">${workspace ? 'Anderer Ordner' : 'Ordner verbinden'}</button></div></div>
    <section class="messages" data-loading="${state.roomLoading === room.id}" aria-live="polite">
      ${state.messages.length || pendingMessage ? state.messages.map(messageView).join('') : `<div class="empty"><div class="empty-mark">${esc(bots[0]?.avatar || 'X')}</div><div class="eyebrow">Bereit</div><h2>${esc(room.title)}</h2><p>${esc(room.topic || 'Sag Xaventra in normaler Sprache, was erreicht werden soll. Sie entscheidet selbst, ob sie Gedächtnis, Modell oder Werkzeuge braucht.')}</p><div class="prompt-grid"><button data-prompt="Was hast du heute erledigt?">Was hast du heute erledigt?</button><button data-prompt="Was hast du gerade vor?">Was hast du vor?</button><button data-prompt="Was kannst du alles?">Was kannst du?</button></div></div>`}
      ${pendingMessage ? messageView(pendingMessage) : ''}
      ${state.busy && state.busyRoomId === room.id ? pendingReplyView() : ''}
    </section>
    <footer class="composer ${state.busy ? 'loading' : ''}">
      <div class="selection-row" aria-label="Aktive Spezialisten">
        ${bots.filter(bot => state.selectedBots.has(bot.id)).map(bot => `<span class="chip active">${esc(bot.name)}</span>`).join('')}
        <button class="chip" data-action="toggle-experts">${state.expertPanel ? 'Auswahl schließen' : '+ Spezialist'}</button>
        <span class="routing-note">${state.selectedNodes.size ? `${state.selectedNodes.size} Knoten festgelegt` : 'Knoten automatisch'}</span>
      </div>
      ${state.expertPanel ? `<div class="selection-row expert-picker"><span class="context-label">Spezialisten für diese Nachricht</span>${bots.map(bot => `<button class="chip ${state.selectedBots.has(bot.id) ? 'active' : ''}" data-toggle-bot="${attr(bot.id)}">${esc(bot.name)}${bot.source !== 'nova' ? ` · ${esc(bot.source)}` : ''}</button>`).join('')}<span class="context-label">Ausführender Knoten (optional)</span>${nodeIds.map(id => { const node = (state.bootstrap.inventory?.nodes || []).find(item => item.id === id || item.nodeId === id); return `<button class="chip ${state.selectedNodes.has(id) ? 'active' : ''}" data-toggle-node="${attr(id)}">${esc(node?.name || node?.displayName || id)}</button>` }).join('') || '<span class="routing-note">Automatisch über alle gesunden Knoten.</span>'}</div>` : ''}
      <form class="compose-box" id="compose-form"><textarea id="composer" data-room-id="${attr(room.id)}" placeholder="${isStandardMode() ? 'Schreib hier, was du brauchst …' : 'Was soll erreicht werden?'}" aria-label="Nachricht" ${state.busy || state.roomLoading ? 'disabled' : ''}></textarea><button class="send-button" type="submit" title="Senden" aria-label="Senden" ${state.busy || state.roomLoading ? 'disabled' : ''}>${state.busy ? '···' : icon('send')}</button></form>
      <div class="compose-context"><span>${state.connection?.sendOnEnter === false ? 'Enter neue Zeile · Pfeil sendet' : 'Enter sendet · Shift+Enter neue Zeile'}</span><span>${esc(workspace?.name || 'kein Projekt')}</span><span>${room.memoryAssetIds?.length || 0} Wissenspakete</span><span>${esc(routeForRoom()?.nodeId || 'automatisch')}</span></div>
    </footer></section><aside class="inspector" aria-label="Was gerade passiert">${inspectorView()}</aside></div>`
}

function pendingReplyView() {
  const seconds = Math.max(0, Math.floor((Date.now() - state.busySince) / 1000))
  return `<article class="message pending"><div class="avatar">X</div><div class="message-body"><div class="message-head"><span>Xaventra</span><span class="origin">in Arbeit</span><time data-busy-seconds>${seconds}s</time></div><div class="message-content" data-busy-stage>${esc(pendingStage(seconds))}</div><div class="progress-line"><span></span></div></div></article>`
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
  const actionLabel = evidence?.action?.awaitingApproval ? 'Freigabe nötig'
    : evidence?.action?.requiresTool && !evidence.action.fulfilled ? 'Ergebnis nicht verifiziert'
      : evidence?.action?.fulfilled ? 'Ergebnis verifiziert'
        : message.verifiedEvidence > 0 ? 'Evidence geprüft'
          : evidence?.tools?.some(tool => !tool.success) ? 'Tool fehlgeschlagen'
            : evidence?.action?.requiresTool === false ? 'Keine Tool-Evidence nötig' : 'Evidenzstatus unbekannt'
  return `<article class="message ${isUser ? 'user' : ''}">
    <div class="avatar" ${bot?.color ? `data-color="${attr(bot.color)}"` : ''}>${esc(isUser ? 'A' : bot?.avatar || '!')}</div>
    <div class="message-body"><div class="message-head"><span>${esc(label)}</span>${origin ? `<span class="origin">${esc(origin)}</span>` : ''}${message.model ? `<span class="origin">${esc(message.model)}</span>` : ''}<time>${fmtTime(message.createdAt)}</time></div><div class="message-content">${formatMessage(message.content)}</div>${!isUser && (message.runId || evidence) ? `<div class="evidence-strip"><span class="evidence-state ${message.verifiedEvidence > 0 ? 'verified' : ''}">${esc(actionLabel || 'Keine Tool-Evidence nötig')}</span>${evidence?.tools?.map(tool => `<span class="tool-pill ${tool.success ? 'ok' : 'failed'}">${tool.success ? '✓' : '×'} ${esc(tool.name)}</span>`).join('') || ''}${evidence?.durationMs ? `<span>${fmtNumber(evidence.durationMs / 1000, 1)}s</span>` : ''}${message.runId ? `<button class="run-link" data-run-id="${attr(message.runId)}">Beleg ansehen</button>` : ''}</div>` : ''}</div>
  </article>`
}

function inspectorView() {
  const room = currentRoom()
  const models = state.bootstrap?.models
  const control = state.bootstrap?.controlPlane || {}
  const recent = [...(state.messages || [])].reverse().find(message => message.authorType === 'bot' && message.evidence)
  const pinned = routeForRoom(room)
  const tasks = state.views.heute?.jetzt?.aufgaben || []
  const open = openCardCount()
  return `<div class="card"><div class="eyebrow">Gerade</div><h3>${tasks.length ? esc(tasks[0].text) : 'Keine laufende Aufgabe'}</h3>${open ? `<p><button class="link-button" data-section="heute">${open} offene Frage${open === 1 ? '' : 'n'} unter „Heute“</button></p>` : ''}</div>
  <div class="card"><div class="eyebrow">Modell</div><h3>${esc(pinned ? modelLabel(pinned, true) : `Automatisch · ${models?.activeModel || 'Router'}`)}</h3><p>${pinned ? `${esc(pinned.runtime || pinned.provider)} · ${pinned.tokensPerSecond ? `${fmtNumber(pinned.tokensPerSecond, 1)} tok/s` : 'Tempo noch nicht gemessen'}` : 'Sie wählt das Modell nach belegten Ergebnissen.'}</p></div>
  <div class="card"><div class="eyebrow">Letzter Arbeitslauf</div><h3>${recent?.verifiedEvidence ? `${recent.verifiedEvidence} geprüfte Ergebnisse` : 'Noch kein Werkzeug-Beleg'}</h3><p>${recent?.evidence?.tools?.length ? recent.evidence.tools.map(tool => `${tool.success ? '✓' : '×'} ${esc(tool.name)}`).join(' · ') : 'Wenn sie ein Werkzeug benutzt, steht der Beleg direkt an der Antwort.'}</p>${recent?.runId ? `<button class="secondary run-card-link" data-run-id="${attr(recent.runId)}">Beleg öffnen</button>` : ''}</div>
  <div class="card"><div class="eyebrow">Main</div><h3>${esc(control.hostname || control.nodeId || 'Main')}</h3><p class="epoch">${control.authoritative ? `gefenct · Epoche ${esc(control.mainEpoch || '—')}` : 'nicht autoritativ'}</p></div>`
}

// ── Steuerung durch Xaventra (desktop_control) ─────────────
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
      if (!KNOWN_SECTIONS.has(SECTION_ALIAS[payload.section] || payload.section)) throw new Error('Unbekannter Bereich')
      if (payload.section === 'memory') state.tabs.gedaechtnis = 'wissen'
      state.section = normalizeSection(payload.section)
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
      state.viewAt = {}
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
  document.querySelector('#app').innerHTML = `<div class="connection-error"><div class="card"><div class="eyebrow">${connecting ? 'Verbindung wird hergestellt' : 'Verbindung nicht verfügbar'}</div><h1>${connecting ? 'Mit Xaventra verbinden' : 'Xaventra ist nicht erreichbar'}</h1><p role="status">${esc(errorText(error))}</p><p>Prüfe Adresse und Token. Die Einstellungen sind auch ohne laufenden Main erreichbar.</p><div class="toolbar"><button class="primary" id="open-settings">Verbindung einrichten</button><button class="secondary" id="retry">Erneut versuchen</button></div></div></div>`
  document.querySelector('#open-settings').addEventListener('click', async () => {
    ++state.connectionAttempt
    state.connection = await window.novaDesktop.config.get()
    applyTheme()
    state.bootstrap = { rooms: [], bots: [], models: { models: [] }, inventory: { nodes: [], enrollments: [] }, security: {} }
    state.section = 'settings'
    render()
  })
  document.querySelector('#retry').addEventListener('click', init)
}

function bind() {
  // CSP keeps style-src 'self': widths and colours are set through the CSSOM.
  document.querySelectorAll('[data-pct]').forEach(node => { node.style.width = `${Math.max(0, Math.min(100, Number(node.dataset.pct) || 0))}%` })
  document.querySelectorAll('[data-color]').forEach(node => { if (/^#[0-9a-f]{3,8}$/i.test(node.dataset.color)) node.style.borderColor = node.dataset.color })
  document.querySelectorAll('[data-section]').forEach(node => node.addEventListener('click', () => navigate(node.dataset.section)))
  document.querySelectorAll('[data-refresh]').forEach(node => node.addEventListener('click', async () => {
    const name = node.dataset.refresh
    node.disabled = true
    await ensureView(name, { force: true })
    if (name === 'system') await ensureView('vms', { force: true })
    if (name === 'gedaechtnis' && state.tabs.gedaechtnis === 'wissen') await ensureView('wissen', { force: true })
    render()
  }))
  document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () => {
    const [area, tab] = node.dataset.tab.split(':')
    state.tabs[area] = tab
    render()
  }))
  document.querySelector('[data-action="toggle-thoughts"]')?.addEventListener('click', () => { state.showAllThoughts = !state.showAllThoughts; render() })
  document.querySelectorAll('[data-card-answer]').forEach(node => node.addEventListener('click', () => answerCard(node.dataset.cardId, node.dataset.cardAnswer)))
  document.querySelectorAll('[data-desktop-open]').forEach(node => node.addEventListener('click', () => openDesktop(node.dataset.desktopOpen, node.dataset.mode)))
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
  document.querySelectorAll('[data-repair-approve]').forEach(node => node.addEventListener('click', () => showRepairApproval(node.dataset.repairApprove)))
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
      toast(authoritative ? `Main ${data.controlPlane.hostname || data.controlPlane.nodeId} ist erreichbar und autoritativ.` : 'Der Endpunkt antwortet, ist aber nicht autoritativ.', !authoritative)
    } catch (error) { fail(error) }
  })
  document.querySelectorAll('[data-enrollment-action]').forEach(node => node.addEventListener('click', () => enrollmentAction(node.dataset.id, node.dataset.enrollmentAction)))
  document.querySelectorAll('[data-memory-equip]').forEach(node => node.addEventListener('click', () => toggleRoomMemoryAsset(node.dataset.memoryEquip, node.dataset.equipped === 'true')))
}

function showRepairApproval(proposalId) {
  showModal('Doctor-Reparatur freigeben', `<form class="form" id="repair-approval-form"><p>Die Diagnose ist automatisch. Diese Freigabe autorisiert ausschließlich den bereits gebundenen, sandbox-geprüften Patch. Der Token wird nur für diesen Request übertragen und nicht gespeichert.</p><label>PATCH_GATE Token<input name="approvalToken" type="password" autocomplete="off" required></label><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Gebundenen Patch freigeben</button></div></form>`)
  document.querySelector('#repair-approval-form').addEventListener('submit', async event => {
    event.preventDefault()
    const approvalToken = new FormData(event.target).get('approvalToken')
    try {
      await api.post(`/api/desktop/trust/repairs/${encodeURIComponent(proposalId)}/approve`, { approvalToken })
      closeModal(); await loadTrust(); toast('Reparatur wurde vom PATCH_GATE angenommen.')
    } catch (error) { fail(error) }
  })
}

async function toggleRoomMemoryAsset(assetId, equipped) {
  const room = currentRoom()
  if (!room) return
  const ids = new Set(room.memoryAssetIds || [])
  equipped ? ids.delete(assetId) : ids.add(assetId)
  try {
    const saved = await api.patch(`/api/desktop/rooms/${encodeURIComponent(room.id)}`, { memoryAssetIds: [...ids] })
    state.bootstrap.rooms[state.bootstrap.rooms.findIndex(item => item.id === saved.id)] = saved
    toast(equipped ? 'Paket aus dem Raum genommen.' : 'Paket ist diesem Raum zugewiesen.')
    await ensureView('wissen', { force: true })
    render()
  } catch (error) { fail(error) }
}

function showMemoryAsset() {
  showModal('Neues Wissenspaket', `<form class="form" id="memory-asset-form"><label>Name<input name="name" required maxlength="120" placeholder="z. B. Release-Wissen"></label><label>Art<select name="kind"><option value="chat-memory">Gesprächswissen</option><option value="skill">Geprüfte Fähigkeit</option><option value="wiki">Dokumentation</option><option value="code-graph">Code-Übersicht</option></select></label><label>Wann hilfreich<input name="description" maxlength="500" placeholder="Wann dieses Wissen gebraucht wird"></label><label>Inhalt<textarea name="content" rows="7" maxlength="40000" required placeholder="Nur bestätigte Fakten, Entscheidungen oder geprüfte Abläufe."></textarea></label><label>Sichtbarkeit<select name="visibility"><option value="private">Privat</option><option value="agent">Nur gezielt zugewiesene Spezialisten</option><option value="restricted">Eingeschränkt</option><option value="team">Team</option></select></label><label>Status<select name="status"><option value="draft">Entwurf</option><option value="verified">Geprüft</option><option value="active">Aktiv</option></select></label><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Anlegen</button></div></form>`)
  document.querySelector('#memory-asset-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.target).entries())
    try { await api.post('/api/desktop/memory-assets', { ...form, source: 'nova-desktop' }); closeModal(); await loadBootstrap(); await ensureView('wissen', { force: true }); render(); toast('Wissenspaket angelegt.') } catch (error) { fail(error) }
  })
}

async function updateRoomWorkspace(event) {
  try {
    const workspaceId = event.target.value
    state.connection = await window.novaDesktop.workspace.setActive(workspaceId)
    const room = await api.patch(`/api/desktop/rooms/${encodeURIComponent(state.roomId)}`, { workspaceId })
    const index = state.bootstrap.rooms.findIndex(item => item.id === room.id)
    state.bootstrap.rooms[index] = room
    toast(workspaceId ? `Ordner ${workspaceById(workspaceId)?.name || ''} gehört jetzt zu diesem Raum.` : 'Ordner vom Raum gelöst.')
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
    if (workspaceId) toast(`Ordner ${workspaceById(workspaceId)?.name || ''} verbunden. Xaventra kann ihn jetzt lesen und durchsuchen.`)
  } catch (error) { fail(error) }
}

async function openRunDetail(runId) {
  try {
    const run = await api.get(`/api/desktop/trust/runs/${encodeURIComponent(runId)}`)
    const tools = run.tools || []
    showModal('Geprüfter Arbeitslauf', `<div class="run-detail"><div class="run-summary"><span class="badge ${run.status === 'completed' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}">${esc(run.status)}</span><h3>${esc(run.contract?.goal || run.runId)}</h3><p class="mono">${esc(run.runId)}</p></div><dl class="details"><dt>Modell</dt><dd>${esc(run.model || '—')}</dd><dt>Knoten</dt><dd>${esc(run.node || '—')}</dd><dt>Prüfung</dt><dd>${run.validation?.success ? 'bestanden' : 'nicht bestanden'}</dd><dt>Kosten</dt><dd>$${Number(run.totalCostUsd || 0).toFixed(6)}</dd></dl><div class="evidence-list">${tools.map(tool => `<article><span class="tool-pill ${tool.success === false ? 'failed' : 'ok'}">${tool.success === false ? '×' : '✓'} ${esc(tool.toolName || tool.tool || 'tool')}</span><p>${esc(String(tool.result || '').slice(0, 500))}</p></article>`).join('') || '<p>Dieser Lauf brauchte keine Werkzeuge.</p>'}</div></div>`)
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
  const roomId = state.roomId
  const bootstrap = state.bootstrap
  if (state.modelSaving.has(roomId)) return
  state.modelSaving.add(roomId)
  event.target.disabled = true
  event.target.setAttribute('aria-busy', 'true')
  try {
    const selected = modelByRoute(value)
    if (value !== 'auto' && !selected) throw new Error('Diese Modellroute ist nicht mehr verifiziert.')
    const room = await api.patch(`/api/desktop/rooms/${encodeURIComponent(roomId)}`, value === 'auto'
      ? { modelMode: 'auto', pinnedModel: '', pinnedRouteId: '', preferredNodeIds: [] }
      : { modelMode: 'pinned', pinnedModel: selected.id, pinnedRouteId: modelRouteId(selected), preferredNodeIds: [selected.nodeId] })
    if (state.bootstrap !== bootstrap) return
    const index = bootstrap.rooms.findIndex(item => item.id === room.id)
    if (index >= 0) bootstrap.rooms[index] = room
    if (state.roomId === roomId) state.selectedNodes = new Set(room.preferredNodeIds || [])
    toast(value === 'auto' ? 'Sie wählt das Modell wieder selbst.' : `Modell fixiert: ${modelLabel(selected, true)}.`)
  } catch (error) { fail(error) }
  finally {
    state.modelSaving.delete(roomId)
    if (state.section === 'chat' && state.bootstrap === bootstrap) render()
  }
}

function showModal(title, body) {
  const root = document.querySelector('#modal-root')
  const opener = document.activeElement
  root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${attr(title)}"><div class="modal-head"><h2>${esc(title)}</h2><button class="icon-button" data-close-modal aria-label="Schließen">${icon('x')}</button></div>${body}</section></div>`
  root.querySelectorAll('[data-close-modal]').forEach(node => node.addEventListener('click', closeModal))
  root.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target.classList.contains('modal-backdrop')) closeModal() })
  root.querySelector('.modal-backdrop').addEventListener('keydown', event => { if (event.key === 'Escape') closeModal() })
  root.dataset.opener = opener?.id || ''
  ;(root.querySelector('.modal input, .modal select, .modal textarea, .modal .primary') || root.querySelector('[data-close-modal]'))?.focus()
}
function closeModal() { document.querySelector('#modal-root').innerHTML = '' }

function showNewRoom() {
  showModal('Neuer Raum', `<form class="form" id="room-form"><label>Titel<input name="title" required maxlength="120" placeholder="z. B. Release 2.83"></label><label>Worum geht es?<textarea name="topic" rows="3" maxlength="500" placeholder="Ziel und Zusammenhang"></textarea></label><p>Xaventra ist die Ansprechpartnerin. Sie wählt Modell und Knoten selbst und zieht Spezialisten nur hinzu, wenn du sie in einer Nachricht auswählst.</p><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Anlegen</button></div></form>`)
  document.querySelector('#room-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target)
    try {
      const room = await api.post('/api/desktop/rooms', { title: form.get('title'), topic: form.get('topic'), botIds: ['nova'], preferredNodeIds: [], modelMode: 'auto' })
      closeModal(); state.roomId = room.id; state.section = 'chat'; await loadBootstrap(); render()
    } catch (error) { fail(error) }
  })
}

function showExternalBot() {
  showModal('Hermes- oder OpenClaw-Agent anbinden', `<form class="form" id="external-form"><label>Art<select name="kind"><option value="hermes">Hermes</option><option value="openclaw">OpenClaw</option></select></label><label>Name<input name="name" required maxlength="80" placeholder="Hermes Recherche"></label><label>Adresse<input name="baseUrl" required placeholder="https://gateway.example.net"></label><label>Modell / Agent-ID<input name="model" placeholder="hermes-agent oder openclaw/research"></label><label>Name der Token-Variable auf dem Main<input name="credentialEnv" required value="NOVA_EXTERNAL_AGENT_HERMES_TOKEN" pattern="NOVA_EXTERNAL_AGENT_[A-Z0-9_]+_TOKEN"></label><label>Anweisung<textarea name="instructions" rows="3" placeholder="Recherche mit Quellen; keine Werkzeug-Ausführung behaupten."></textarea></label><p>Der Token selbst geht nie über diese App. Lege ihn auf dem Main als Umgebungsvariable an.</p><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Anbinden</button></div></form>`)
  const formNode = document.querySelector('#external-form')
  formNode.querySelector('[name="kind"]').addEventListener('change', event => { formNode.querySelector('[name="credentialEnv"]').value = event.target.value === 'hermes' ? 'NOVA_EXTERNAL_AGENT_HERMES_TOKEN' : 'NOVA_EXTERNAL_AGENT_OPENCLAW_TOKEN' })
  formNode.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.target); const kind = form.get('kind'); const name = form.get('name')
    try {
      const connection = await api.post('/api/desktop/external-agents', { kind, name, baseUrl: form.get('baseUrl'), model: form.get('model'), credentialEnv: form.get('credentialEnv') })
      await api.post('/api/desktop/bots', { name, handle: `${kind}-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 32), avatar: kind === 'hermes' ? 'H' : 'O', color: '#14B8A6', description: `${kind} agent via ${connection.baseUrl}`, specialization: 'general', source: kind, externalConnectionId: connection.id, instructions: form.get('instructions'), toolPacks: [], deniedTools: [], preferredNodeIds: [], modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true })
      closeModal(); await loadBootstrap(); render(); toast(`${name} ist angebunden.`)
    } catch (error) { fail(error) }
  })
}

function showNodeEnrollment() {
  showModal('Knoten aufnehmen', `<form class="form" id="node-form"><label>Knoten-ID<input name="nodeId" required placeholder="nova-nas"></label><label>Anzeigename<input name="displayName" required placeholder="NAS"></label><label>Host / IP<input name="host" required placeholder="192.0.2.30"></label><label>SSH-Benutzer<input name="sshUser" required placeholder="nova"></label><label>SSH-Port<input name="sshPort" type="number" min="1" max="65535" value="22"></label><label>Verifizierter SSH-Fingerabdruck<input name="expectedHostKeyFingerprint" required placeholder="SHA256:..."></label><label>Rolle<select name="role"><option value="worker">Worker · kein Main, keine Kanäle</option><option value="standby">Standby · Main-Kandidat mit Fencing</option></select></label><label>Laufzeit<select name="runtime"><option value="docker">Gehärtetes Docker</option><option value="systemd">systemd</option></select></label><p>Nach deiner Freigabe folgt ein signierter, schrittweise geprüfter Ablauf. Freie SSH-Befehle gibt es nicht.</p><div class="toolbar"><button class="secondary" type="button" data-close-modal>Abbrechen</button><button class="primary" type="submit">Entwurf anlegen</button></div></form>`)
  document.querySelector('#node-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = Object.fromEntries(new FormData(event.target).entries()); form.sshPort = Number(form.sshPort)
    try { await api.post('/api/desktop/nodes/enrollments', form); closeModal(); await loadBootstrap(); render(); toast('Entwurf angelegt; installiert wurde noch nichts.') } catch (error) { fail(error) }
  })
}

async function enrollmentAction(id, action) {
  try { await api.post(`/api/desktop/nodes/enrollments/${encodeURIComponent(id)}/${action}`, {}); await loadBootstrap(); render(); toast(`Aufnahme: ${action}`) } catch (error) { fail(error) }
}

async function runRedTeam() {
  try { toast('Selbsttest läuft …'); await api.post('/api/desktop/security/red-team/run', {}); await loadBootstrap(); render(); toast('Selbsttest abgeschlossen.') } catch (error) { fail(error) }
}

async function forgeAction(id, action) {
  try {
    await api.post(`/api/desktop/forge/${encodeURIComponent(id)}/${action}`, {})
    await ensureView('gedaechtnis', { force: true }); render()
    toast(action === 'authorize-sandbox' ? 'Freigegeben: aktiv wird das Werkzeug nur mit grünen Tests.' : 'Werkzeug abgelehnt.')
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
    state.roomId = room.id; state.section = 'chat'; await loadBootstrap(); render()
    toast(`${module.name} ist als Raum geöffnet.`)
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
      theme: String(form.get('theme') || 'system'),
    })
    applyTheme()
    // Views belong to one connection and identity; never show stale owner data.
    state.views = {}; state.viewKeys = {}; state.viewAt = {}; state.viewErrors = {}
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
    state.section = isStandardMode() ? 'chat' : 'heute'; render(); startControlPolling(); startRefresh(); toast('Xaventra Desktop ist verbunden.')
  } catch (error) { fail(error) }
}

document.addEventListener('DOMContentLoaded', init)
