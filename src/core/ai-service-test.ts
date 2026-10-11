import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { CapabilityGraphNode, CapabilityRuntime } from '../mesh/capability-graph.js'
import { capabilityNodeOnline, capabilityRuntimeTombstoned } from '../mesh/capability-graph.js'
import { fetchWithSsrfGuard } from '../resilience/ssrf-guard.js'
import { aiTestAudio, AI_TEST_TRANSCRIPT } from './ai-test-audio.js'

export interface AiTestTarget { node: string; runtime: CapabilityRuntime; address: string }
export interface AiTestResult { node: string; service: string; kind: string; state: 'passed' | 'failed' | 'not-tested'; detail: string; at: string }
const ports = new Set(['8000', '8001', '8017', '8088', '11434', '5002', '5003'])
const pending = new Map<string, { targets: AiTestTarget[]; expires: number }>()
const key = (channel: string, principal: string) => JSON.stringify([channel.toLowerCase(), principal])

/** Discovery is not arbitrary URL authority: exact live peer/local IP + bounded AI port. */
export function bindAiTestTargets(nodes: CapabilityGraphNode[], localId: string, addresses: Map<string, string[]>, now = Date.now()): AiTestTarget[] {
    const result: AiTestTarget[] = []
    for (const node of nodes) {
        if (!capabilityNodeOnline(node, now)) continue
        for (const runtime of node.runtimes || []) {
            if (runtime.status !== 'running') continue
            try {
                const url = new URL(runtime.endpoint)
                const host = url.hostname.replace(/^\[|\]$/g, '')
                if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
                    || !ports.has(url.port) || !isIP(host) || !(addresses.get(node.id) || []).includes(host)) continue
                if (node.id !== localId && (host.startsWith('127.') || host === '::1')) continue
                result.push({ node: node.id, runtime: { ...runtime, endpoint: url.origin, models: [...runtime.models] }, address: host })
            } catch { /* local command transports are not HTTP inference endpoints */ }
        }
    }
    return result.slice(0, 16)
}

export async function collectAiTestTargets(): Promise<AiTestTarget[]> {
    const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
    const { getLocalNodeId, getOnlineNodes } = await import('../mesh/mesh-registry.js')
    const localId = getLocalNodeId()
    const addresses = new Map<string, string[]>()
    for (const peer of await getOnlineNodes()) addresses.set(peer.node_id, peer.ip ? [peer.ip] : [])
    const local = ['127.0.0.1', '::1', ...Object.values(networkInterfaces()).flatMap(items => (items || []).map(item => item.address))]
    addresses.set(localId, local)
    const snapshot = getCapabilityGraph().getSnapshot()
    const tombstones = new Map((snapshot.tombstones || []).map(t => [t.id, t]))
    return bindAiTestTargets(snapshot.nodes.map(n => ({ ...n, runtimes: n.runtimes.filter(r => !capabilityRuntimeTombstoned(r, tombstones.get(r.id))) })), localId, addresses)
}

async function boundedJson(response: Response): Promise<any> {
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Leere Antwort')
    const chunks: Uint8Array[] = []; let size = 0
    try {
        while (true) {
            const part = await reader.read(); if (part.done) break
            size += part.value.length
            if (size > 262144) throw new Error('Antwort zu groß')
            chunks.push(part.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { await reader.cancel().catch(() => {}) }
}

/** No keys, user data, cloud fallback, redirects, installation or service mutation. */
export async function testAiTarget(target: AiTestTarget, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<AiTestResult[]> {
    const r = target.runtime
    const results: AiTestResult[] = []
    const request = async (path: string, body?: unknown) => {
        const options: RequestInit = { method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }
        if (body instanceof FormData) {
            const encoded = new Request('http://localhost/', { method: 'POST', body })
            options.body = new Uint8Array(await encoded.arrayBuffer())
            options.headers = { 'Content-Type': encoded.headers.get('content-type')! }
        }
        else if (body) { options.body = JSON.stringify(body); options.headers = { 'Content-Type': 'application/json' } }
        const url = target.runtime.endpoint + path
        return fetchImpl ? fetchImpl(url, options) : fetchWithSsrfGuard(url, options, { allowedAddresses: [target.address], maxRedirects: 0 })
    }
    const check = async (kind: string, action: () => Promise<boolean>, detail: string) => {
        try {
            const ok = await action()
            results.push({ node: target.node, service: r.name, kind, state: ok ? 'passed' : 'failed', detail: ok ? detail : 'Antwort erfüllt das Testkriterium nicht', at: new Date().toISOString() })
        } catch (error) {
            const message = (error as Error).message
            results.push({ node: target.node, service: r.name, kind, state: 'failed', detail: /^HTTP \d{3}$|^Antwort zu groß$|^Leere Antwort$/.test(message) ? message : 'Zeitüberschreitung, Transport- oder ungültige Antwort', at: new Date().toISOString() })
        }
    }
    if (r.type === 'llm' || r.type === 'embedding') {
        const ollama = /ollama/i.test(r.name)
        for (const model of r.models.filter(model => typeof model === 'string' && model.length > 0 && model.length <= 160).slice(0, 3)) {
            const embedding = /embed|nomic|bge|mxbai/i.test(model) || r.type === 'embedding'
            await check(`${embedding ? 'Embedding' : 'Inferenz'} (${model})`, async () => {
                const body = embedding ? { model, input: 'Synthetic service test.' } : ollama
                    ? { model, messages: [{ role: 'user', content: 'Reply with only OK.' }], stream: false, options: { num_predict: 16, temperature: 0 } }
                    : { model, messages: [{ role: 'user', content: 'Reply with only OK.' }], max_tokens: 16, temperature: 0 }
                const j = await boundedJson(await request(ollama ? embedding ? '/api/embed' : '/api/chat' : embedding ? '/v1/embeddings' : '/v1/chat/completions', body))
                if (j.error) return false
                if (embedding) { const vector = ollama ? j.embeddings?.[0] : j.data?.[0]?.embedding; return Array.isArray(vector) && vector.length > 0 && vector.every(x => typeof x === 'number' && Number.isFinite(x)) }
                return /^ok[.!]?$/i.test(String(ollama ? j.message?.content : j.choices?.[0]?.message?.content).trim())
            }, 'Synthetische Testanfrage erfolgreich')
        }
    } else if (r.type === 'stt') {
        await check('Transkription', async () => {
            const form = new FormData(); const audio = aiTestAudio()
            form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'synthetic-speech-test.wav')
            form.append('model', r.models[0] || 'whisper-1'); form.append('language', 'en')
            const j = await boundedJson(await request('/v1/audio/transcriptions', form))
            return !j.error && String(j.text || '').trim().replace(/[.!?]+$/, '').toLowerCase() === AI_TEST_TRANSCRIPT.toLowerCase()
        }, 'Synthetischer Testsatz korrekt transkribiert; keine Nutzeraufnahme')
    } else if (r.type === 'search') {
        await check('Suche', async () => { const j = await boundedJson(await request('/search?q=artificial%20intelligence&format=json')); return Array.isArray(j.results) && j.results.length > 0 }, 'Suchanfrage liefert Ergebnisse')
    } else if (r.type === 'tts') {
        await check('Sprachausgabe', async () => {
            const response = await request('/v1/audio/speech', { model: r.models[0] || 'tts-1', input: 'Hello.', voice: 'alloy', response_format: 'wav' })
            if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
            const reader = response.body?.getReader(); if (!reader) return false
            let bytes = 0; const chunks: Uint8Array[] = []
            try {
                while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2097152) throw new Error('Antwort zu groß'); chunks.push(part.value) }
                const audio = Buffer.concat(chunks)
                return audio.length > 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE'
            } finally { await reader.cancel().catch(() => {}) }
        }, 'Testtext liefert WAV-Audio; Verständlichkeit nicht separat geprüft')
    }
    if (!results.length) results.push({ node: target.node, service: r.name, kind: r.type, state: 'not-tested', detail: 'Kein passender Funktionstest vorhanden; kein Nutzbarkeitsnachweis', at: new Date().toISOString() })
    return results
}

export async function runAiServiceTests(targets: AiTestTarget[], parentSignal?: AbortSignal): Promise<string> {
    parentSignal?.throwIfAborted()
    // Rebind after confirmation: no stale/removed endpoint may be invoked.
    const current = await collectAiTestTargets()
    const live = targets.filter(t => current.some(c => c.node === t.node && c.runtime.id === t.runtime.id && c.runtime.endpoint === t.runtime.endpoint && c.address === t.address))
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(24000)]) : AbortSignal.timeout(24000)
    const results: AiTestResult[] = []
    let index = 0
    await Promise.all(Array.from({ length: Math.min(3, live.length) }, async () => {
        while (index < live.length) {
            const target = live[index++]
            if (signal.aborted) { results.push({ node: target.node, service: target.runtime.name, kind: target.runtime.type, state: 'not-tested', detail: 'Zeitbudget erschöpft; keine Anfrage gestartet', at: new Date().toISOString() }); continue }
            results.push(...await testAiTarget(target, undefined, signal))
        }
    }))
    parentSignal?.throwIfAborted()
    const lines = results.map(r => `${r.node} · ${r.service} · ${r.kind}: ${r.state === 'passed' ? 'funktioniert (getestet)' : r.state === 'failed' ? 'Test fehlgeschlagen' : 'nicht getestet'} — ${r.detail} (${r.at})`)
    if (live.length !== targets.length) lines.push('Entfernte/geänderte Ziele: nicht getestet; neue Bestätigung erforderlich.')
    return ['AI-Dienst-Funktionstests:', ...lines, 'Nicht aufgeführte Dienste, Bildverstehen, Codex und Gedächtnis insgesamt sind damit nicht abgenommen. Keine Änderung ausgeführt.'].join('\n')
}

export function isAiServiceTestRequest(text: string): boolean {
    return /^(?:mach mir (?:bitte )?einen check von|(?:bitte )?(?:prüfe|pruefe|teste|checke)(?: jetzt| erneut)?)(?: allen| alle| den| die)? (?:ai|ki)[ -]diensten?(?: die auf den nodes laufen| auf (?:allen |den )?(?:nodes|knoten)| im mesh)?[.!?]*$/i.test(text.trim())
}

/** One use, per authenticated principal/channel, ten-minute TTL; unrelated turns cancel. */
export async function handleAiServiceTestTurn(channel: string, principal: string, text: string, ownerDirect: boolean,
    collect = collectAiTestTargets, run = runAiServiceTests, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted()
    const id = key(channel, principal); const p = pending.get(id)
    pending.delete(id)
    for (const [entry, value] of pending) if (value.expires <= Date.now()) pending.delete(entry)
    if (isAiServiceTestRequest(text)) {
        if (!ownerDirect) return '🔒 AI-Diensttests sind nur für den Owner im Direktchat verfügbar.'
        const targets = await collect()
        if (!targets.length) return 'Keine aktuell zugeordneten, unterstützten AI-Endpunkte für einen Funktionstest. Keine Anfrage ausgeführt.'
        if (pending.size >= 1024) pending.delete(pending.keys().next().value!)
        pending.set(id, { targets, expires: Date.now() + 600000 })
        return `Ich kann diese bekannten Dienste mit synthetischen Daten testen:\n${targets.map(t => `${t.node}: ${t.runtime.name}`).join('\n')}\nSoll ich die echten Funktionstests jetzt ausführen? Antworte mit Ja. Keine Installation, Neustarts, Cloud-Anfragen oder Nutzeraufnahmen.`
    }
    if (p && /^(ja|ja bitte|okay|ok)[.!]*$/i.test(text.trim())) {
        if (!ownerDirect) return '🔒 Bestätigung nur im Owner-Direktchat gültig.'
        if (p.expires <= Date.now()) return 'Die Testbestätigung ist abgelaufen. Bitte den AI-Dienstcheck erneut anfordern.'
        return run(p.targets, signal)
    }
    return null
}
