/**
 * Eine GPU-Quelle (2.82.0 Aufräumen „Inventar“). Öffentlich über
 * doctor/gpu-runtime.ts; als Blatt-Modul ohne Projekt-Importe, damit auch
 * llama-engine es ohne Importkreis nutzen kann.
 *
 * Vorher rief jedes Modul `nvidia-smi` selbst auf — der Mesh-Heartbeat sogar
 * synchron alle 60 s (bis 1,5 s blockierte Ereignisschleife), dazu
 * hardware-role, vram-manager, mesh-registry, model-pricing, Denken,
 * llama-engine und gpu-runtime. Jetzt:
 *   - feste Angaben (Name, Gesamtspeicher, CUDA-Version) einmal je Prozess;
 *   - wechselnde Werte (freier Speicher, Leistung, Auslastung) asynchron
 *     (`execFile`, kein Shell) mit Cache und geteilter laufender Abfrage;
 *   - `cachedNvidiaQuery` liefert sofort den letzten Wert und stößt bei
 *     Bedarf eine Auffrischung im Hintergrund an — nie blockierend.
 */
import { execFile, spawnSync } from 'node:child_process'

export interface NvidiaStaticInfo { name: string; memoryTotalMb: number | null; cudaVersion: string | null }

const FIELD = /^[a-z][a-z0-9._]{1,40}$/
let staticInfo: NvidiaStaticInfo | null | undefined
const values = new Map<string, { at: number; rows: string[][] | null }>()
const inflight = new Map<string, Promise<string[][] | null>>()

type RunSync = (args: string[]) => { status: number | null; stdout: string }
type RunAsync = (args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }>
let runSync: RunSync = args => {
    const result = spawnSync('nvidia-smi', args, { encoding: 'utf8', timeout: 4_000, windowsHide: true })
    return { status: result.status, stdout: String(result.stdout || '') }
}
let runAsync: RunAsync = (args, timeoutMs) => new Promise(resolve => {
    try {
        execFile('nvidia-smi', args, { shell: false, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || '') }))
    } catch { resolve({ ok: false, stdout: '' }) }
})

const parseRows = (stdout: string): string[][] => stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => line.split(',').map(part => part.trim()))

/** Name, total memory and CUDA version of the first NVIDIA GPU — read once per process; null without nvidia-smi. */
export function nvidiaStaticInfo(): NvidiaStaticInfo | null {
    if (staticInfo !== undefined) return staticInfo
    try {
        const query = runSync(['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
        const row = query.status === 0 ? parseRows(query.stdout)[0] : undefined
        if (!row?.[0]) { staticInfo = null; return null }
        const total = Number.parseInt(row[1] ?? '', 10)
        let cudaVersion: string | null = null
        try { cudaVersion = runSync([]).stdout.match(/CUDA Version:\s*([\d.]+)/)?.[1] ?? null } catch { cudaVersion = null }
        staticInfo = { name: row[0], memoryTotalMb: Number.isFinite(total) && total > 0 ? total : null, cudaVersion }
    } catch { staticInfo = null }
    return staticInfo
}

/** Live values (e.g. `memory.free`, `power.draw`, `utilization.gpu`): one row per GPU, null without nvidia-smi. */
export async function queryNvidia(fields: string[], options: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<string[][] | null> {
    if (!fields.length || fields.some(field => !FIELD.test(field))) return null
    const key = fields.join(',')
    const cached = values.get(key)
    if (cached && Date.now() - cached.at < (options.maxAgeMs ?? 60_000)) return cached.rows
    const running = inflight.get(key)
    if (running) return running
    if (staticInfo === null) return null // no NVIDIA GPU: never spawn again
    const run = runAsync([`--query-gpu=${key}`, '--format=csv,noheader,nounits'], options.timeoutMs ?? 4_000)
        .then(result => {
            const rows = result.ok ? parseRows(result.stdout) : null
            values.set(key, { at: Date.now(), rows })
            return rows
        })
        .finally(() => inflight.delete(key))
    inflight.set(key, run)
    return run
}

/** Last known value without waiting; refreshes in the background when older than `maxAgeMs`. */
export function cachedNvidiaQuery(fields: string[], maxAgeMs = 60_000): string[][] | null {
    const key = fields.join(',')
    const cached = values.get(key)
    if (!cached || Date.now() - cached.at >= maxAgeMs) void queryNvidia(fields, { maxAgeMs }).catch(() => null)
    return cached?.rows ?? null
}

/** Tests only. */
export function resetNvidiaSmi(options: { runSync?: RunSync; runAsync?: RunAsync } = {}): void {
    staticInfo = undefined
    values.clear()
    inflight.clear()
    if (options.runSync) runSync = options.runSync
    if (options.runAsync) runAsync = options.runAsync
}
