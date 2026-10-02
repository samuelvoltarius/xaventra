/**
 * Eigener Einbetter im Prozess (2.86, Paket G) über node-llama-cpp.
 *
 * Lädt die fest eingetragene GGUF-Datei (embedding-artifacts.ts) erst nach
 * voller sha256-Prüfung. Standard ist die CPU (`gpu: false`, `build: 'never'`;
 * das CPU-Prebuilt `@node-llama-cpp/<os>-<arch>` liegt jedem Release bei, die
 * GPU-Varianten nicht — native-optional-prune.ts):
 * läuft auf jeder Maschine und nimmt am Spark dem vLLM keinen GPU-Speicher.
 * `XAVENTRA_EMBEDDING_GPU=1` erlaubt die GPU, `XAVENTRA_EMBEDDING_INPROCESS=0`
 * schaltet den eigenen Einbetter ab. Ohne Modelldatei wird node-llama-cpp gar
 * nicht geladen. Ein gescheiterter Ladeversuch wird 10 min gemerkt.
 */
import { cpus } from 'node:os'
import { join } from 'node:path'
import { EMBEDDING_ARTIFACTS, embeddingModelsDir, findInstalledEmbeddingArtifact, verifyEmbeddingArtifact, type EmbeddingArtifact } from './embedding-artifacts.js'

export interface InProcessEmbedder {
    /** Artefakt-Name (Modellteil der Einbetter-ID). */
    model: string
    embed(text: string): Promise<number[] | null>
    dispose?(): Promise<void>
}

type LlamaModule = typeof import('node-llama-cpp')

export interface LoadEmbedderOptions {
    dir?: string
    artifacts?: readonly EmbeddingArtifact[]
    loader?: () => Promise<LlamaModule>
    /** Kontextgröße in Token (Standard 2048); längere Texte werden gekürzt. */
    contextTokens?: number
    gpu?: boolean
}

/** Qwen3-Embedding erwartet das Ende-Token `<|endoftext|>` am Schluss (Pooling `last`). */
const END_OF_TEXT = '<|endoftext|>'
const reportedFailures = new Set<string>()

function normalize(vector: readonly number[]): number[] | null {
    if (!vector?.length || !vector.every(Number.isFinite)) return null
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    if (!magnitude) return null
    return vector.map(value => Math.round((value / magnitude) * 1e6) / 1e6)
}

/**
 * Lädt den eigenen Einbetter oder null (kein Modell da, Prüfung oder Laden
 * gescheitert). Wirft nie.
 */
export async function loadInProcessEmbedder(options: LoadEmbedderOptions = {}): Promise<InProcessEmbedder | null> {
    const dir = options.dir || embeddingModelsDir()
    const artifact = findInstalledEmbeddingArtifact(dir, options.artifacts || EMBEDDING_ARTIFACTS)
    if (!artifact) return null
    const path = join(dir, artifact.filename)
    let llama: any = null
    try {
        await verifyEmbeddingArtifact(path, artifact)
        const { getLlama, LlamaLogLevel } = await (options.loader || (() => import('node-llama-cpp')))()
        const threads = Math.max(1, Math.min(4, Math.floor(cpus().length / 4)))
        llama = await getLlama({ gpu: options.gpu === true ? 'auto' : false, build: 'never', logLevel: LlamaLogLevel.warn } as any)
        const model = await llama.loadModel({ modelPath: path })
        const contextTokens = options.contextTokens ?? 2048
        const context = await model.createEmbeddingContext({ contextSize: contextTokens, threads })
        const special = model.tokenize(END_OF_TEXT, true)
        const endToken = special.length === 1 ? special[0] : model.tokens?.eos ?? null
        let queue: Promise<unknown> = Promise.resolve()
        const embedOne = async (text: string): Promise<number[] | null> => {
            const tokens = model.tokenize(String(text || ''))
            const room = endToken === null ? contextTokens : contextTokens - 1
            const input = [...tokens.slice(0, Math.max(1, room)), ...(endToken === null ? [] : [endToken])]
            const embedding = await context.getEmbeddingFor(input)
            return normalize(embedding.vector)
        }
        console.log(`[Embeddings] Eigener Einbetter geladen: ${artifact.name} (${artifact.dimension} Dim., ${options.gpu ? 'GPU erlaubt' : 'CPU'})`)
        return {
            model: artifact.name,
            // Ein Kontext, nacheinander: kein paralleles Rechnen auf derselben Sequenz.
            embed: (text: string) => {
                const run = queue.then(() => embedOne(text), () => embedOne(text))
                queue = run.catch(() => undefined)
                return run.catch(() => null)
            },
            async dispose() {
                await context.dispose().catch(() => undefined)
                await model.dispose().catch(() => undefined)
                await llama.dispose().catch(() => undefined)
            },
        }
    } catch (error) {
        // Einmal je Prozess melden; der nächste Rang (Mesh-Ollama, sonst Hash) übernimmt.
        if (!reportedFailures.has(artifact.name)) {
            reportedFailures.add(artifact.name)
            console.warn(`[Embeddings] Eigener Einbetter ${artifact.name} nicht nutzbar (${String((error as Error)?.message || error).slice(0, 200)}); nächster Rang übernimmt (Mesh-Ollama, sonst Hash). Kein Kompilieren am Zielrechner.`)
        }
        if (llama) await llama.dispose().catch(() => undefined)
        return null
    }
}

let instance: InProcessEmbedder | null = null
let pending: Promise<InProcessEmbedder | null> | null = null
let failedAt = 0
const RETRY_AFTER_MS = 10 * 60_000

/** Standard-Quelle für embedding-providers.ts (einmal je Prozess geladen). */
export async function getInProcessEmbedder(): Promise<InProcessEmbedder | null> {
    if (process.env.XAVENTRA_EMBEDDING_INPROCESS === '0') return null
    if (instance) return instance
    if (pending) return pending
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return null
    if (!findInstalledEmbeddingArtifact()) return null
    pending = loadInProcessEmbedder({ gpu: process.env.XAVENTRA_EMBEDDING_GPU === '1' })
        .then(result => { instance = result; failedAt = result ? 0 : Date.now(); return result })
        .finally(() => { pending = null })
    return pending
}

/** Beim Herunterfahren bzw. nach einer Modell-Entfernung. */
export async function disposeInProcessEmbedder(): Promise<void> {
    const current = instance
    instance = null
    failedAt = 0
    if (current?.dispose) await current.dispose()
}
