import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  OsEventTypeList,
  type EvenHubEvent,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { decide, renderHud, type Gesture, type HudFeed, type HudState } from './hud'

const SETTINGS_SLOT = 'xaventra.hud.v1'
interface Settings { url: string; token: string }

let bridge: EvenAppBridge
let settings: Settings = { url: '', token: '' }
const state: HudState = { feed: null, index: 0, confirm: null, message: '', online: false }
let started = false
let rendering: Promise<void> = Promise.resolve()
let confirmTimer: ReturnType<typeof setTimeout> | undefined

const $ = (id: string) => document.getElementById(id) as HTMLInputElement | null
const clock = () => new Date().toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function page() {
  const text = new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288, paddingLength: 6, borderWidth: 0,
    containerID: 1, containerName: 'hud', isEventCapture: 1, content: renderHud(state, clock()),
  })
  return { containerTotalNum: 1, textObject: [text], listObject: [] }
}

/** Renders are serialized: the BLE link must never get two at once. */
function render(): Promise<void> {
  rendering = rendering.then(async () => {
    try {
      if (!started) { started = true; await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page())) }
      else await bridge.rebuildPageContainer(new RebuildPageContainer(page()))
    } catch (error) { console.warn('[hud] render', error) }
  })
  const box = document.getElementById('state')
  if (box) box.textContent = renderHud(state, clock())
  return rendering
}

const headers = () => ({ Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' })
const base = () => settings.url.replace(/\/+$/, '')

async function poll(): Promise<void> {
  for (;;) {
    if (!settings.url || !settings.token) { state.online = false; await render(); await sleep(3_000); continue }
    try {
      const since = state.feed?.version ? `since=${encodeURIComponent(state.feed.version)}&` : ''
      const response = await fetch(`${base()}/hud?${since}wait=20`, { headers: headers(), cache: 'no-store' })
      if (response.status === 401) { state.online = false; state.message = 'Token falsch (401).'; await render(); await sleep(10_000); continue }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const feed = await response.json() as HudFeed
      const changed = feed.version !== state.feed?.version || !state.online
      state.feed = feed
      state.online = true
      if (state.index >= feed.cards.length) state.index = 0
      if (changed) await render()
    } catch (error) {
      state.online = false
      state.message = 'Keine Verbindung.'
      console.warn('[hud] poll', error)
      await render()
      await sleep(5_000)
    }
  }
}

async function answer(cardId: string, value: 'ja' | 'nein'): Promise<void> {
  state.confirm = null
  state.message = value === 'ja' ? 'Sende Ja …' : 'Sende Nein …'
  await render()
  try {
    const response = await fetch(`${base()}/hud/answer`, { method: 'POST', headers: headers(), body: JSON.stringify({ cardId, answer: value }) })
    const body = await response.json().catch(() => ({})) as { message?: string; error?: string }
    state.message = response.ok ? (body.message || 'Erledigt.') : (body.error || body.message || `Fehler ${response.status}`)
    if (response.ok && state.feed) state.feed = { ...state.feed, version: '', cards: state.feed.cards.filter(card => card.id !== cardId) }
  } catch {
    state.message = 'Senden fehlgeschlagen.'
  }
  state.index = 0
  await render()
}

function gestureOf(event: EvenHubEvent): Gesture | null {
  const text = event.textEvent
  if (text) {
    const type = text.eventType ?? 0
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) return 'up'
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'down'
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'double'
    if (type === OsEventTypeList.CLICK_EVENT) return 'tap'
  }
  const sys = event.sysEvent
  if (sys) {
    const type = sys.eventType ?? 0
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'double'
    if (type === OsEventTypeList.CLICK_EVENT) return 'tap'
  }
  return null
}

function onEvent(event: EvenHubEvent): void {
  const gesture = gestureOf(event)
  if (!gesture) return
  const action = decide(state, gesture)
  if (action.kind === 'answer') void answer(action.cardId, action.answer)
  else if (action.kind === 'confirm') {
    state.confirm = action.cardId
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => { state.confirm = null; void render() }, 4_000)
    void render()
  } else if (action.kind === 'move') { state.index = action.index; state.confirm = null; void render() }
  else if (action.kind === 'exit') void bridge.shutDownPageContainer(1)
}

async function loadSettings(): Promise<void> {
  try { const raw = await bridge.getLocalStorage(SETTINGS_SLOT); if (raw) settings = { ...settings, ...JSON.parse(raw) } } catch { /* first start */ }
  // Simulator only (vite dev): defaults from apps/even-g2/.env.local; never part of a build.
  if (import.meta.env.DEV && !settings.url) settings = { url: String(import.meta.env.VITE_XAVENTRA_URL || ''), token: String(import.meta.env.VITE_XAVENTRA_TOKEN || '') }
  const url = $('url'); const token = $('token')
  if (url) url.value = settings.url
  if (token) token.value = settings.token ? '••••••••' : ''
  document.getElementById('save')?.addEventListener('click', async () => {
    const nextUrl = ($('url')?.value || '').trim()
    const nextToken = ($('token')?.value || '').trim()
    if (nextUrl && !/^https:\/\//i.test(nextUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(nextUrl)) { state.message = 'Nur HTTPS (oder localhost im Simulator).'; await render(); return }
    settings = { url: nextUrl, token: nextToken && nextToken !== '••••••••' ? nextToken : settings.token }
    try { await bridge.setLocalStorage(SETTINGS_SLOT, JSON.stringify(settings)) } catch { /* memory only */ }
    state.feed = null; state.message = 'Gespeichert.'
    await render()
  })
}

async function boot(): Promise<void> {
  bridge = await waitForEvenAppBridge()
  await loadSettings()
  await render()
  bridge.onEvenHubEvent(onEvent)
  void poll()
}

boot().catch(error => console.error('[hud] boot failed', error))
