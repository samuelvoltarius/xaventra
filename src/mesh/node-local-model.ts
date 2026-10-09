/**
 * 2.89.4: Knoten-lokale Modell-Endpunkte (Ollama &c. nur auf 127.0.0.1) sind
 * Fähigkeiten DIESES Knotens. Der Main ruft sie nie per HTTP über die
 * Peer-Adresse — keinen Fallback-Versuch, kein Warten auf Peer-HTTP. Aufruf
 * nur als Mesh-Job an den Worker (`remoteExec`); der Worker geht selbst gegen
 * seinen localhost. Ein Mesh-Handle ist `mesh://<knoten>[/<pfad>]`.
 */

export const MESH_ENDPOINT_PREFIX = 'mesh://'

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0)$/i

export function meshEndpoint(node: string, path = ''): string {
    const id = String(node || '').trim()
    if (!id) throw new Error('meshEndpoint: Knoten fehlt')
    const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
    return `${MESH_ENDPOINT_PREFIX}${id}${suffix}`
}

export function parseMeshEndpoint(url: string): { node: string; path: string } | null {
    const value = String(url || '')
    if (!value.startsWith(MESH_ENDPOINT_PREFIX)) return null
    const rest = value.slice(MESH_ENDPOINT_PREFIX.length)
    const slash = rest.indexOf('/')
    const node = (slash >= 0 ? rest.slice(0, slash) : rest).trim()
    const path = slash >= 0 ? rest.slice(slash) : ''
    return node ? { node, path } : null
}

export function isLoopbackUrl(url: string): boolean {
    try {
        const host = new URL(String(url)).hostname.replace(/^\[|\]$/g, '')
        return LOOPBACK.test(host)
    } catch { return false }
}

/**
 * True when this handle must be used as a mesh job (remote node's own
 * endpoint). A local loopback URL without a foreign node is a direct call.
 * 2.89.4: a foreign node's model endpoint is never HTTP from Main — not even
 * when a peer host was published; loopback-on-remote is always mesh-only.
 */
export function requiresMeshJob(options: { baseUrl?: string; node?: string; localNodeId?: string }): boolean {
    if (parseMeshEndpoint(String(options.baseUrl || ''))) return true
    const node = String(options.node || '').trim()
    if (!node) {
        // No node: only a loopback URL is a local call; anything else is not guessed as mesh.
        return false
    }
    if (options.localNodeId && node === options.localNodeId) return false
    return true
}

export interface NodeLocalModelCall {
    /** Worker-local path, e.g. `/api/embed` or `/api/generate`. */
    path: string
    body: unknown
}

/**
 * Mesh-Job an den Worker. Bei Fehler oder fehlendem Mesh sofort `null` —
 * nie als Fallback die Peer-Adresse per HTTP anrufen.
 */
export async function runNodeLocalModel<T = unknown>(
    node: string,
    call: NodeLocalModelCall,
    timeoutMs = 15_000,
): Promise<T | null> {
    const target = String(node || '').trim()
    if (!target || !call?.path) return null
    try {
        const { remoteExec } = await import('./mesh-remote-exec.js')
        const response = await remoteExec(target, 'ollama-api', { path: call.path, body: call.body }, timeoutMs)
        return response?.success ? (response.result as T) : null
    } catch {
        return null
    }
}

/**
 * Worker-Seite: Ollama-API nur gegen den eigenen localhost. Registriert
 * gemeinsam mit den LLM-Proxy-Handlern.
 */
export async function registerNodeLocalModelHandler(): Promise<void> {
    const { registerHandler } = await import('./mesh-remote-exec.js')
    registerHandler('ollama-api', async (payload: NodeLocalModelCall & { base?: string }) => {
        const path = String(payload?.path || '')
        if (!/^\/api\/[a-z0-9_-]+$/i.test(path)) throw new Error(`unerlaubter Ollama-Pfad: ${path.slice(0, 40)}`)
        const base = String(payload?.base || 'http://127.0.0.1:11434')
        if (!isLoopbackUrl(base)) throw new Error('nur eigener localhost')
        const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload?.body ?? {}),
            signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`Ollama ${path} → ${response.status}`)
        return response.json()
    })
}
