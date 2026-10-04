import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, chmodSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { matterTargetAllowed, matterMulticastAllowed, localMatterRoutes } from './matter-scope.js'
import type { InterfaceMap } from './net-scope.js'
import type { DirectFunction } from './direct-smart-devices.js'

const busy = new Set<string>()
export async function readMatterPeer(input: { host: string; port: number; identity: string; pairingCode?: string; peerId?: string; action?: { functionId: string; on: boolean } }, storage: string, signal: AbortSignal,
    authorize: () => boolean, interfaces?: InterfaceMap): Promise<{ peerId: string; functions: DirectFunction[]; confirmed?: boolean }> {
    const routes = await localMatterRoutes(interfaces)
    if (busy.has(storage) || signal.aborted || !authorize() || !matterTargetAllowed(input.host, interfaces, routes)) throw new Error('Matter access not current or outside own network')
    busy.add(storage)
    try {
        mkdirSync(storage, { recursive: true, mode: 0o700 }); chmodSync(storage, 0o700)
        return await new Promise((resolve, reject) => {
        const child = fork(fileURLToPath(new URL('./matter-process.js', import.meta.url)), [], {
            cwd: storage, execArgv: ['--max-old-space-size=256'], env: { NODE_ENV: 'production', DEBUG: '' }, silent: true,
        })
        child.stdout?.resume(); child.stderr?.resume()
        let done = false, result: any
        const finish = (value?: any) => {
            if (done) return
            done = true; result = value; clearTimeout(timer); signal.removeEventListener('abort', abort)
            // Even successful SDK close is followed by owned child termination.
            child.kill()
        }
        const abort = () => finish()
        const timer = setTimeout(abort, input.pairingCode ? 100_000 : 20_000)
        signal.addEventListener('abort', abort, { once: true })
        child.on('message', (message: any) => {
            if (message?.kind === 'packet-permission') {
                const multicast = matterMulticastAllowed(message.host, message.port, interfaces)
                const ok = !done && !signal.aborted && authorize() && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535
                    && (multicast || matterTargetAllowed(message.host, interfaces, routes))
                const permission = { kind: 'packet-permission', id: message.id, ok }
                child.send(permission)
                return
            }
            if (message?.kind !== 'result') return
            const functions = message.functions
            const valid = !signal.aborted && authorize() && message.ok === true && typeof message.peerId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(message.peerId)
                && Array.isArray(functions) && functions.length <= 200 && functions.every(f => f && typeof f.name === 'string' && f.name.length <= 120 && /^endpoint:\d{1,5}:type:\d{1,10}$/.test(f.id) && ['light', 'switch', 'cover', 'climate', 'lock', 'fan', 'unknown'].includes(f.kind) && f.available === true)
            finish(valid && (!input.action || message.confirmed === true) ? { peerId: message.peerId, functions, ...(input.action ? { confirmed: message.confirmed === true } : {}) } : undefined)
        })
        child.once('error', () => { abort(); reject(new Error('Matter process failed')) })
        child.once('exit', () => {
            if (!done) finish()
            const secure = (directory: string, depth = 0) => {
                if (depth > 12) throw new Error('Unexpected private fabric layout')
                for (const name of readdirSync(directory)) {
                    const path = join(directory, name), stat = lstatSync(path)
                    if (stat.isSymbolicLink()) throw new Error('Unexpected private fabric link')
                    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
                    if (stat.isDirectory()) secure(path, depth + 1)
                }
            }
            try { secure(storage); result && authorize() && !signal.aborted ? resolve(result) : reject(new Error('Matter operation not confirmed; no automatic pairing retry')) }
            catch { reject(new Error('Matter private fabric protection failed')) }
        })
        const request = { kind: 'run', input, storage }
        child.send(request)
        if (signal.aborted) abort()
    }) } finally { busy.delete(storage) }
}
