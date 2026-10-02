// Transport-Schicht der gemeinsamen Oberfläche.
// In der Desktop-App liefert preload.cjs `window.novaDesktop` (Electron-IPC,
// Token im Schlüsselbund, Netzwerk nur im Hauptprozess). Im Browser liefert
// der Main dieselben Dateien unter /app/ aus; dann ersetzt dieser Baustein
// die IPC durch fetch an denselben Ursprung mit dem Desktop-Token als Bearer.
// Das Token liegt nur in sessionStorage dieses Tabs (weg beim Schließen).
;(() => {
  if (window.novaDesktop) return
  const API_PATH = /^\/api\/desktop(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%-]+)*?(?:\?[a-zA-Z0-9._~!$&'()*+,;=:@%/?-]*)?$/
  const PREFS = 'xaventra.web.prefs'
  const TOKEN = 'xaventra.web.token'
  const CLIENT = 'xaventra.web.client'
  const read = (storage, key, fallback) => { try { return storage.getItem(key) ?? fallback } catch { return fallback } }
  const write = (storage, key, value) => { try { value === null ? storage.removeItem(key) : storage.setItem(key, value) } catch { /* private mode */ } }
  const prefs = () => { try { return JSON.parse(read(localStorage, PREFS, '{}')) || {} } catch { return {} } }
  const clientId = () => {
    let id = read(localStorage, CLIENT, '')
    if (!/^web-[a-f0-9-]{36}$/.test(id)) { id = `web-${crypto.randomUUID()}`; write(localStorage, CLIENT, id) }
    return id
  }
  const publicConfig = () => {
    const p = prefs()
    return {
      web: true, endpoint: location.origin, principal: String(p.principal || 'desktop-owner').slice(0, 200), clientId: clientId(),
      hasToken: Boolean(read(sessionStorage, TOKEN, '')), encryptionAvailable: null,
      requestTimeoutMs: Math.max(30_000, Math.min(300_000, Number(p.requestTimeoutMs) || 120_000)),
      sendOnEnter: p.sendOnEnter !== false, showInspector: p.showInspector !== false, compactMode: p.compactMode === true,
      theme: ['system', 'hell', 'dunkel'].includes(p.theme) ? p.theme : 'system', workspaces: [], activeWorkspaceId: undefined,
    }
  }
  async function request(method, path, body) {
    const value = String(path || '')
    if (!API_PATH.test(value) || value.split('?')[0].split('/').some(segment => /^(?:\.|%2e){1,2}$/i.test(segment))) throw new Error('Desktop API path is not allowed')
    const config = publicConfig()
    const token = read(sessionStorage, TOKEN, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), value === '/api/desktop/bootstrap' ? 5000 : config.requestTimeoutMs)
    try {
      const response = await fetch(value, {
        method, signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: {
          Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}), 'X-Nova-Principal': config.principal, 'X-Nova-Desktop-Client': config.clientId,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let data
      try { data = text ? JSON.parse(text) : null } catch { data = { error: text.slice(0, 500) } }
      if (!response.ok) throw new Error(String(data?.error || `Xaventra returned HTTP ${response.status}`).slice(0, 500))
      return data
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Zeitüberschreitung beim Main')
      throw error
    } finally { clearTimeout(timer) }
  }
  const unavailable = what => () => Promise.reject(new Error(`${what} gibt es nur in der Desktop-App.`))
  window.novaDesktop = Object.freeze({
    web: true,
    config: Object.freeze({
      get: async () => publicConfig(),
      set: async input => {
        const p = prefs()
        const next = {
          principal: String(input?.principal || p.principal || 'desktop-owner').trim().slice(0, 200),
          requestTimeoutMs: Number(input?.requestTimeoutMs || p.requestTimeoutMs || 120000),
          sendOnEnter: input?.sendOnEnter !== false, showInspector: input?.showInspector !== false, compactMode: input?.compactMode === true,
          theme: ['system', 'hell', 'dunkel'].includes(input?.theme) ? input.theme : p.theme || 'system',
        }
        write(localStorage, PREFS, JSON.stringify(next))
        if (typeof input?.token === 'string') write(sessionStorage, TOKEN, input.token ? input.token : null)
        return publicConfig()
      },
    }),
    api: Object.freeze({
      get: path => request('GET', path),
      post: (path, body) => request('POST', path, body),
      patch: (path, body) => request('PATCH', path, body),
      delete: path => request('DELETE', path),
    }),
    window: Object.freeze({ focus: async () => { window.focus(); return true } }),
    desktop: Object.freeze({ capture: unavailable('Bildschirmaufnahmen') }),
    // Im Browser öffnet der Einmal-Link einen neuen Tab – derselbe Weg wie aus Telegram.
    desktopDirect: Object.freeze({
      open: async input => {
        const mode = input?.mode === 'control' ? 'control' : 'view'
        const target = window.open('about:blank', '_blank')
        try {
          const issued = await request('POST', `/api/desktop/direct/${encodeURIComponent(String(input?.desktopId || ''))}/link`, { mode })
          const url = new URL(String(issued?.url || ''))
          if (url.protocol !== 'https:' || !/^\/desktop\/s\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) throw new Error('Desktop-Link ist ungültig')
          if (target) { target.opener = null; target.location.replace(url.toString()) }
          else throw new Error('Der Browser hat das neue Fenster blockiert.')
          return { ok: true, label: issued.label, mode, expiresAt: issued.expiresAt }
        } catch (error) { try { target?.close() } catch { /* ignore */ } throw error }
      },
    }),
    workspace: Object.freeze({
      select: unavailable('Projektordner'),
      setActive: unavailable('Projektordner'),
      execute: unavailable('Projektordner'),
    }),
  })
})()
