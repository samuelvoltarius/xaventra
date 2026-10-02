import { createHash, sign, verify } from 'node:crypto'
import { neverListViolation, packageNeverListViolation } from './never-list.js'
import { EMBEDDING_ARTIFACTS, type EmbeddingArtifact } from '../memory/embedding-artifacts.js'

// ============================================================================
// Stufe 2 (S2.1): installation catalog. Part of the release (compiled into
// dist, hashed in docs/generated/install-catalog.json, optionally signed by a
// detached ed25519 signature over the catalog hash). Nothing outside this
// catalog is ever executed by the installer; commands are argument arrays,
// never shell strings. The model only picks catalog ids.
// ============================================================================

export type InstallKind = 'apt' | 'ollama-model' | 'runtime-addon'
export type InstallTarget = 'host-agent' | 'image' | 'model-volume'
export type ApprovalLevel = 'fragen' | 'erlauben'
export type InstallRisk = 'low' | 'medium' | 'high'
export type InstallRollback = { kind: 'apt-remove-new' } | { kind: 'command'; argv: string[] }

export interface InstallCatalogEntry {
    id: string
    title: string
    kind: InstallKind
    /** host-agent = Spark (root host agent); image = container worker (next image); model-volume = model into a data volume. */
    targets: InstallTarget[]
    requires?: { platform?: 'linux'; arch?: 'arm64' | 'x64'; gpuVendor?: 'nvidia' }
    packages?: string[]
    prepare?: string[][]
    install: string[]
    verify: string[][]
    rollback: InstallRollback
    runAs: 'root' | 'service'
    sizeMb: number
    timeoutSec: number
    risk: InstallRisk
    /** Default approval level. The owner can lift a single entry to 'erlauben'. */
    approval: ApprovalLevel
    /** Worker route: suggestion for the next image (never apt in a running container). */
    image?: { variant: string; packages: string[] }
}

export const APT_GET = '/usr/bin/apt-get'
export const OLLAMA = '/usr/local/bin/ollama'
export const TEST_BIN = '/usr/bin/test'
/** `program` = installed program root (contains dist/); defaults to the host agent's own program root. */
export const PLACEHOLDERS = ['node', 'npm', 'runtime', 'serviceHome', 'nodeLlamaCppVersion', 'program'] as const
export type PlaceholderName = typeof PLACEHOLDERS[number]
/** Programs a catalog entry may start. Everything else is refused at load. */
export const EXECUTABLE_ALLOWLIST: readonly string[] = Object.freeze([APT_GET, OLLAMA, TEST_BIN, '/usr/bin/ffmpeg', '{node}'])
/** ollama-model:<name> only for this fixed list. */
export const OLLAMA_MODEL_ALLOWLIST: readonly string[] = Object.freeze(['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'])
const OLLAMA_MODEL_SIZE_MB: Readonly<Record<string, number>> = Object.freeze({ 'nomic-embed-text': 280, 'mxbai-embed-large': 700, 'bge-m3': 1250 })

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}(?::[a-z0-9][a-z0-9._-]{0,60})?$/
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,62}$/
/** Shell metacharacters, quotes, whitespace and globbing. Placeholders are removed before this check. */
const UNSAFE_ARG = /[;&|`$<>\\\n\r\t\s*?!(){}[\]'"~#%^]/

export const XFCE_PACKAGES = ['xfce4', 'xfce4-terminal', 'thunar', 'dbus-x11']

function aptEntry(id: string, title: string, packages: string[], verify: string[][], sizeMb: number, timeoutSec: number, risk: InstallRisk): InstallCatalogEntry {
    return {
        id, title, kind: 'apt', targets: ['host-agent', 'image'], requires: { platform: 'linux' }, packages,
        prepare: [[APT_GET, 'update']],
        install: [APT_GET, 'install', '-y', '--no-install-recommends', ...packages],
        verify, rollback: { kind: 'apt-remove-new' }, runAs: 'root', sizeMb, timeoutSec, risk, approval: 'fragen',
        image: { variant: id, packages },
    }
}

function ollamaEntry(name: string): InstallCatalogEntry {
    return {
        id: `ollama-model:${name}`, title: `Ollama-Modell ${name}`, kind: 'ollama-model', targets: ['host-agent', 'model-volume'],
        install: [OLLAMA, 'pull', name], verify: [[OLLAMA, 'show', name]], rollback: { kind: 'command', argv: [OLLAMA, 'rm', name] },
        runAs: 'service', sizeMb: OLLAMA_MODEL_SIZE_MB[name], timeoutSec: 1800, risk: 'low', approval: 'fragen',
    }
}

/** Program that fetches exactly one pinned embedding GGUF (fixed URL, size, sha256; atomic, removable). */
export const EMBEDDING_FETCH_SCRIPT = '{program}/dist/memory/local-embedder-fetch.js'
/** Target: the main's runtime root (survives program updates), read by memory/embedding-artifacts.ts. */
export const EMBEDDING_MODEL_DIR = '{runtime}/models/embedding'

/**
 * 2.86 (Paket G): own in-process embedding model. The command names only the
 * artifact; URL, size and sha256 are compiled into the program
 * (memory/embedding-artifacts.ts), verify re-hashes the file, rollback removes it.
 */
function embeddingEntry(artifact: EmbeddingArtifact): InstallCatalogEntry {
    const run = (operation: string) => ['{node}', EMBEDDING_FETCH_SCRIPT, operation, artifact.name, EMBEDDING_MODEL_DIR]
    return {
        id: `embedding-gguf:${artifact.name}`, title: `Eigener Einbetter ${artifact.filename.replace(/\.gguf$/, '')} (CPU, sha256-geprüft)`,
        kind: 'runtime-addon', targets: ['host-agent'], requires: { platform: 'linux' },
        install: run('install'), verify: [run('verify')], rollback: { kind: 'command', argv: run('remove') },
        runAs: 'service', sizeMb: Math.ceil(artifact.sizeBytes / 1024 ** 2), timeoutSec: 1800, risk: 'low', approval: 'fragen',
    }
}

export const BUILTIN_INSTALL_CATALOG: readonly InstallCatalogEntry[] = Object.freeze([
    aptEntry('ffmpeg', 'ffmpeg (Audio/Video-Werkzeuge)', ['ffmpeg'], [['/usr/bin/ffmpeg', '-version']], 300, 900, 'low'),
    aptEntry('xfce-workstation', 'XFCE-Arbeitsplatz (Desktop für die Workstation)', XFCE_PACKAGES,
        [[TEST_BIN, '-x', '/usr/bin/xfce4-session'], [TEST_BIN, '-x', '/usr/bin/dbus-run-session']], 700, 1800, 'medium'),
    {
        id: 'playwright-chromium', title: 'Playwright-Chromium (Browser-Werkzeug, ohne Systempakete)', kind: 'runtime-addon',
        targets: ['host-agent'], requires: { platform: 'linux' },
        install: ['{node}', '{runtime}/node_modules/playwright/cli.js', 'install', 'chromium'],
        verify: [[TEST_BIN, '-d', '{serviceHome}/.cache/ms-playwright']],
        rollback: { kind: 'command', argv: ['{node}', '{runtime}/node_modules/playwright/cli.js', 'uninstall'] },
        runAs: 'service', sizeMb: 450, timeoutSec: 900, risk: 'low', approval: 'fragen',
    } as InstallCatalogEntry,
    ...OLLAMA_MODEL_ALLOWLIST.map(ollamaEntry),
    {
        id: 'node-llama-cpp-cuda', title: 'node-llama-cpp CUDA-Binding (nur Spark, kein CUDA-Toolkit)', kind: 'runtime-addon',
        targets: ['host-agent'], requires: { platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia' },
        install: ['{node}', '{npm}', 'install', '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', '{runtime}',
            '@node-llama-cpp/linux-arm64-cuda@{nodeLlamaCppVersion}'],
        verify: [[TEST_BIN, '-d', '{runtime}/node_modules/@node-llama-cpp/linux-arm64-cuda']],
        rollback: { kind: 'command', argv: ['{node}', '{npm}', 'uninstall', '--no-save', '--ignore-scripts', '--prefix', '{runtime}', '@node-llama-cpp/linux-arm64-cuda'] },
        runAs: 'root', sizeMb: 600, timeoutSec: 900, risk: 'high', approval: 'fragen',
    } as InstallCatalogEntry,
    ...EMBEDDING_ARTIFACTS.map(embeddingEntry),
].map(entry => Object.freeze(entry)))

export interface RejectedCatalogEntry { id: string; reason: string }
export interface InstallCatalog {
    version: 1
    entries: InstallCatalogEntry[]
    rejected: RejectedCatalogEntry[]
    hash: string
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, sortKeys((value as any)[key])]))
    return value
}
export function canonicalJson(value: unknown): string { return JSON.stringify(sortKeys(value)) }
export function sha256Hex(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function installEntryHash(entry: InstallCatalogEntry): string { return sha256Hex(canonicalJson(entry)) }

const placeholderPattern = new RegExp(`\\{(?:${PLACEHOLDERS.join('|')})\\}`, 'g')

/** True when one argument is free of shell metacharacters (known placeholders aside). */
export function isSafeArgument(arg: unknown): boolean {
    if (typeof arg !== 'string' || !arg || arg.length > 200) return false
    return !UNSAFE_ARG.test(arg.replace(placeholderPattern, 'P'))
}

function checkArgv(argv: unknown, label: string, packages: string[]): string | null {
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 40) return `${label}: Befehl muss ein Argument-Array sein`
    for (const arg of argv) if (!isSafeArgument(arg)) return `${label}: unzulässiges Argument (Shell-Metazeichen/Leerzeichen/Länge)`
    if (!EXECUTABLE_ALLOWLIST.includes(argv[0])) return `${label}: Programm ${String(argv[0])} nicht in der Allowlist`
    const never = neverListViolation(argv as string[], packages)
    if (never) return `${label}: Nie-Liste (${never.ruleId}: ${never.value})`
    return null
}

const sameArray = (left: readonly string[], right: readonly string[]) => Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index])

/** Validates one entry. Returns the reason for refusal or null. */
export function validateCatalogEntry(raw: unknown): string | null {
    const e = raw as InstallCatalogEntry
    if (!e || typeof e !== 'object' || Array.isArray(e)) return 'Eintrag muss ein Objekt sein'
    const allowed = ['id', 'title', 'kind', 'targets', 'requires', 'packages', 'prepare', 'install', 'verify', 'rollback', 'runAs', 'sizeMb', 'timeoutSec', 'risk', 'approval', 'image']
    const unknown = Object.keys(e).find(key => !allowed.includes(key))
    if (unknown) return `unbekanntes Feld ${unknown}`
    if (typeof e.id !== 'string' || !ID_PATTERN.test(e.id)) return 'ungültige id'
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > 120) return 'Titel fehlt'
    if (!['apt', 'ollama-model', 'runtime-addon'].includes(e.kind)) return 'unbekannte Art'
    if (!Array.isArray(e.targets) || !e.targets.length || e.targets.some(t => !['host-agent', 'image', 'model-volume'].includes(t))) return 'ungültige Ziele'
    if (!['low', 'medium', 'high'].includes(e.risk)) return 'ungültiges Risiko'
    if (!['fragen', 'erlauben'].includes(e.approval)) return 'ungültige Freigabestufe'
    if (!['root', 'service'].includes(e.runAs)) return 'ungültiger Benutzer'
    if (!Number.isInteger(e.sizeMb) || e.sizeMb < 1 || e.sizeMb > 50_000) return 'Größe fehlt'
    if (!Number.isInteger(e.timeoutSec) || e.timeoutSec < 30 || e.timeoutSec > 3600) return 'Zeitlimit ungültig'
    if (e.packages !== undefined && !Array.isArray(e.packages)) return 'Pakete müssen eine Liste sein'
    const packages = Array.isArray(e.packages) ? e.packages : []
    if (packages.some(name => typeof name !== 'string' || !PACKAGE_PATTERN.test(name))) return 'ungültiger Paketname'
    const packageNever = packageNeverListViolation(packages)
    if (packageNever) return `Nie-Liste (${packageNever.ruleId}: ${packageNever.value})`
    if (e.prepare !== undefined && !Array.isArray(e.prepare)) return 'Vorbereitung muss eine Liste sein'
    for (const [index, argv] of (e.prepare || []).entries()) { const issue = checkArgv(argv, `prepare[${index}]`, packages); if (issue) return issue }
    const installIssue = checkArgv(e.install, 'install', packages); if (installIssue) return installIssue
    if (!Array.isArray(e.verify) || !e.verify.length) return 'Prüfkommando fehlt'
    for (const [index, argv] of e.verify.entries()) { const issue = checkArgv(argv, `verify[${index}]`, packages); if (issue) return issue }
    if (!e.rollback || !['apt-remove-new', 'command'].includes(e.rollback.kind)) return 'Rückweg fehlt'
    if (e.rollback.kind === 'command') { const issue = checkArgv(e.rollback.argv, 'rollback', packages); if (issue) return issue }
    if (e.kind === 'apt') {
        // Exact shape only: no extra apt options can be smuggled in.
        if (!packages.length || e.runAs !== 'root' || e.rollback.kind !== 'apt-remove-new') return 'apt: Pakete, root und apt-Rückweg nötig'
        if (!sameArray(e.install, [APT_GET, 'install', '-y', '--no-install-recommends', ...packages])) return 'apt: Befehl nicht in fester Form'
        if ((e.prepare || []).some(argv => !sameArray(argv, [APT_GET, 'update']))) return 'apt: nur "apt-get update" als Vorbereitung'
    } else {
        if (e.prepare?.length) return 'Vorbereitung nur für apt'
        if (packages.length) return 'Pakete nur für apt'
        if (e.rollback.kind !== 'command') return 'Rückweg-Befehl nötig'
        if (e.install[0] === APT_GET || e.verify.some(argv => argv[0] === APT_GET) || e.rollback.argv[0] === APT_GET) return 'apt nur in apt-Einträgen'
    }
    if (e.kind === 'ollama-model') {
        const name = e.id.slice('ollama-model:'.length)
        if (!e.id.startsWith('ollama-model:') || !OLLAMA_MODEL_ALLOWLIST.includes(name)) return 'Modell nicht in der festen Liste'
        if (!sameArray(e.install, [OLLAMA, 'pull', name]) || e.verify.length !== 1 || !sameArray(e.verify[0], [OLLAMA, 'show', name])
            || e.rollback.kind !== 'command' || !sameArray(e.rollback.argv, [OLLAMA, 'rm', name])) return 'Modell: Befehl nicht in fester Form'
        if (e.runAs !== 'service' || e.targets.includes('image')) return 'Modell: nur Dienstbenutzer, nie Image'
    } else if (e.id.startsWith('ollama-model:')) return 'ollama-model-id nur für Modelle'
    if (e.image) {
        if (e.kind !== 'apt' || !e.targets.includes('image') || typeof e.image.variant !== 'string' || !ID_PATTERN.test(e.image.variant)
            || !Array.isArray(e.image.packages) || !sameArray(e.image.packages, packages)) return 'Image-Variante ungültig'
    } else if (e.targets.includes('image')) return 'Image-Ziel ohne Variante'
    if (e.requires !== undefined) {
        if (!e.requires || typeof e.requires !== 'object') return 'Voraussetzung ungültig'
        if (Object.keys(e.requires).some(key => !['platform', 'arch', 'gpuVendor'].includes(key))) return 'unbekannte Voraussetzung'
    }
    return null
}

/** Loads and validates a catalog. Entries that fail (incl. Nie-Liste) are rejected, never repaired. */
export function loadInstallCatalog(raw: readonly unknown[] = BUILTIN_INSTALL_CATALOG): InstallCatalog {
    const entries: InstallCatalogEntry[] = []
    const rejected: RejectedCatalogEntry[] = []
    const seen = new Set<string>()
    for (const item of raw) {
        const id = typeof (item as any)?.id === 'string' ? (item as any).id : '?'
        const reason = validateCatalogEntry(item) || (seen.has(id) ? 'doppelte id' : null)
        if (reason) { rejected.push({ id: String(id).slice(0, 80), reason }); continue }
        seen.add(id)
        entries.push(structuredClone(item) as InstallCatalogEntry)
    }
    entries.sort((left, right) => left.id.localeCompare(right.id))
    return { version: 1, entries, rejected, hash: sha256Hex(canonicalJson(entries)) }
}

let builtin: InstallCatalog | null = null
export function getInstallCatalog(): InstallCatalog {
    builtin ||= loadInstallCatalog()
    return builtin
}
export function isCatalogId(id: unknown): id is string { return typeof id === 'string' && ID_PATTERN.test(id) }
export function findCatalogEntry(id: unknown, catalog = getInstallCatalog()): InstallCatalogEntry | undefined {
    if (!isCatalogId(id)) return undefined
    return catalog.entries.find(entry => entry.id === id)
}

/** Detached release signature over the catalog hash (operator key, never in the repo). */
export function signInstallCatalog(catalog: InstallCatalog, privateKey: string): string {
    return sign(null, Buffer.from(`xaventra-install-catalog:${catalog.hash}`), privateKey).toString('base64')
}
export function verifyInstallCatalogSignature(catalog: InstallCatalog, signature: string, publicKey: string): boolean {
    try { return verify(null, Buffer.from(`xaventra-install-catalog:${catalog.hash}`), publicKey, Buffer.from(String(signature || ''), 'base64')) }
    catch { return false }
}

/** Published form for docs/generated (hash is reproducible from source). */
export function publishedInstallCatalog(catalog = getInstallCatalog()): { version: 1; catalogHash: string; entries: unknown[]; rejected: RejectedCatalogEntry[] } {
    return { version: 1, catalogHash: catalog.hash, entries: catalog.entries.map(entry => ({ ...entry, entryHash: installEntryHash(entry) })), rejected: catalog.rejected }
}
