/**
 * Eigenes Embedding-Modell (2.86, Paket G): fest eingetragene GGUF-Datei.
 *
 * Alfred 02.10.: „lass sie doch ihr eigenes Embedding-Modell mitbringen,
 * llama.cpp hat sie ja eh schon“. Das Modell läuft im Prozess über
 * node-llama-cpp (local-embedder.ts). Bezogen wird es NIE über einen freien
 * Download: nur genau diese Datei (feste Revision, feste Größe, feste sha256)
 * über den signierten Installationskatalog (`embedding-gguf:<name>`, Programm
 * `dist/memory/local-embedder-fetch.js`). Ohne passende Prüfsumme bleibt keine
 * Datei liegen, und eine Datei mit falscher Prüfsumme wird nie geladen.
 *
 * Modellwahl (geprüft 02.10.2026, Quellen im Commit):
 *   Qwen3-Embedding-0.6B, Q8_0, offizielle GGUF von Qwen — Apache-2.0
 *   (Weitergabe/Download erlaubt, nicht gated), 1024 Dimensionen, 100+
 *   Sprachen (Deutsch), 32k Kontext, MTEB multilingual 64.33, Pooling `last`
 *   (steht in der GGUF), 639 150 592 Bytes; läuft auf jeder CPU.
 *   Verworfen: embeddinggemma-300m (Gemma-Lizenz, Basismodell gated),
 *   nomic-embed-text-v1.5 (vorwiegend Englisch, 2024), nomic-embed-text-v2-moe
 *   (mehrsprachig, aber schwächer und MoE-Sonderarchitektur).
 *
 * Diese Datei hat bewusst keine Abhängigkeit zu node-llama-cpp: der Katalog,
 * der Umgebungs-Scan und das Bezugsprogramm laden sie ohne das Modell.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface EmbeddingArtifact {
    /** Katalog-Name (`embedding-gguf:<name>`) und Modellteil der Einbetter-ID. */
    name: string
    filename: string
    /** Feste Revision; nie `main`. */
    url: string
    sizeBytes: number
    sha256: string
    dimension: number
    license: string
    /** Veröffentlichung des Modells (YYYY-MM). */
    releasedAt: string
}

export const EMBEDDING_ARTIFACTS: readonly EmbeddingArtifact[] = Object.freeze([
    Object.freeze({
        name: 'qwen3-embedding-0.6b-q8_0',
        filename: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
        url: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/370f27d7550e0def9b39c1f16d3fbaa13aa67728/Qwen3-Embedding-0.6B-Q8_0.gguf',
        sizeBytes: 639150592,
        sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
        dimension: 1024,
        license: 'Apache-2.0',
        releasedAt: '2025-06',
    }),
])

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/

export function validateEmbeddingArtifact(artifact: EmbeddingArtifact): void {
    if (!artifact || !NAME_PATTERN.test(artifact.name) || basename(artifact.filename) !== artifact.filename || !/^[\w.-]+\.gguf$/.test(artifact.filename)
        || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+\.gguf$/.test(artifact.url) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 8 || !Number.isInteger(artifact.dimension) || artifact.dimension < 1) {
        throw new Error('Embedding-Modell braucht festen Namen, GGUF-Datei, https-URL, Größe und sha256')
    }
}

export function findEmbeddingArtifact(name: unknown, artifacts: readonly EmbeddingArtifact[] = EMBEDDING_ARTIFACTS): EmbeddingArtifact | undefined {
    return typeof name === 'string' ? artifacts.find(item => item.name === name) : undefined
}

/** Programm-Wurzel (dist/memory/.. /.. bzw. src/memory/../..). */
function appRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * Ordner der eigenen Embedding-Modelle: `<Programm>/models/embedding`
 * (dort legt auch das Katalog-Programm ab), überschreibbar mit
 * `XAVENTRA_EMBEDDING_MODEL_DIR`.
 */
export function embeddingModelsDir(): string {
    const override = String(process.env.XAVENTRA_EMBEDDING_MODEL_DIR || '').trim()
    return override || join(appRoot(), 'models', 'embedding')
}

/** Billige Bestandsaufnahme (Datei da, Größe stimmt) — kein Integritätsbeleg. */
export function findInstalledEmbeddingArtifact(dir = embeddingModelsDir(), artifacts: readonly EmbeddingArtifact[] = EMBEDDING_ARTIFACTS): EmbeddingArtifact | null {
    for (const artifact of artifacts) {
        try {
            const stat = statSync(join(dir, artifact.filename))
            if (stat.isFile() && stat.size === artifact.sizeBytes) return artifact
        } catch { /* nicht vorhanden */ }
    }
    return null
}

/** Volle Prüfung: Größe, GGUF-Kennung, sha256. Wirft bei Abweichung. */
export async function verifyEmbeddingArtifact(path: string, artifact: EmbeddingArtifact): Promise<void> {
    validateEmbeddingArtifact(artifact)
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== artifact.sizeBytes) throw new Error('Embedding-Modell: Größe stimmt nicht')
    const hash = createHash('sha256')
    let prefix = Buffer.alloc(0)
    for await (const chunk of createReadStream(path)) {
        const bytes = Buffer.from(chunk)
        if (prefix.length < 4) prefix = Buffer.concat([prefix, bytes.subarray(0, 4 - prefix.length)])
        hash.update(bytes)
    }
    if (prefix.toString('ascii') !== 'GGUF' || hash.digest('hex') !== artifact.sha256) throw new Error('Embedding-Modell: sha256/GGUF-Prüfung fehlgeschlagen')
}

export interface InstallEmbeddingOptions {
    dir?: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
}

/**
 * Lädt genau die eingetragene Datei, prüft Größe + sha256 + GGUF und legt sie
 * erst danach atomar ab. Schon vorhanden und geprüft: nichts zu tun.
 */
export async function installEmbeddingArtifact(artifact: EmbeddingArtifact, options: InstallEmbeddingOptions = {}): Promise<{ status: 'installiert' | 'vorhanden'; path: string }> {
    validateEmbeddingArtifact(artifact)
    const dir = options.dir || embeddingModelsDir()
    const target = join(dir, artifact.filename)
    if (existsSync(target)) {
        try { await verifyEmbeddingArtifact(target, artifact); return { status: 'vorhanden', path: target } } catch { /* neu laden */ }
    }
    mkdirSync(dir, { recursive: true })
    const part = `${target}.part`
    const fetchImpl = options.fetchImpl || fetch
    try {
        const response = await fetchImpl(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? 25 * 60_000) })
        if (!response.ok || !response.body) throw new Error(`Download fehlgeschlagen (HTTP ${response.status})`)
        const hash = createHash('sha256')
        let size = 0
        const meter = new Transform({
            transform(chunk, _encoding, done) {
                size += chunk.length
                if (size > artifact.sizeBytes) { done(new Error('Embedding-Modell: Datei größer als eingetragen')); return }
                hash.update(chunk)
                done(null, chunk)
            },
        })
        await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(part, { mode: 0o644 }))
        if (size !== artifact.sizeBytes) throw new Error('Embedding-Modell: Größe stimmt nicht')
        if (hash.digest('hex') !== artifact.sha256) throw new Error('Embedding-Modell: sha256 stimmt nicht')
        await verifyEmbeddingArtifact(part, artifact)
        renameSync(part, target)
        return { status: 'installiert', path: target }
    } catch (error) {
        try { unlinkSync(part) } catch { /* nichts angelegt */ }
        throw error
    }
}

/** Rückweg: entfernt genau die eingetragene Datei (und eine halbe .part). */
export async function removeEmbeddingArtifact(artifact: EmbeddingArtifact, dir = embeddingModelsDir()): Promise<void> {
    validateEmbeddingArtifact(artifact)
    for (const file of [join(dir, artifact.filename), join(dir, `${artifact.filename}.part`)]) {
        try { unlinkSync(file) } catch { /* nicht vorhanden */ }
    }
}
