import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { verifyRepairValue } from '../doctor/repair-activation.js'
import type { UpdateJob } from './update-controller-server.js'

export interface UpdateControllerClientConfig { url?: string; socketPath?: string; targetId: string; tokenFile: string; receiptPublicKey: string }
export async function updateControllerRequest(operation: 'deploy' | 'status', releaseId: string,
    config?: UpdateControllerClientConfig): Promise<UpdateJob | null> {
    if (!config) {
        if (!process.env.XAVENTRA_UPDATE_CLIENT_FILE) throw Error('Kein Update-Controller eingeschrieben; einmaliges Operator-Setup erforderlich')
        config = JSON.parse(readFileSync(process.env.XAVENTRA_UPDATE_CLIENT_FILE, 'utf8'))
    }
    const url = config.url ? new URL(config.url) : undefined
    if ((url && config.socketPath) || (!url && !config.socketPath)
        || (config.socketPath && (!config.socketPath.startsWith('/') || config.socketPath.includes('\0')))
        || (url && (url.username || url.password || url.hash || url.pathname !== '/update' || url.search
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))))) throw Error('Update controller requires enrolled Unix socket, HTTPS or loopback')
    const challenge = randomUUID(), token = readFileSync(config.tokenFile, 'utf8').trim()
    if (token.length < 32) throw Error('Invalid controller authentication')
    const body = JSON.stringify({ operation, releaseId, challenge, targetId: config.targetId })
    let envelope: any
    if (config.socketPath) {
        envelope = await new Promise((resolve, reject) => {
            const req = request({ socketPath: config.socketPath, path: '/update', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, res => {
                const chunks: Buffer[] = []; let size = 0
                res.on('data', b => { size += b.length; if (size > 64 * 1024) req.destroy(Error('Controller response budget')); else chunks.push(b) })
                res.on('error', reject)
                res.on('end', () => { try { if (res.statusCode !== 200) throw Error('Controller denied'); resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (e) { reject(e) } })
            })
            const timer = setTimeout(() => req.destroy(Error('Controller timeout; reconcile status')), 15_000)
            req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end(body)
        })
    } else {
    const res = await fetch(url!, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body })
    if (!res.ok || !res.body) throw Error('Controller nicht erreichbar oder Aktivierung gesperrt')
    const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try { while (true) { const x = await reader.read(); if (x.done) break; size += x.value.length; if (size > 64 * 1024) throw Error('Controller response budget'); chunks.push(x.value) } }
    finally { await reader.cancel().catch(() => undefined) }
    envelope = JSON.parse(Buffer.concat(chunks).toString())
    }
    const value: any = verifyRepairValue(envelope, config.receiptPublicKey)
    if (value.challenge !== challenge || value.targetId !== config.targetId || value.releaseId !== releaseId
        || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 10_000
        || (value.job && (value.job.targetId !== config.targetId || value.job.releaseId !== releaseId
            || !['accepted', 'running', 'installed', 'rolled-back', 'blocked'].includes(value.job.state)))) throw Error('Controller receipt binding mismatch')
    return value.job
}
export function formatUpdateJob(job: UpdateJob | null): string {
    if (!job) return 'Noch kein Aktivierungsauftrag für dieses Release.'
    const state = { accepted: 'angenommen – noch nicht installiert', running: 'läuft – noch nicht freigegeben', installed: 'installiert und geprüft',
        'rolled-back': 'fehlgeschlagen, vorheriger Stand wiederhergestellt', blocked: 'gesperrt – Operator muss den gespeicherten Zustand prüfen' }[job.state]
    return `Container-Update auf ${job.targetId}: ${state}\nRelease: ${job.releaseId}\nStatus: /update status ${job.releaseId}`
}
