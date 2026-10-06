/**
 * 2.86 Paket O: der lokale Sprachdienst als fest eingetragenes Bündel.
 *
 * Übernommen aus den Messungen des Voice-Labs (Codex 03.10.2026,
 * .nova-data/voice-benchmark): Silero VAD → Nemotron 3.5 Streaming INT8
 * (sherpa-onnx, 560 ms) → Piper/VITS „Ramona“ (weiblich, Standard) bzw.
 * „Thorsten“ (männlich). Laufzeit ist sherpa-onnx für Node (vorgebaut, keine
 * Install-Skripte) statt der Python-App des Labs — so braucht der Knopf im
 * Werkzeugkasten weder pip noch eine Shell.
 *
 * Bezogen wird NIE frei: nur genau diese Dateien (feste URL, Größe, sha256),
 * über den signierten Installationskatalog (`sprachdienst:de`, Programm
 * `dist/voice/voice-bundle-fetch.js`). Erst geprüft, dann entpackt, dann atomar
 * abgelegt. Rückweg entfernt genau den Bündel-Ordner.
 *
 * Quellen/Lizenzen (geprüft 06.10.2026):
 * - Silero VAD int8 (sherpa-onnx asr-models, sha256 aus GitHub-Release-Digest), MIT (snakers4/silero-vad)
 * - Nemotron 3.5 ASR Streaming 0.6B 560 ms int8 (sherpa-onnx-Export 2026-06-11) von
 *   nvidia/nemotron-3.5-asr-streaming-0.6b, Lizenz OpenMDW-1.1 (Hugging-Face-Modellkarte)
 * - Piper de_DE ramona low / thorsten medium (sherpa-onnx tts-models; rhasspy/piper-voices MIT;
 *   Daten: Ramona = M-AILABS (gemeinfreie LibriVox-Aufnahmen), Thorsten = CC0)
 * - sherpa-onnx-node 1.13.8 + vorgebautes Linux-Addon (npm, Apache-2.0, ohne Install-Skripte)
 * Parakeet TDT 0.6B v3 (genauer Final-Pass, CC-BY-4.0, 487 MB) ist bewusst nicht
 * im Standardbündel; er kann später als eigener Baustein dazukommen.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getRuntimeRoot } from '../core/data-root.js'

export type VoicePartKind = 'file' | 'tar-bz2' | 'tgz'

export interface VoicePart {
    name: string
    kind: VoicePartKind
    url: string
    filename: string
    sizeBytes: number
    sha256: string
    license: string
    /** Herkunft (Modellkarte / Projektseite) als Beleg. */
    source: string
    /** Ziel relativ zum Bündel-Ordner (Datei bzw. Ordner nach dem Entpacken). */
    target: string
    /** Dateien relativ zu `target`, die nach dem Entpacken da sein müssen. */
    markers: string[]
    /** Nur für diese CPU-Architektur (vorgebautes Addon). */
    arch?: 'x64' | 'arm64'
}

export interface VoiceBundle { name: string; parts: readonly VoicePart[] }

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
const NPM = 'https://registry.npmjs.org'

export const VOICE_BUNDLE: VoiceBundle = Object.freeze({
    name: 'de',
    parts: Object.freeze([
        {
            name: 'silero-vad', kind: 'file', url: `${GH}/asr-models/silero_vad.int8.onnx`, filename: 'silero_vad.int8.onnx',
            sizeBytes: 212860, sha256: 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20',
            license: 'MIT', source: 'https://github.com/snakers4/silero-vad', target: 'models/silero_vad.int8.onnx', markers: [],
        },
        {
            name: 'nemotron-de-560ms', kind: 'tar-bz2',
            url: `${GH}/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2`,
            filename: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2',
            sizeBytes: 475271763, sha256: 'c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a',
            license: 'OpenMDW-1.1', source: 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b',
            target: 'models/nemotron-de-560ms', markers: ['tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx'],
        },
        {
            name: 'piper-ramona', kind: 'tar-bz2', url: `${GH}/tts-models/vits-piper-de_DE-ramona-low.tar.bz2`, filename: 'vits-piper-de_DE-ramona-low.tar.bz2',
            sizeBytes: 67084795, sha256: '79f985c10f86c4d58205b519abc488aa65eb713d54665ff729880a02e2625a42',
            license: 'MIT (Stimme), Daten M-AILABS', source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/ramona/low',
            target: 'models/piper-ramona', markers: ['de_DE-ramona-low.onnx', 'tokens.txt', 'espeak-ng-data'],
        },
        {
            name: 'piper-thorsten', kind: 'tar-bz2', url: `${GH}/tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2`, filename: 'vits-piper-de_DE-thorsten-medium.tar.bz2',
            sizeBytes: 67214254, sha256: '50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714',
            license: 'MIT (Stimme), Daten CC0', source: 'https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE/thorsten/medium',
            target: 'models/piper-thorsten', markers: ['de_DE-thorsten-medium.onnx', 'tokens.txt', 'espeak-ng-data'],
        },
        {
            name: 'sherpa-onnx-node', kind: 'tgz', url: `${NPM}/sherpa-onnx-node/-/sherpa-onnx-node-1.13.8.tgz`, filename: 'sherpa-onnx-node-1.13.8.tgz',
            sizeBytes: 11954, sha256: 'db2a7b8b18d950b6e9ca5c1c919afec33fd3dd2bfef1aade0bea5a9fe7a1f0f1',
            license: 'Apache-2.0', source: 'https://github.com/k2-fsa/sherpa-onnx', target: 'node_modules/sherpa-onnx-node', markers: ['sherpa-onnx.js', 'addon.js'],
        },
        {
            name: 'sherpa-onnx-linux-x64', kind: 'tgz', arch: 'x64', url: `${NPM}/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz`, filename: 'sherpa-onnx-linux-x64-1.13.8.tgz',
            sizeBytes: 11089653, sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c',
            license: 'Apache-2.0', source: 'https://github.com/k2-fsa/sherpa-onnx', target: 'node_modules/sherpa-onnx-linux-x64', markers: ['sherpa-onnx.node'],
        },
        {
            name: 'sherpa-onnx-linux-arm64', kind: 'tgz', arch: 'arm64', url: `${NPM}/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-1.13.8.tgz`, filename: 'sherpa-onnx-linux-arm64-1.13.8.tgz',
            sizeBytes: 13910679, sha256: 'e1671ad6e94e51947229a5736d06022780f3fba967da8d917173cd9765902ee8',
            license: 'Apache-2.0', source: 'https://github.com/k2-fsa/sherpa-onnx', target: 'node_modules/sherpa-onnx-linux-arm64', markers: ['sherpa-onnx.node'],
        },
    ].map(part => Object.freeze(part as VoicePart))),
})

/** Geschätzter Platz nach dem Entpacken (MB) für den Katalog. */
export const VOICE_BUNDLE_SIZE_MB = 1100

const NAME = /^[a-z0-9][a-z0-9.-]{0,60}$/
const TARGET = /^(?:models|node_modules)\/[A-Za-z0-9._-]+$/

export function validateVoicePart(part: VoicePart): void {
    if (!part || !NAME.test(part.name) || !['file', 'tar-bz2', 'tgz'].includes(part.kind)
        || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/@-]+$/.test(part.url) || !/^[a-f0-9]{64}$/.test(part.sha256)
        || !/^[A-Za-z0-9._-]+$/.test(part.filename) || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 1
        || !String(part.license || '').trim() || !/^https:\/\//.test(part.source) || !TARGET.test(part.target)
        || !Array.isArray(part.markers) || part.markers.some(marker => !/^[A-Za-z0-9._-]+$/.test(marker))) {
        throw new Error(`Sprach-Baustein ${String(part?.name)}: braucht festen Namen, https-URL, Größe, sha256, Lizenz und Herkunft`)
    }
}

/** `<Laufzeit-Wurzel>/voice`, überschreibbar mit XAVENTRA_VOICE_DIR. */
export function voiceBundleDir(): string {
    const override = String(process.env.XAVENTRA_VOICE_DIR || '').trim()
    return override || join(getRuntimeRoot(), 'voice')
}

export function isSafeVoiceDir(dir: unknown): dir is string {
    return typeof dir === 'string' && dir.length > 1 && dir.length < 400 && isAbsolute(dir) && !dir.split(/[\\/]/).includes('..')
}

function partsFor(bundle: VoiceBundle, arch: string): VoicePart[] {
    return bundle.parts.filter(part => !part.arch || part.arch === arch)
}

function targetPath(dir: string, part: VoicePart): string { return join(dir, ...part.target.split(posix.sep)) }

function partPresent(dir: string, part: VoicePart): boolean {
    const target = targetPath(dir, part)
    try {
        if (part.kind === 'file') return statSync(target).isFile() && statSync(target).size === part.sizeBytes
        return statSync(target).isDirectory() && part.markers.every(marker => existsSync(join(target, marker)))
    } catch { return false }
}

interface Receipt { bundle: string; parts: Array<{ name: string; sha256: string }>; installedAt: string }

/** Prüft Quittung (gleiche eingetragene Prüfsummen) und dass alle Dateien da sind. Wirft bei Abweichung. */
export async function verifyVoiceBundle(bundle: VoiceBundle = VOICE_BUNDLE, dir = voiceBundleDir(), arch: string = process.arch): Promise<void> {
    let receipt: Receipt
    try { receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) } catch { throw new Error('Sprachdienst: nicht installiert') }
    for (const part of partsFor(bundle, arch)) {
        validateVoicePart(part)
        const recorded = receipt.parts?.find(item => item.name === part.name)
        if (!recorded || recorded.sha256 !== part.sha256) throw new Error(`Sprachdienst: ${part.name} passt nicht zur eingetragenen Prüfsumme`)
        if (!partPresent(dir, part)) throw new Error(`Sprachdienst: ${part.name} fehlt`)
    }
}

export type Extractor = (archive: string, into: string, kind: VoicePartKind) => Promise<void>

/** Entpackt ohne Shell (`tar` mit Argument-Array). Das Archiv ist vorher sha256-geprüft. */
export const tarExtract: Extractor = (archive, into, kind) => new Promise((resolve, reject) => {
    const flags = kind === 'tgz' ? '-xzf' : '-xjf'
    execFile('tar', ['--no-same-owner', '--no-same-permissions', flags, archive, '-C', into], { timeout: 20 * 60_000 }, error => error ? reject(new Error(`Entpacken fehlgeschlagen: ${error.message}`)) : resolve())
})

export interface InstallVoiceOptions {
    dir?: string
    fetchImpl?: typeof fetch
    extract?: Extractor
    arch?: string
    timeoutMs?: number
}

async function download(part: VoicePart, file: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<void> {
    const response = await fetchImpl(part.url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok || !response.body) throw new Error(`${part.name}: Download fehlgeschlagen (HTTP ${response.status})`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
        transform(chunk, _encoding, done) {
            size += chunk.length
            if (size > part.sizeBytes) { done(new Error(`${part.name}: Datei größer als eingetragen`)); return }
            hash.update(chunk)
            done(null, chunk)
        },
    })
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(file, { mode: 0o644 }))
    if (size !== part.sizeBytes) throw new Error(`${part.name}: Größe stimmt nicht`)
    if (hash.digest('hex') !== part.sha256) throw new Error(`${part.name}: sha256 stimmt nicht`)
}

/**
 * Lädt alle eingetragenen Bausteine in einen Arbeitsordner, prüft jeden
 * (Größe + sha256), entpackt, und tauscht erst ganz am Ende atomar ein.
 */
export async function installVoiceBundle(bundle: VoiceBundle = VOICE_BUNDLE, options: InstallVoiceOptions = {}): Promise<{ status: 'installiert' | 'vorhanden'; dir: string }> {
    const dir = options.dir || voiceBundleDir()
    const arch = options.arch || process.arch
    const parts = partsFor(bundle, arch)
    parts.forEach(validateVoicePart)
    try { await verifyVoiceBundle(bundle, dir, arch); return { status: 'vorhanden', dir } } catch { /* neu installieren */ }
    const fetchImpl = options.fetchImpl || fetch
    const extract = options.extract || tarExtract
    const work = join(dir, '.install')
    rmSync(work, { recursive: true, force: true })
    mkdirSync(work, { recursive: true })
    try {
        const staged = join(work, 'bundle')
        for (const part of parts) {
            const file = join(work, part.filename)
            await download(part, file, fetchImpl, options.timeoutMs ?? 30 * 60_000)
            const target = join(staged, ...part.target.split('/'))
            mkdirSync(join(target, '..'), { recursive: true })
            if (part.kind === 'file') { renameSync(file, target); continue }
            const unpack = join(work, `unpack-${part.name}`)
            mkdirSync(unpack, { recursive: true })
            await extract(file, unpack, part.kind)
            rmSync(file, { force: true })
            const top = readdirSync(unpack)
            if (top.length !== 1) throw new Error(`${part.name}: Archiv hat unerwarteten Aufbau`)
            renameSync(join(unpack, top[0]), target)
            const missing = part.markers.find(marker => !existsSync(join(target, marker)))
            if (missing) throw new Error(`${part.name}: ${missing} fehlt im Archiv`)
        }
        const receipt: Receipt = { bundle: bundle.name, parts: parts.map(part => ({ name: part.name, sha256: part.sha256 })), installedAt: new Date().toISOString() }
        writeFileSync(join(staged, 'receipt.json'), JSON.stringify(receipt, null, 2))
        // Tausch: alte Bausteine weg, neue an ihre Stelle, Quittung zuletzt.
        for (const sub of ['models', 'node_modules']) {
            rmSync(join(dir, sub), { recursive: true, force: true })
            if (existsSync(join(staged, sub))) renameSync(join(staged, sub), join(dir, sub))
        }
        renameSync(join(staged, 'receipt.json'), join(dir, 'receipt.json'))
        return { status: 'installiert', dir }
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
}

/** Rückweg: entfernt genau die Bündel-Inhalte (Modelle, Laufzeit, Quittung). */
export async function removeVoiceBundle(_bundle: VoiceBundle = VOICE_BUNDLE, dir = voiceBundleDir()): Promise<void> {
    for (const sub of ['receipt.json', 'models', 'node_modules', '.install']) rmSync(join(dir, sub), { recursive: true, force: true })
}

export interface VoiceBundleLayout {
    runtime: string
    vad: string
    asr: { tokens: string; encoder: string; decoder: string; joiner: string }
    voices: Record<'female' | 'male', { model: string; tokens: string; dataDir: string; label: string }>
}

/** Wo der Sprachdienst seine Dateien findet. */
export function voiceBundleLayout(dir = voiceBundleDir()): VoiceBundleLayout {
    const models = join(dir, 'models')
    const asr = join(models, 'nemotron-de-560ms')
    const voice = (folder: string, file: string, label: string) => ({ model: join(models, folder, file), tokens: join(models, folder, 'tokens.txt'), dataDir: join(models, folder, 'espeak-ng-data'), label })
    return {
        runtime: join(dir, 'node_modules', 'sherpa-onnx-node'),
        vad: join(models, 'silero_vad.int8.onnx'),
        asr: { tokens: join(asr, 'tokens.txt'), encoder: join(asr, 'encoder.int8.onnx'), decoder: join(asr, 'decoder.int8.onnx'), joiner: join(asr, 'joiner.int8.onnx') },
        voices: {
            female: voice('piper-ramona', 'de_DE-ramona-low.onnx', 'Ramona'),
            male: voice('piper-thorsten', 'de_DE-thorsten-medium.onnx', 'Thorsten'),
        },
    }
}
