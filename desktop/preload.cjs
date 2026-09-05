const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaDesktop', Object.freeze({
  config: Object.freeze({
    get: () => ipcRenderer.invoke('nova:config:get'),
    set: input => ipcRenderer.invoke('nova:config:set', {
      endpoint: String(input?.endpoint || ''),
      principal: String(input?.principal || ''),
      ...(typeof input?.token === 'string' ? { token: input.token } : {}),
      requestTimeoutMs: Number(input?.requestTimeoutMs || 120000),
      sendOnEnter: input?.sendOnEnter !== false,
      showInspector: input?.showInspector !== false,
      compactMode: input?.compactMode === true,
      activeWorkspaceId: typeof input?.activeWorkspaceId === 'string' ? input.activeWorkspaceId : undefined,
    }),
  }),
  api: Object.freeze({
    get: path => ipcRenderer.invoke('nova:api', { method: 'GET', path: String(path) }),
    post: (path, body) => ipcRenderer.invoke('nova:api', { method: 'POST', path: String(path), body }),
    patch: (path, body) => ipcRenderer.invoke('nova:api', { method: 'PATCH', path: String(path), body }),
    delete: path => ipcRenderer.invoke('nova:api', { method: 'DELETE', path: String(path) }),
  }),
  window: Object.freeze({
    focus: () => ipcRenderer.invoke('nova:window:focus'),
  }),
  desktop: Object.freeze({
    capture: () => ipcRenderer.invoke('nova:desktop:capture'),
  }),
  workspace: Object.freeze({
    select: () => ipcRenderer.invoke('nova:workspace:select'),
    setActive: id => ipcRenderer.invoke('nova:workspace:set-active', String(id || '')),
    execute: input => ipcRenderer.invoke('nova:workspace:execute', {
      workspaceId: String(input?.workspaceId || ''), operation: String(input?.operation || ''),
      relativePath: String(input?.relativePath || '.'), query: String(input?.query || ''),
    }),
  }),
}))
