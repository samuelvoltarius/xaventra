/** Verified, bounded, resumable Doctor artifact delivery. No model execution. */
import { createWriteStream, existsSync, mkdirSync, statSync, openSync, closeSync, unlinkSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { get as httpsGet } from 'node:https'
import { get as httpGet, type IncomingMessage } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { MODEL_REGISTRY, DOCTOR_ARTIFACT_VERSION, getDoctorConfig, getDoctorMirror, getDoctorModelsDir, isArtifactPresent, selectBestModel, validateArtifact, verifyDoctorArtifact, type ModelInfo } from './doctor-artifacts.js'
export { MODEL_REGISTRY, selectBestModel, type ModelInfo } from './doctor-artifacts.js'

export function getInstalledModels(): ModelInfo[] { return MODEL_REGISTRY.filter(isArtifactPresent) }

export function checkedDownloadUrl(input: string, previous?: URL): URL {
    const url = new URL(input, previous)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash
        || (previous?.protocol === 'https:' && url.protocol !== 'https:')) {
        throw new Error('Doctor mirror requires HTTPS (HTTP only on loopback), without embedded credentials or downgrade redirects')
    }
    return url
}

async function fetchUrl(url: URL, headers: Record<string, string>, signal: AbortSignal, depth = 0): Promise<IncomingMessage> {
    if (depth > 5) throw new Error('Too many Doctor mirror redirects')
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = (url.protocol === 'https:' ? httpsGet : httpGet)(url, { headers, signal }, resolve)
        req.on('error', () => reject(new Error(signal.aborted ? 'Doctor download timed out or was cancelled' : 'Doctor mirror connection failed')))
        req.setTimeout(30000, () => req.destroy(new Error('Doctor mirror idle timeout')))
    })
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (!res.headers.location) throw new Error('Doctor mirror redirect has no location')
        const next = checkedDownloadUrl(res.headers.location, url)
        const forwarded = { ...headers }
        if (next.origin !== url.origin) delete forwarded.Authorization
        return fetchUrl(next, forwarded, signal, depth + 1)
    }
    return res
}

export interface DownloadOptions { mirror?: string; timeoutMs?: number; signal?: AbortSignal }

export async function downloadModel(model: ModelInfo, onProgress?: (pct: number, speed: string, eta: string) => void, options: DownloadOptions = {}): Promise<void> {
    validateArtifact(model)
    if (getDoctorConfig().doctorModel === 'off') throw new Error('Doctor is disabled (doctorModel=off)')
    const dir = getDoctorModelsDir()
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, model.filename), tmp = dest + '.download', lock = dest + '.lock'
    for (const path of [dest, tmp, lock]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Doctor artifact paths must not be symbolic links')
    }
    let fd: number
    try { fd = openSync(lock, 'wx', 0o600) } catch { throw new Error('Doctor download is locked; another download may be active') }
    try {
        if (existsSync(dest)) {
            try { await verifyDoctorArtifact(dest, model); return } catch { /* Preserve old bytes until replacement is verified. */ }
        }
        const mirror = options.mirror || getDoctorMirror()
        if (!mirror) throw new Error('No published Doctor artifact source configured. Set doctorModelMirror to a trusted HTTPS mirror, or import a pinned GGUF into models/.')
        const base = checkedDownloadUrl(mirror)
        if (base.search) throw new Error('Doctor mirror base must not contain a query string')
        const url = checkedDownloadUrl(`${base.href.replace(/\/$/, '')}/${model.filename}`)
        const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000) throw new Error('Invalid Doctor download timeout')
        const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])])
        let start = existsSync(tmp) ? statSync(tmp).size : 0
        if (start === model.sizeBytes) {
            try { await verifyDoctorArtifact(tmp, model); renameSync(tmp, dest); return } catch { start = 0 }
        }
        if (start > model.sizeBytes) start = 0
        const headers: Record<string, string> = { 'User-Agent': `Xaventra-Doctor/${DOCTOR_ARTIFACT_VERSION}`, 'Accept-Encoding': 'identity' }
        // Never infer token destinations from a substring, mirror path, or query.
        if (url.origin === 'https://github.com') {
            const token = process.env.GITHUB_TOKEN || getDoctorConfig().githubToken
            if (token) headers.Authorization = `Bearer ${token}`
        }
        if (start) headers.Range = `bytes=${start}-`
        const res = await fetchUrl(url, headers, signal)
        try {
            if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`Doctor mirror HTTP ${res.statusCode}; artifact unavailable or access denied`)
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new Error('Encoded Doctor artifact response rejected')
            if (res.statusCode === 200) start = 0 // Ignored Range: truncate, NEVER append.
            else if (res.headers['content-range'] !== `bytes ${start}-${model.sizeBytes - 1}/${model.sizeBytes}`) throw new Error('Invalid Doctor Content-Range')
            const length = res.headers['content-length']
            if (length !== undefined && Number(length) !== model.sizeBytes - start) throw new Error('Doctor Content-Length mismatch')
            let received = start, lastPct = -1
            const began = Date.now()
            const meter = new Transform({ transform(chunk, _encoding, callback) {
                received += chunk.length
                if (received > model.sizeBytes) { callback(new Error('Doctor artifact exceeds pinned size')); return }
                const pct = Math.floor(received / model.sizeBytes * 100)
                if (onProgress && pct !== lastPct) {
                    lastPct = pct
                    const speed = (received - start) / Math.max((Date.now() - began) / 1000, 0.001)
                    try { onProgress(pct, `${Math.round(speed / 1024)} KiB/s`, `${Math.ceil((model.sizeBytes - received) / Math.max(speed, 1))}s`) } catch { /* Non-authoritative observer. */ }
                }
                callback(null, chunk)
            } })
            await pipeline(res, meter, createWriteStream(tmp, { flags: start ? 'a' : 'w', mode: 0o600 }), { signal })
            await verifyDoctorArtifact(tmp, model)
            // Same-directory rename replaces atomically; never unlink the old model first.
            renameSync(tmp, dest)
        } finally { res.destroy() }
    } finally { closeSync(fd); unlinkSync(lock) }
}

export async function downloadBestModel(log: (msg: string) => void = console.log): Promise<ModelInfo | null> {
    const model = selectBestModel()
    if (!model) { log('Doctor disabled or no model fits the 40% RAM budget'); return null }
    try {
        await downloadModel(model, (pct) => { if (pct % 10 === 0) log(`Doctor download ${pct}%`) })
        log(`Doctor artifact verified: ${model.filename}`)
        return model
    } catch (err) { log(err instanceof Error ? err.message : 'Doctor download failed'); return null }
}

export async function runDoctorDownloadCli(args: string[]): Promise<number> {
    if (args.length === 1 && args[0] === '--list') {
        console.log(`Doctor artifacts ${DOCTOR_ARTIFACT_VERSION}; inventory is size/presence, not loaded-model status.`)
        for (const m of MODEL_REGISTRY) console.log(`${isArtifactPresent(m) ? 'present' : 'missing'} ${m.filename} ${m.sizeBytes} bytes`)
        return 0
    }
    if (!args.length) return await downloadBestModel() ? 0 : 1
    if (args.length !== 2 || args[0] !== '--model') throw new Error('Usage: doctor:download [--list | --model <exact filename or variant>]')
    const model = MODEL_REGISTRY.find(m => m.filename === args[1] || m.filename === `nova-doctor-${args[1]}.gguf`)
    if (!model) throw new Error('Unknown or ambiguous Doctor model')
    await downloadModel(model)
    console.log(`Doctor artifact verified: ${model.filename}`)
    return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    runDoctorDownloadCli(process.argv.slice(2)).then(code => { process.exitCode = code }, error => {
        console.error(error instanceof Error ? error.message : 'Doctor download failed'); process.exitCode = 1
    })
}
