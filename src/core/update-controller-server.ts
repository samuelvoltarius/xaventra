import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeUpdateState as atomicWriteJsonSync } from './update-store.js'
import { signRepairValue } from '../doctor/repair-activation.js'
import type { UpdateActivationReceipt } from './update-activation.js'

export interface UpdateJob { releaseId: string; targetId: string; state: 'accepted' | 'running' | 'installed' | 'rolled-back' | 'blocked'; updatedAt: number; receipt?: UpdateActivationReceipt }
/** Detached controller owns work after HTTP acknowledgement / runtime shutdown.
 * A persisted nonterminal job after supervisor restart is blocked for explicit
 * reconciliation, never silently restarted. No caller paths, commands or images. */
export function createUpdateControllerServer(options: { root: string; targetId: string; token: string; receiptPrivateKey: string;
    authorize(id: string): Promise<boolean>;
    deploy(id: string): Promise<UpdateActivationReceipt> }) {
    if (options.token.length < 32) throw Error('Strong controller client token required')
    mkdirSync(options.root, { recursive: true })
    const active = new Set<string>()
    const tokenHash = createHash('sha256').update(`Bearer ${options.token}`).digest()
    return createServer(async (req, res) => {
        const timer = setTimeout(() => req.destroy(), 5000)
        try {
            if (req.method !== 'POST' || req.url !== '/update' || !timingSafeEqual(tokenHash, createHash('sha256').update(req.headers.authorization || '').digest())) throw Error('Denied')
            const chunks: Buffer[] = []; let size = 0
            for await (const chunk of req) { size += chunk.length; if (size > 8192) throw Error('Budget'); chunks.push(chunk) }
            const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!['deploy', 'status'].includes(input.operation) || input.targetId !== options.targetId
                || !/^[a-f0-9-]{36}$/.test(input.challenge) || !/^\d+\.\d+\.\d+(?:-rc\.\d+)?-[a-f0-9]{64}$/.test(input.releaseId)) throw Error('Invalid update request')
            const path = join(options.root, `${input.releaseId}.json`)
            let job: UpdateJob | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
            if (job && !active.has(input.releaseId) && ['accepted', 'running'].includes(job.state)) {
                job.state = 'blocked'; job.updatedAt = Date.now(); atomicWriteJsonSync(path, job)
            }
            if (!job && input.operation === 'deploy') {
                if (!await options.authorize(input.releaseId)) throw Error('No current operator grant')
                // One controller transaction, including downloads, across requests
                // and processes. A crash deliberately leaves the lock in place.
                mkdirSync(join(options.root, 'job.lock'))
                job = { releaseId: input.releaseId, targetId: options.targetId, state: 'accepted', updatedAt: Date.now() }
                atomicWriteJsonSync(path, job); active.add(input.releaseId)
                const current = job
                res.once('finish', () => { void (async () => {
                    try {
                        current.state = 'running'; current.updatedAt = Date.now(); atomicWriteJsonSync(path, current)
                        current.receipt = await options.deploy(input.releaseId)
                        if (current.receipt.releaseId !== input.releaseId || current.receipt.ticket?.targetId !== options.targetId
                            || current.receipt.ticket?.proposalId !== `upstream-${input.releaseId}`) throw Error('Controller result binding mismatch')
                        current.state = ['installed', 'rolled-back'].includes(current.receipt.status) ? current.receipt.status as 'installed' | 'rolled-back' : 'blocked'
                    } catch { current.state = 'blocked' }
                    finally {
                        current.updatedAt = Date.now(); atomicWriteJsonSync(path, current); active.delete(input.releaseId)
                        if (['installed', 'rolled-back'].includes(current.state)) {
                            const { rmdirSync } = await import('node:fs'); rmdirSync(join(options.root, 'job.lock'))
                        }
                    }
                })().catch(() => { /* Persistent job/lock is the authoritative uncertain state. */ }) })
            }
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(signRepairValue({ challenge: input.challenge, targetId: options.targetId, releaseId: input.releaseId,
                expiresAt: Date.now() + 10_000, job: job || null }, options.receiptPrivateKey)))
        } catch { res.writeHead(409).end('Update request denied or locked; inspect controller status') }
        finally { clearTimeout(timer) }
    })
}
