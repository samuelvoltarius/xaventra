import { Worker } from 'node:worker_threads'
import { ownSubnets, scanTargetAllowed, type InterfaceMap } from './net-scope.js'
import type { DirectFunction } from './direct-smart-devices.js'

/** Hard termination owns SDK retries, reconnects and debug logging as well as TCP. */
export function readLocalTuya(input: { host: string; identity: string; key: string; version: string }, signal: AbortSignal, interfaces?: InterfaceMap): Promise<DirectFunction[]> {
    return readLocalNative('tuya', input, signal, interfaces)
}
export function readLocalEspHome(input: { host: string; port: number; identity: string; psk: string; action?: { functionId: string; on: boolean } }, signal: AbortSignal, interfaces?: InterfaceMap, authorize?: () => boolean): Promise<Array<DirectFunction & { confirmedOn?: boolean }>> {
    return readLocalNative('esphome', input, signal, interfaces, authorize)
}
function readLocalNative(protocol: 'tuya' | 'esphome', input: { host: string; [key: string]: unknown }, signal: AbortSignal, interfaces?: InterfaceMap, authorize?: () => boolean): Promise<DirectFunction[]> {
    if (signal.aborted || !scanTargetAllowed(input.host, ownSubnets(interfaces)).allowed) return Promise.reject(new Error('Local device outside approved scan scope'))
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./smart-native-worker.js', import.meta.url), {
            workerData: { ...input, protocol }, env: { DEBUG: '', NODE_ENV: 'production' }, execArgv: [], stdout: true, stderr: true,
        })
        worker.stdout?.resume(); worker.stderr?.resume()
        let done = false
        const finish = (functions?: DirectFunction[]) => {
            if (done) return
            done = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
            void worker.terminate().then(() => functions ? resolve(functions) : reject(new Error('Tuya local read failed')), () => reject(new Error('Tuya worker termination failed')))
        }
        const abort = () => finish()
        const timer = setTimeout(abort, 8_000)
        signal.addEventListener('abort', abort, { once: true })
        worker.once('error', abort); worker.once('exit', () => { if (!done) finish() })
        worker.on('message', reply => {
            if (reply?.kind === 'control-permission') {
                worker.postMessage({ kind: 'control-permission', ok: !done && !signal.aborted && Boolean(input.action && authorize?.()) && scanTargetAllowed(input.host, ownSubnets(interfaces)).allowed }); return
            }
            const functions = reply?.functions
            if (signal.aborted || reply?.ok !== true || !Array.isArray(functions) || functions.length > 200 || !functions.every(f => f && (protocol === 'tuya' ? /^dp:\d{1,6}$/.test(f.id) && f.kind === 'unknown' : /^entity:[a-zA-Z0-9_:.-]{1,80}$/.test(f.id) && ['light', 'switch', 'sensor', 'binary_sensor', 'fan', 'cover', 'climate', 'lock', 'media_player', 'button', 'number', 'select', 'text', 'unknown'].includes(f.kind)) && typeof f.name === 'string' && f.name.length < 120 && f.available === true)) return finish()
            finish(functions)
        })
        if (signal.aborted) abort()
    })
}
