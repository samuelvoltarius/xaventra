/**
 * 2.85 Paket A: the page the browser lands on after a connection login
 * (`GET /verbindungen/rueckkehr?state=…&code=…`, dashboard/server.ts).
 * Finishes the login, connects and tests, and answers with a tiny static
 * page — no script, no token, no code echoed back.
 */
import { completeLoginAndConnect, defaultDeps, type ConnectDeps } from './connect-flow.js'

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

export function returnPage(ok: boolean, message: string): string {
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">`
        + `<title>Xaventra – Verbindung</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d2327}h1{font-size:1.3rem}</style></head>`
        + `<body><h1>${ok ? 'Verbunden' : 'Nicht verbunden'}</h1><p>${escape(message)}</p><p>Du kannst dieses Fenster schließen.</p></body></html>`
}

export async function handleLoginReturn(query: Record<string, unknown>, deps: ConnectDeps = defaultDeps()): Promise<{ status: number; html: string }> {
    const one = (value: unknown) => Array.isArray(value) ? value[0] : value
    const result = await completeLoginAndConnect({ state: one(query.state), code: one(query.code), error: one(query.error) }, deps)
    return { status: result.ok ? 200 : 400, html: returnPage(result.ok, result.message) }
}
