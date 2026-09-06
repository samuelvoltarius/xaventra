const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, screen, shell } = require('electron')
const { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync, statSync } = require('node:fs')
const { basename, extname, isAbsolute, join, relative, resolve } = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

let mainWindow = null
// Do not synchronously touch Keychain just to render connection settings.
// Availability is unknown until a credential operation explicitly requests it.
let credentialEncryptionAvailable = null

function secureStorageAvailable() {
  credentialEncryptionAvailable = safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
  return credentialEncryptionAvailable
}

const DEFAULT_PREFERENCES = Object.freeze({ requestTimeoutMs: 120_000, sendOnEnter: true, showInspector: true, compactMode: false })

function configPath() { return join(app.getPath('userData'), 'connection.json') }

function normalizeEndpoint(raw) {
  const value = new URL(String(raw || 'http://127.0.0.1:3011'))
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
  if (value.protocol !== 'https:' && !(value.protocol === 'http:' && loopback)) {
    throw new Error('Remote Xaventra endpoints require HTTPS')
  }
  value.username = ''
  value.password = ''
  value.pathname = value.pathname.replace(/\/+$/, '')
  value.search = ''
  value.hash = ''
  return value.toString().replace(/\/$/, '')
}

function readConfig() {
  try {
    if (!existsSync(configPath())) return { endpoint: 'http://127.0.0.1:3011', principal: 'desktop-owner', clientId: `desktop-${randomUUID()}`, ...DEFAULT_PREFERENCES }
    const value = JSON.parse(readFileSync(configPath(), 'utf8'))
    return {
      endpoint: normalizeEndpoint(value.endpoint),
      principal: String(value.principal || 'desktop-owner').trim().slice(0, 200),
      clientId: String(value.clientId || `desktop-${randomUUID()}`).trim().slice(0, 120),
      encryptedToken: typeof value.encryptedToken === 'string' ? value.encryptedToken : undefined,
      requestTimeoutMs: Math.max(30_000, Math.min(300_000, Number(value.requestTimeoutMs || DEFAULT_PREFERENCES.requestTimeoutMs))),
      sendOnEnter: value.sendOnEnter !== false,
      showInspector: value.showInspector !== false,
      compactMode: value.compactMode === true,
      workspaces: Array.isArray(value.workspaces) ? value.workspaces.filter(item => item?.id && item?.path).slice(0, 20).map(item => ({
        id: String(item.id).slice(0, 120), name: String(item.name || basename(item.path)).slice(0, 120), path: String(item.path),
      })) : [],
      activeWorkspaceId: typeof value.activeWorkspaceId === 'string' ? value.activeWorkspaceId.slice(0, 120) : undefined,
    }
  } catch {
    return { endpoint: 'http://127.0.0.1:3011', principal: 'desktop-owner', clientId: `desktop-${randomUUID()}`, ...DEFAULT_PREFERENCES }
  }
}

function writeConfig(input) {
  const current = readConfig()
  const next = {
    endpoint: normalizeEndpoint(input.endpoint || current.endpoint),
    principal: String(input.principal || current.principal || 'desktop-owner').trim().slice(0, 200),
    clientId: current.clientId || `desktop-${randomUUID()}`,
    encryptedToken: normalizeEndpoint(input.endpoint || current.endpoint) === current.endpoint ? current.encryptedToken : undefined,
    requestTimeoutMs: Math.max(30_000, Math.min(300_000, Number(input.requestTimeoutMs || current.requestTimeoutMs || DEFAULT_PREFERENCES.requestTimeoutMs))),
    sendOnEnter: typeof input.sendOnEnter === 'boolean' ? input.sendOnEnter : current.sendOnEnter !== false,
    showInspector: typeof input.showInspector === 'boolean' ? input.showInspector : current.showInspector !== false,
    compactMode: typeof input.compactMode === 'boolean' ? input.compactMode : current.compactMode === true,
    workspaces: current.workspaces || [],
    activeWorkspaceId: typeof input.activeWorkspaceId === 'string' ? input.activeWorkspaceId.slice(0, 120) : current.activeWorkspaceId,
  }
  if (typeof input.token === 'string') {
    if (input.token && !secureStorageAvailable()) throw new Error('OS credential encryption is unavailable; token was not stored')
    next.encryptedToken = input.token ? safeStorage.encryptString(input.token).toString('base64') : undefined
  }
  persistConfig(next)
  return publicConfig(next)
}

function persistConfig(value) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function publicConfig(value) {
  return {
    endpoint: value.endpoint, principal: value.principal, clientId: value.clientId,
    hasToken: Boolean(value.encryptedToken), encryptionAvailable: credentialEncryptionAvailable,
    requestTimeoutMs: value.requestTimeoutMs, sendOnEnter: value.sendOnEnter,
    showInspector: value.showInspector, compactMode: value.compactMode,
    workspaces: (value.workspaces || []).map(item => ({ id: item.id, name: item.name, path: item.path })),
    activeWorkspaceId: value.activeWorkspaceId,
  }
}

const BLOCKED_WORKSPACE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials|secrets?|(?:(?:nova|xaventra)\.)?config\.json|auth\.json|wallets?\.json|.*\.wallet\.json|USER\.md|PROJECT_MEMORY\.md|\.nova-gateway-token|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i
const SKIPPED_WORKSPACE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nova-data', '.nova-vector-memory', '.nova-auth', '.nova-sessions', '.nova-memory', '.nova-learning', '.ssh', 'coverage'])
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.css', '.scss', '.html', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.yml', '.yaml', '.toml', '.xml', '.sql', '.sh', '.ps1'])

function workspaceById(id) {
  return (readConfig().workspaces || []).find(item => item.id === String(id || ''))
}

function safeWorkspacePath(workspace, rawRelative = '.') {
  const root = realpathSync(workspace.path)
  const input = String(rawRelative || '.').replace(/\\/g, '/')
  if (isAbsolute(input) || input.split('/').includes('..')) throw new Error('Workspace path must be relative and cannot traverse parents')
  const blocked = path => path.split(/[\\/]/).some(part => SKIPPED_WORKSPACE_DIRS.has(part.toLowerCase()) || BLOCKED_WORKSPACE_NAMES.test(part))
  if (blocked(input)) throw new Error('Private and generated workspace paths are not available')
  const candidate = realpathSync(resolve(root, input))
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Workspace path escaped the selected root')
  if (blocked(rel)) throw new Error('Private and generated workspace paths are not available')
  return { root, candidate, relativePath: rel.replace(/\\/g, '/') || '.' }
}

async function selectWorkspace() {
  const selection = await dialog.showOpenDialog(mainWindow, { title: 'Arbeitsordner für Xaventra auswählen', properties: ['openDirectory'] })
  if (selection.canceled || !selection.filePaths[0]) return publicConfig(readConfig())
  const path = realpathSync(selection.filePaths[0])
  const current = readConfig()
  let item = (current.workspaces || []).find(workspace => workspace.path.toLowerCase() === path.toLowerCase())
  if (!item) item = { id: `workspace-${randomUUID()}`, name: basename(path), path }
  const workspaces = [item, ...(current.workspaces || []).filter(workspace => workspace.id !== item.id)].slice(0, 20)
  const next = { ...current, workspaces, activeWorkspaceId: item.id }
  persistConfig(next)
  return publicConfig(next)
}

function setActiveWorkspace(id) {
  const current = readConfig()
  if (id && !(current.workspaces || []).some(item => item.id === id)) throw new Error('Workspace is not registered on this desktop')
  const next = { ...current, activeWorkspaceId: id || undefined }
  persistConfig(next)
  return publicConfig(next)
}

function executeWorkspaceOperation(event, input) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Workspace caller is not trusted')
  const workspace = workspaceById(input?.workspaceId)
  if (!workspace) throw new Error('Workspace is not registered on this desktop')
  const operation = String(input?.operation || '')
  const target = safeWorkspacePath(workspace, input?.relativePath || '.')
  if (operation === 'list') {
    const entries = readdirSync(target.candidate, { withFileTypes: true })
      .filter(entry => !SKIPPED_WORKSPACE_DIRS.has(entry.name.toLowerCase()) && !BLOCKED_WORKSPACE_NAMES.test(entry.name)).slice(0, 250)
      .map(entry => ({
        name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        relativePath: join(target.relativePath === '.' ? '' : target.relativePath, entry.name).replace(/\\/g, '/'),
      }))
    return { kind: 'workspace_result', operation, workspaceId: workspace.id, rootName: workspace.name, relativePath: target.relativePath, entries }
  }
  if (operation === 'read') {
    const stat = statSync(target.candidate)
    if (!stat.isFile()) throw new Error('Workspace read target is not a file')
    if (!TEXT_EXTENSIONS.has(extname(target.candidate).toLowerCase()) || stat.size > 160_000) throw new Error('Only bounded text/code files can be read')
    const content = readFileSync(target.candidate, 'utf8')
    return { kind: 'workspace_result', operation, workspaceId: workspace.id, rootName: workspace.name, relativePath: target.relativePath, content, sha256: createHash('sha256').update(content).digest('hex') }
  }
  if (operation === 'search') {
    const query = String(input?.query || '').trim().slice(0, 200)
    if (!query) throw new Error('Workspace search requires a query')
    const matches = []
    const visit = (directory, depth) => {
      if (depth > 6 || matches.length >= 100) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= 100 || SKIPPED_WORKSPACE_DIRS.has(entry.name.toLowerCase()) || BLOCKED_WORKSPACE_NAMES.test(entry.name)) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path, depth + 1)
        else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          const stat = statSync(path)
          if (stat.size > 160_000) continue
          const lines = readFileSync(path, 'utf8').split(/\r?\n/)
          for (let index = 0; index < lines.length && matches.length < 100; index++) {
            if (lines[index].toLowerCase().includes(query.toLowerCase())) matches.push({
              relativePath: relative(target.root, path).replace(/\\/g, '/'), line: index + 1, preview: lines[index].trim().slice(0, 300),
            })
          }
        }
      }
    }
    visit(target.candidate, 0)
    return { kind: 'workspace_result', operation, workspaceId: workspace.id, rootName: workspace.name, relativePath: target.relativePath, query, matches }
  }
  throw new Error('Workspace operation is not allowed')
}

function getToken(config) {
  if (!config.encryptedToken) return ''
  if (!secureStorageAvailable()) throw new Error('Stored token cannot be decrypted on this system')
  return safeStorage.decryptString(Buffer.from(config.encryptedToken, 'base64'))
}

function assertApiPath(path) {
  const value = String(path || '')
  if (!/^\/api\/desktop(?:\/[a-zA-Z0-9._~!$&'()*+,;=:@%-]+)*?(?:\?[a-zA-Z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(value)) {
    throw new Error('Desktop API path is not allowed')
  }
  return value
}

async function apiRequest(_event, input) {
  const method = String(input?.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('HTTP method is not allowed')
  const path = assertApiPath(input?.path)
  const config = readConfig()
  const token = getToken(config)
  const body = input?.body === undefined ? undefined : JSON.stringify(input.body)
  if (body && Buffer.byteLength(body) > 1_000_000) throw new Error('Desktop request body exceeds 1 MB')
  const controller = new AbortController()
  // Bootstrap must not occupy the full multi-minute chat budget per retry.
  const timeout = setTimeout(() => controller.abort(), path === '/api/desktop/bootstrap' ? Math.min(5000, config.requestTimeoutMs) : config.requestTimeoutMs)
  try {
    const response = await fetch(`${config.endpoint}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Nova-Principal': config.principal,
        'X-Nova-Desktop-Client': config.clientId,
      },
      body,
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = { error: text.slice(0, 500) } }
    if (!response.ok) throw new Error(String(data?.error || `Xaventra returned HTTP ${response.status}`).slice(0, 500))
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function capturePrimaryDisplay(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Desktop capture caller is not trusted')
  const display = screen.getPrimaryDisplay()
  const original = display.size
  const targetWidth = Math.min(1200, Math.max(640, original.width))
  const targetHeight = Math.max(360, Math.round(original.height * targetWidth / original.width))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: targetWidth, height: targetHeight } })
  const source = sources.find(item => item.display_id === String(display.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('Der Desktop konnte nicht aufgenommen werden')
  let image = source.thumbnail
  let buffer = image.toJPEG(62)
  for (const [scale, quality] of [[0.85, 55], [0.72, 48], [0.60, 42]]) {
    if (buffer.length <= 135_000) break
    image = source.thumbnail.resize({ width: Math.max(480, Math.round(targetWidth * scale)), quality: 'good' })
    buffer = image.toJPEG(quality)
  }
  if (!buffer.length || buffer.length > 135_000) throw new Error('Desktop-Aufnahme ist für den sicheren Transport zu groß')
  const size = image.getSize()
  return { kind: 'screen_capture', mimeType: 'image/jpeg', base64: buffer.toString('base64'), width: size.width, height: size.height }
}

function createWindow() {
  const icon = app.isPackaged ? join(process.resourcesPath, 'xaventra-icon.png') : join(__dirname, '..', 'assets', 'xaventra-icon.png')
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0B1020',
    icon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  })
  // Unter NovaOS ist diese App die Oberflaeche, nicht ein Programm neben
  // anderen. Eine englische Menueleiste "File Edit View Window" ueber einer
  // deutschen Oberflaeche verwirrt genau den Menschen, fuer den das hier
  // gebaut ist — und keiner ihrer Punkte wird gebraucht. Also weg damit,
  // und das Fenster fuellt den Bildschirm.
  if (process.env.NOVA_OS_MODE === 'true' || process.env.NOVAOS === '1') {
    mainWindow.setMenuBarVisibility(false)
    mainWindow.setAutoHideMenuBar(true)
    mainWindow.maximize()
  }
  mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('io.xaventra.desktop')
  ipcMain.handle('nova:config:get', () => {
    const value = readConfig()
    if (!existsSync(configPath())) persistConfig(value)
    return publicConfig(value)
  })
  ipcMain.handle('nova:config:set', (_event, input) => writeConfig(input || {}))
  ipcMain.handle('nova:api', apiRequest)
  ipcMain.handle('nova:desktop:capture', capturePrimaryDisplay)
  ipcMain.handle('nova:workspace:select', selectWorkspace)
  ipcMain.handle('nova:workspace:set-active', (_event, id) => setActiveWorkspace(String(id || '')))
  ipcMain.handle('nova:workspace:execute', executeWorkspaceOperation)
  ipcMain.handle('nova:window:focus', () => {
    if (!mainWindow) return false
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return true
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
