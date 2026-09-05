/**
 * Nova Doctor — Model Downloader
 *
 * Downloads GGUF models from GitHub Releases into models/ directory.
 * Called by: nova-boot, nova setup, nova doctor --download
 *
 * Hardware-adaptive: only downloads what fits available RAM.
 * Resumable: skips files that already exist with correct size.
 *
 * GitHub Release URL pattern:
 *   https://github.com/samuelvoltarius/xaventra/releases/download/v{version}/nova-doctor-{variant}.gguf
 *
 * Or custom mirror via nova.config.json:
 *   { "doctorModelMirror": "https://your-server.com/models/" }
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import { get as httpsGet } from 'node:https'
import { get as httpGet, IncomingMessage } from 'node:http'

// ─── Model Registry ───────────────────────────────────────────────────────────

export interface ModelInfo {
    filename: string
    sizeMB: number       // approximate download size
    minRamGB: number     // minimum RAM to run this model
    quality: number      // 1-5
    description: string
}

export const MODEL_REGISTRY: ModelInfo[] = [
    {
        filename: 'nova-doctor-1.5b-q5km.gguf',
        sizeMB: 1100,
        minRamGB: 6,
        quality: 5,
        description: '1.5B — Best quality (GPU / strong CPU, ≥ 6 GB)',
    },
    {
        filename: 'nova-doctor-1.5b-q4km.gguf',
        sizeMB: 941,
        minRamGB: 4,
        quality: 4,
        description: '1.5B — Balanced (CPU ≥ 4 GB RAM)',
    },
    {
        filename: 'nova-doctor-1.5b-q2k.gguf',
        sizeMB: 645,
        minRamGB: 3,
        quality: 2,
        description: '1.5B — Compact (CPU ≥ 3 GB RAM)',
    },
    {
        filename: 'nova-doctor-0.5b-q5km.gguf',
        sizeMB: 401,
        minRamGB: 2,
        quality: 3,
        description: '0.5B — Fast & light (CPU ≥ 2 GB RAM)',
    },
    {
        filename: 'nova-doctor-0.5b-q4km.gguf',
        sizeMB: 380,
        minRamGB: 1.5,
        quality: 2,
        description: '0.5B — Compact (CPU ≥ 1.5 GB RAM)',
    },
    {
        filename: 'nova-doctor-0.5b-q2k.gguf',
        sizeMB: 323,
        minRamGB: 0.5,
        quality: 1,
        description: '0.5B — Minimal / kartoffel mode (any machine)',
    },
]

// ─── Config ───────────────────────────────────────────────────────────────────

const MODELS_DIR = join(process.cwd(), 'models')
const GITHUB_RELEASE_BASE = 'https://github.com/samuelvoltarius/xaventra/releases/download'
const NOVA_VERSION = '2.58.0'

function getMirrorBase(): string {
    try {
        const { readFileSync } = require('node:fs')
        const cfg = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
        if (cfg.doctorModelMirror) return cfg.doctorModelMirror.replace(/\/$/, '')
    } catch { /* no config */ }
    return `${GITHUB_RELEASE_BASE}/v${NOVA_VERSION}`
}

/**
 * Read GitHub token for private-repo release asset downloads.
 * Priority: GITHUB_TOKEN env → nova.config.json githubToken
 */
function getGithubToken(): string | null {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
    try {
        const { readFileSync } = require('node:fs')
        const cfg = JSON.parse(readFileSync(join(process.cwd(), 'nova.config.json'), 'utf-8'))
        if (cfg.githubToken) return cfg.githubToken
    } catch { /* no config */ }
    return null
}

function getSystemRamGB(): number {
    return totalmem() / (1024 ** 3)
}

// ─── Model Selection ──────────────────────────────────────────────────────────

/**
 * Pick the best model that fits available RAM (40% budget).
 * Returns null if all are too large.
 */
export function selectBestModel(): ModelInfo | null {
    const ramBudgetGB = getSystemRamGB() * 0.4
    return MODEL_REGISTRY
        .filter(m => m.minRamGB <= ramBudgetGB)
        .sort((a, b) => b.quality - a.quality)[0] ?? MODEL_REGISTRY[MODEL_REGISTRY.length - 1]
}

/**
 * Check which models are already on disk.
 */
export function getInstalledModels(): ModelInfo[] {
    if (!existsSync(MODELS_DIR)) return []
    return MODEL_REGISTRY.filter(m => existsSync(join(MODELS_DIR, m.filename)))
}

// ─── Download ─────────────────────────────────────────────────────────────────

function fetchUrl(
    url: string,
    extraHeaders: Record<string, string> = {},
    _depth = 0
): Promise<IncomingMessage> {
    if (_depth > 5) return Promise.reject(new Error('Too many redirects'))

    return new Promise((resolve, reject) => {
        const getter = url.startsWith('https') ? httpsGet : httpGet
        const reqHeaders: Record<string, string> = {
            'User-Agent': 'nova-core/2.58.0',
            ...extraHeaders,
        }
        const req = getter(url, { headers: reqHeaders }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                const location = res.headers.location
                if (!location) return reject(new Error('Redirect with no location'))

                // Strip auth headers on cross-host redirects (e.g. GitHub → S3).
                // S3 pre-signed URLs reject requests that have an Authorization header.
                const fromHost = new URL(url).host
                const toHost   = new URL(location).host
                const nextHeaders = fromHost === toHost ? extraHeaders : {}

                resolve(fetchUrl(location, nextHeaders, _depth + 1))
            } else {
                resolve(res)
            }
        })
        req.on('error', reject)
    })
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export async function downloadModel(
    model: ModelInfo,
    onProgress?: (pct: number, speed: string, eta: string) => void
): Promise<void> {
    if (!existsSync(MODELS_DIR)) {
        mkdirSync(MODELS_DIR, { recursive: true })
    }

    const dest = join(MODELS_DIR, model.filename)
    const tmp  = dest + '.download'
    const url  = `${getMirrorBase()}/${model.filename}`

    // Skip if already complete (within 1% size tolerance)
    if (existsSync(dest)) {
        const size = statSync(dest).size
        const expectedBytes = model.sizeMB * 1024 * 1024
        if (Math.abs(size - expectedBytes) / expectedBytes < 0.01) {
            console.log(`  ✅ ${model.filename} already downloaded`)
            return
        }
    }

    // Resume partial download
    let startByte = 0
    if (existsSync(tmp)) {
        startByte = statSync(tmp).size
        console.log(`  ↻ Resuming ${model.filename} from ${formatBytes(startByte)}`)
    }

    console.log(`  ⬇ Downloading ${model.filename} (${model.sizeMB} MB)`)
    console.log(`    from: ${url}`)

    // Build auth headers — needed for private GitHub repos
    const token = getGithubToken()
    const authHeaders: Record<string, string> = {}
    if (token && url.includes('github.com')) {
        authHeaders['Authorization'] = `Bearer ${token}`
        authHeaders['Accept'] = 'application/octet-stream'
    }
    if (startByte > 0) authHeaders['Range'] = `bytes=${startByte}-`

    const res = await fetchUrl(url, authHeaders)

    if (res.statusCode === 401 || res.statusCode === 404) {
        const hint = token
            ? `HTTP ${res.statusCode} — token may be invalid or lacks 'repo' scope`
            : `HTTP ${res.statusCode} — repo is private. Set GITHUB_TOKEN env var or add "githubToken" to nova.config.json`
        throw new Error(hint)
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
        throw new Error(`HTTP ${res.statusCode} for ${url}`)
    }

    const totalBytes = startByte + parseInt(res.headers['content-length'] ?? '0', 10)
    let downloaded = startByte
    let lastReported = 0
    const startTime = Date.now()

    const writer = createWriteStream(tmp, { flags: startByte > 0 ? 'a' : 'w' })

    await new Promise<void>((resolve, reject) => {
        res.on('data', (chunk: Buffer) => {
            writer.write(chunk)
            downloaded += chunk.length

            if (totalBytes > 0 && onProgress) {
                const pct = Math.round(downloaded / totalBytes * 100)
                if (pct !== lastReported && pct % 5 === 0) {
                    lastReported = pct
                    const elapsed = (Date.now() - startTime) / 1000
                    const speed = downloaded / elapsed
                    const remaining = (totalBytes - downloaded) / speed
                    onProgress(
                        pct,
                        `${formatBytes(speed)}/s`,
                        remaining > 60
                            ? `${Math.round(remaining / 60)}min`
                            : `${Math.round(remaining)}s`
                    )
                }
            }
        })
        res.on('end', () => writer.end(resolve))
        res.on('error', reject)
        writer.on('error', reject)
    })

    // Rename tmp → final
    if (existsSync(dest)) unlinkSync(dest)
    const { renameSync } = await import('node:fs')
    renameSync(tmp, dest)

    console.log(`  ✅ ${model.filename} — ${formatBytes(downloaded)}`)
}

// ─── Public Helpers ───────────────────────────────────────────────────────────

/**
 * Download the best model for this machine.
 * Called by nova-boot and nova setup.
 */
export async function downloadBestModel(
    log: (msg: string) => void = console.log
): Promise<ModelInfo | null> {
    const model = selectBestModel()
    if (!model) {
        log('⚠ No suitable model found for this hardware')
        return null
    }

    const ramGB = Math.round(getSystemRamGB() * 10) / 10
    log(`\n🏥 Nova Doctor Model Setup`)
    log(`   RAM: ${ramGB} GB → selected: ${model.filename}`)
    log(`   ${model.description}`)

    try {
        await downloadModel(model, (pct, speed, eta) => {
            log(`   ${pct}% — ${speed} — ETA: ${eta}`)
        })
        return model
    } catch (err: any) {
        log(`❌ Download failed: ${err.message}`)
        log(`   Manual install: copy GGUF to models/${model.filename}`)
        return null
    }
}

/**
 * CLI entry point: `node dist/llm/download-models.js`
 */
async function main() {
    const args = process.argv.slice(2)

    if (args.includes('--list')) {
        const ramGB = Math.round(getSystemRamGB() * 10) / 10
        const budget = ramGB * 0.4
        const token = getGithubToken()
        const authHint = token ? '🔑 GITHUB_TOKEN set' : '⚠ No GITHUB_TOKEN (required for private repo)'
        console.log(`\nAvailable models (RAM: ${ramGB} GB, budget: ${budget.toFixed(1)} GB) — ${authHint}:\n`)
        for (const m of MODEL_REGISTRY) {
            const fits = m.minRamGB <= budget
            const installed = existsSync(join(MODELS_DIR, m.filename))
            const mark = installed ? '✅' : fits ? '⬇' : '⚠'
            console.log(`  ${mark} ${m.filename.padEnd(35)} ${m.sizeMB.toString().padStart(5)} MB  — ${m.description}`)
        }
        console.log()
        return
    }

    // --model <filename> downloads specific model
    const modelArg = args[args.indexOf('--model') + 1]
    if (modelArg) {
        const model = MODEL_REGISTRY.find(m => m.filename === modelArg || m.filename.includes(modelArg))
        if (!model) {
            console.error(`Unknown model: ${modelArg}`)
            process.exit(1)
        }
        await downloadModel(model, (pct, speed, eta) => {
            process.stdout.write(`\r  ${pct}% — ${speed} — ETA: ${eta}   `)
        })
        console.log()
        return
    }

    // Default: download best model for this machine
    await downloadBestModel()
}

if (process.argv[1]?.endsWith('download-models.js') || process.argv[1]?.endsWith('download-models.ts')) {
    main().catch(err => { console.error(err); process.exit(1) })
}
