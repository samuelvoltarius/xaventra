import { canonicalJson, findCatalogEntry, getInstallCatalog, sha256Hex, type InstallCatalog, type InstallKind } from './install-catalog.js'
import { packageNeverListViolation } from './never-list.js'

// ============================================================================
// Phase 5b Software-Scout: candidate catalog. Part of the release like the
// Stufe-2 installation catalog, never taken from the network or a model.
// A candidate only says WHAT could help and WHAT it needs (RAM, disk, GPU,
// platform). It never carries a command. Whether something can actually be
// installed is decided only by the referenced Stufe-2 catalog entry
// (`catalogId`); without one the scout can only note "Katalogeintrag nötig".
// ============================================================================

export type SoftwareCapability = 'stt' | 'tts' | 'vision' | 'embedding' | 'browser' | 'media' | 'desktop' | 'llm' | 'search'
export type CandidateKind = 'system' | 'model' | 'runtime'

/** Order = priority for gap thoughts (first gaps first). */
export const SOFTWARE_CAPABILITIES: readonly SoftwareCapability[] = Object.freeze(['stt', 'tts', 'embedding', 'browser', 'media', 'vision', 'desktop', 'llm', 'search'])

export const CAPABILITY_LABEL: Readonly<Record<SoftwareCapability, string>> = Object.freeze({
    stt: 'Spracherkennung (STT)', tts: 'Sprachausgabe (TTS)', vision: 'Bilderkennung (Vision)', embedding: 'Embeddings (Gedächtnis-Suche)',
    browser: 'Browser', media: 'Audio/Video (ffmpeg)', desktop: 'Desktop', llm: 'Sprachmodell (LLM)', search: 'Websuche (eigene Suchmaschine)',
})

export interface SoftwareCandidate {
    id: string
    title: string
    capability: SoftwareCapability
    /** system = OS package, model = model file for an existing runtime, runtime = program/add-on. */
    kind: CandidateKind
    platforms: Array<'linux' | 'win32' | 'darwin'>
    arches: Array<'x64' | 'arm64'>
    minRamGB: number
    /** Space the software itself needs; the Stufe-2 resource guard adds its 10 GB reserve on install. */
    minDiskGB: number
    gpu: 'none' | 'nvidia'
    /** Only with gpu=nvidia: memory the GPU part needs (unified memory counts as VRAM). */
    minVramGB?: number
    /** Heavy GPU load: never proposed next to a running vLLM (STUFENPLAN Grenze 6). */
    heavy?: boolean
    /** Only these roles (e.g. a desktop only on the Main/workstation). */
    roles?: Array<'main' | 'worker'>
    /** Needs an existing runtime on the node (models go into Ollama). */
    requiresService?: 'ollama'
    /** How an existing installation shows up in the node profile. */
    detect?: { tools?: string[]; services?: string[] }
    /** Stufe-2 installation catalog id. Absent = only "Katalogeintrag nötig". */
    catalogId?: string
    /** Package names a future catalog entry would use (text only, checked against the never-list). */
    packages?: string[]
    /** Why this helps Alfred (shown in the proposal). */
    benefit: string
    /**
     * 2.85 Paket D: the same benefit as one plain sentence for the Werkzeugkasten
     * (no jargon: "Versteht dann deine Sprachnachrichten."). Every release candidate
     * has one (test); a missing one falls back to a sentence per capability.
     */
    nutzen?: string
    /**
     * 2.85: models only — the Ollama model reference (`name:tag`) the candidate stands for.
     * Used for the freshness check (family, version, size); never a command.
     */
    modelRef?: string
    /**
     * 2.85: models only — release month of this model (YYYY-MM), checked by web search when
     * the catalog was maintained. Older than MODEL_MAX_AGE_MONTHS → a fresh web check is
     * required before the candidate may become a question (software-freshness.ts).
     */
    releasedAt?: string
}

const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{1,60}$/
const NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,62}$/
const ALLOWED_FIELDS = ['id', 'title', 'capability', 'kind', 'platforms', 'arches', 'minRamGB', 'minDiskGB', 'gpu', 'minVramGB', 'heavy', 'roles',
    'requiresService', 'detect', 'catalogId', 'packages', 'benefit', 'nutzen', 'modelRef', 'releasedAt']
const MODEL_REF_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}:[a-z0-9][a-z0-9._-]{0,40}$/
const RELEASED_PATTERN = /^20\d\d-(0[1-9]|1[0-2])$/
const KIND_FOR_CATALOG: Readonly<Record<InstallKind, CandidateKind>> = Object.freeze({ apt: 'system', 'ollama-model': 'model', 'runtime-addon': 'runtime' })

const LINUX = ['linux'] as const
const BOTH_ARCHES = ['x64', 'arm64'] as const

export const BUILTIN_SOFTWARE_CANDIDATES: readonly SoftwareCandidate[] = Object.freeze([
    {
        id: 'stt-whisper-large-v3', title: 'Whisper large-v3 (GPU)', capability: 'stt', kind: 'runtime', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 8, minDiskGB: 5, gpu: 'nvidia', minVramGB: 6, detect: { services: ['whisper', 'faster-whisper', 'whisper-server', 'faster-whisper-server'] },
        nutzen: 'Versteht dann deine Sprachnachrichten sehr genau, auch auf Deutsch.',
        benefit: 'Beste lokale Spracherkennung (auch Deutsch) für Sprachnachrichten, ohne Cloud. Braucht GPU-Speicher; neben vLLM nur mit genug freiem Speicher.',
    },
    {
        id: 'stt-faster-whisper-small', title: 'faster-whisper small (CPU, int8)', capability: 'stt', kind: 'runtime', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 2, minDiskGB: 2, gpu: 'none', detect: { services: ['whisper', 'faster-whisper', 'whisper-server', 'faster-whisper-server'] },
        nutzen: 'Versteht dann deine Sprachnachrichten, auch ohne Grafikkarte.',
        benefit: 'Lokale Spracherkennung auf der CPU, wenn keine GPU frei ist; langsamer und ungenauer als large-v3.',
    },
    {
        id: 'tts-piper', title: 'Piper TTS', capability: 'tts', kind: 'runtime', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 1, minDiskGB: 1, gpu: 'none', detect: { services: ['piper', 'piper-tts'] },
        nutzen: 'Kann dir dann Antworten vorlesen, ganz ohne Internet.',
        benefit: 'Sprachausgabe lokal und offline (deutsche Stimmen), statt nur über einen Online-Dienst.',
    },
    {
        id: 'embedding-nomic-embed-text', title: 'nomic-embed-text (Ollama)', capability: 'embedding', kind: 'model', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 1, minDiskGB: 1, gpu: 'none', requiresService: 'ollama', catalogId: 'ollama-model:nomic-embed-text', modelRef: 'nomic-embed-text:v1.5', releasedAt: '2024-02',
        nutzen: 'Findet dann Erinnerungen schneller wieder, ohne fremden Dienst.',
        benefit: 'Kleines Embedding-Modell für die Gedächtnis-Suche, lokal statt über einen Cloud-Anbieter.',
    },
    {
        id: 'embedding-bge-m3', title: 'bge-m3 (Ollama, mehrsprachig)', capability: 'embedding', kind: 'model', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 3, minDiskGB: 2, gpu: 'none', requiresService: 'ollama', catalogId: 'ollama-model:bge-m3', modelRef: 'bge-m3:567m', releasedAt: '2024-01',
        nutzen: 'Findet dann Erinnerungen auf Deutsch und Englisch besser wieder.',
        benefit: 'Mehrsprachiges Embedding-Modell (Deutsch/Englisch) für bessere Gedächtnis-Treffer.',
    },
    {
        // 2.85 Paket D (checked 02.10.2026): ollama.com/library/mxbai-embed-large, tag 335m (670 MB), mixedbread.ai 03/2024.
        id: 'embedding-mxbai-embed-large', title: 'mxbai-embed-large (Ollama)', capability: 'embedding', kind: 'model', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 2, minDiskGB: 1, gpu: 'none', requiresService: 'ollama', catalogId: 'ollama-model:mxbai-embed-large', modelRef: 'mxbai-embed-large:335m', releasedAt: '2024-03',
        nutzen: 'Findet dann englische Erinnerungen und Texte genauer wieder.',
        benefit: 'Größeres englischsprachiges Embedding-Modell für die Gedächtnis-Suche, lokal statt über einen Cloud-Anbieter.',
    },
    {
        id: 'browser-playwright-chromium', title: 'Playwright-Chromium', capability: 'browser', kind: 'runtime', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 2, minDiskGB: 1, gpu: 'none', detect: { tools: ['playwright_browsers'] }, catalogId: 'playwright-chromium',
        nutzen: 'Kann dann selbst Webseiten öffnen, lesen und abfotografieren.',
        benefit: 'Browser-Werkzeuge (Webseiten lesen, Screenshots) laufen lokal statt zu scheitern.',
    },
    {
        id: 'media-ffmpeg', title: 'ffmpeg', capability: 'media', kind: 'system', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 1, minDiskGB: 1, gpu: 'none', detect: { tools: ['ffmpeg'] }, catalogId: 'ffmpeg',
        nutzen: 'Kann dann Audio und Video umwandeln, zum Beispiel Sprachnachrichten.',
        benefit: 'Audio/Video umwandeln (Sprachnachrichten, Videos), Grundlage für STT/TTS-Werkzeuge.',
    },
    {
        // 2.85 (checked 02.10.2026): replaces Qwen2.5-VL 3B (01/2025). Gemma 4 (04/2026) is
        // multimodal (text + image) in every size; e2b is the small one on Ollama.
        id: 'vision-gemma4-e2b', title: 'Gemma 4 E2B (Ollama, Bild + Text)', capability: 'vision', kind: 'model', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 10, minDiskGB: 8, gpu: 'none', requiresService: 'ollama', catalogId: 'ollama-model:gemma4-e2b', modelRef: 'gemma4:e2b', releasedAt: '2026-04',
        nutzen: 'Kann dann Fotos und Bilder ansehen und beschreiben.',
        benefit: 'Kleines aktuelles Bildmodell als Rückfall, wenn kein Vision-Pfad Ende-zu-Ende belegt ist (Erkannt ≠ nutzbar).',
    },
    {
        // 2.85 Paket D (checked 02.10.2026): Ubuntu noble tesseract 5.3.4 + tesseract-ocr-deu; Apache-2.0.
        id: 'vision-tesseract-ocr', title: 'Tesseract OCR (Deutsch + Englisch)', capability: 'vision', kind: 'system', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 1, minDiskGB: 1, gpu: 'none', catalogId: 'tesseract-ocr',
        nutzen: 'Kann dann Text auf Fotos, Scans und Bildschirmfotos lesen.',
        benefit: 'Texterkennung (OCR) lokal und schnell, auch ohne Bildmodell; das Werkzeug resolve_capability kennt tesseract bereits.',
    },
    {
        id: 'desktop-xfce', title: 'XFCE-Arbeitsplatz', capability: 'desktop', kind: 'system', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 4, minDiskGB: 2, gpu: 'none', roles: ['main'], detect: { tools: ['display'] }, catalogId: 'xfce-workstation',
        nutzen: 'Bekommt dann einen eigenen Bildschirm-Arbeitsplatz.',
        benefit: 'Desktop für Bildschirm-Werkzeuge (desktop_*) auf der Workstation.',
    },
    {
        id: 'llm-node-llama-cpp-cuda', title: 'node-llama-cpp mit CUDA (lokale GGUF-Modelle)', capability: 'llm', kind: 'runtime', platforms: [...LINUX], arches: ['arm64'],
        minRamGB: 16, minDiskGB: 2, gpu: 'nvidia', minVramGB: 8, heavy: true, catalogId: 'node-llama-cpp-cuda',
        nutzen: 'Kann dann auch ohne Internet und ohne Cloud denken.',
        benefit: 'Lokales Sprachmodell auf der GPU als Rückfall, wenn kein vLLM läuft.',
    },
    {
        // 2.85 (checked 02.10.2026): replaces Qwen2.5 3B (09/2024). Qwen3.5 small models 03/2026.
        id: 'llm-ollama-qwen3.5-4b', title: 'Qwen3.5 4B (Ollama, CPU)', capability: 'llm', kind: 'model', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 8, minDiskGB: 4, gpu: 'none', requiresService: 'ollama', modelRef: 'qwen3.5:4b', releasedAt: '2026-03',
        nutzen: 'Kann dann notfalls auch ohne Grafikkarte und ohne Internet antworten.',
        benefit: 'Kleines Sprachmodell auf der CPU als Notlösung ohne GPU und ohne Cloud.',
    },
    {
        // 2.85 Paket D (checked 02.10.2026): github.com/searxng/searxng, AGPL-3.0, offizielles Container-Image.
        // Kein Katalogeintrag: der Installationskatalog hat keine Container-Route (offener Punkt);
        // eine laufende Instanz erkennt Paket C (mesh/ai-scanner), nicht dieser Katalog.
        id: 'search-searxng', title: 'SearXNG (eigene Suchmaschine)', capability: 'search', kind: 'runtime', platforms: [...LINUX], arches: [...BOTH_ARCHES],
        minRamGB: 1, minDiskGB: 1, gpu: 'none', detect: { services: ['searxng'] },
        nutzen: 'Kann dann selbst im Internet suchen, ohne Schlüssel und ohne fremden Suchdienst.',
        benefit: 'Eigene Metasuchmaschine als Container: Websuche ohne API-Schlüssel und ohne Weitergabe der Suchanfragen an einen Anbieter.',
    },
].map(entry => Object.freeze(entry as SoftwareCandidate)))

const isNum = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const isStringList = (value: unknown, pattern: RegExp, max = 12) => Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && pattern.test(item))

/** Validates one candidate against itself, the never-list and the Stufe-2 catalog. Returns the refusal reason or null. */
export function validateSoftwareCandidate(raw: unknown, installCatalog: InstallCatalog = getInstallCatalog()): string | null {
    const c = raw as SoftwareCandidate
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'Kandidat muss ein Objekt sein'
    const unknown = Object.keys(c).find(key => !ALLOWED_FIELDS.includes(key))
    if (unknown) return `unbekanntes Feld ${unknown}`
    if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) return 'ungültige id'
    if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > 120) return 'Titel fehlt'
    if (!SOFTWARE_CAPABILITIES.includes(c.capability)) return 'unbekannte Fähigkeit'
    if (!['system', 'model', 'runtime'].includes(c.kind)) return 'unbekannte Art'
    if (!Array.isArray(c.platforms) || !c.platforms.length || c.platforms.some(p => !['linux', 'win32', 'darwin'].includes(p))) return 'ungültige Plattform'
    if (!Array.isArray(c.arches) || !c.arches.length || c.arches.some(a => !['x64', 'arm64'].includes(a))) return 'ungültige Architektur'
    if (!isNum(c.minRamGB, 0, 1024)) return 'RAM-Bedarf fehlt'
    if (!isNum(c.minDiskGB, 0, 4096)) return 'Platten-Bedarf fehlt'
    if (!['none', 'nvidia'].includes(c.gpu)) return 'ungültige GPU-Angabe'
    if (c.gpu === 'nvidia' && !isNum(c.minVramGB, 0.5, 1024)) return 'GPU-Kandidat ohne Speicherbedarf'
    if (c.gpu === 'none' && c.minVramGB !== undefined) return 'Speicherbedarf nur für GPU-Kandidaten'
    if (c.heavy !== undefined && typeof c.heavy !== 'boolean') return 'heavy muss ja/nein sein'
    if (c.roles !== undefined && (!Array.isArray(c.roles) || !c.roles.length || c.roles.some(r => !['main', 'worker'].includes(r)))) return 'ungültige Rolle'
    if (c.requiresService !== undefined && c.requiresService !== 'ollama') return 'unbekannte Laufzeit'
    if (c.detect !== undefined) {
        if (!c.detect || typeof c.detect !== 'object' || Object.keys(c.detect).some(key => !['tools', 'services'].includes(key))) return 'ungültige Erkennung'
        if (c.detect.tools !== undefined && !isStringList(c.detect.tools, NAME_PATTERN)) return 'ungültige Werkzeugnamen'
        if (c.detect.services !== undefined && !isStringList(c.detect.services, NAME_PATTERN)) return 'ungültige Dienstnamen'
    }
    if (c.packages !== undefined && !isStringList(c.packages, NAME_PATTERN, 20)) return 'ungültige Paketnamen'
    if (typeof c.benefit !== 'string' || !c.benefit.trim() || c.benefit.length > 300) return 'Nutzen-Begründung fehlt'
    if (c.nutzen !== undefined && (typeof c.nutzen !== 'string' || !/^\S.{8,118}\.$/.test(c.nutzen))) return 'Nutzen-Satz ungültig (ein einfacher Satz, endet mit Punkt)'
    if (c.modelRef !== undefined && (typeof c.modelRef !== 'string' || !MODEL_REF_PATTERN.test(c.modelRef))) return 'ungültige modelRef'
    if (c.releasedAt !== undefined && (typeof c.releasedAt !== 'string' || !RELEASED_PATTERN.test(c.releasedAt))) return 'ungültiges releasedAt (YYYY-MM)'
    if (c.kind === 'model' && (!c.modelRef || !c.releasedAt)) return 'Modell-Kandidat braucht modelRef und releasedAt (YYYY-MM)'
    // Never-list: the candidate id and any package it names are treated as package names.
    const never = packageNeverListViolation([c.id, ...(c.packages || [])])
    if (never) return `Nie-Liste (${never.ruleId}: ${never.value})`
    if (c.catalogId !== undefined) {
        const entry = findCatalogEntry(c.catalogId, installCatalog)
        if (!entry) return `Katalog-ID ${String(c.catalogId).slice(0, 60)} nicht im Installationskatalog`
        if (KIND_FOR_CATALOG[entry.kind] !== c.kind) return 'Art passt nicht zum Katalogeintrag'
        const requires = entry.requires || {}
        if (requires.platform && c.platforms.some(p => p !== requires.platform)) return 'Plattform passt nicht zum Katalogeintrag'
        if (requires.arch && c.arches.some(a => a !== requires.arch)) return 'Architektur passt nicht zum Katalogeintrag'
        if (requires.gpuVendor === 'nvidia' && c.gpu !== 'nvidia') return 'Katalogeintrag braucht eine NVIDIA-GPU'
    }
    return null
}

export interface SoftwareCandidateCatalog {
    version: 1
    entries: SoftwareCandidate[]
    rejected: Array<{ id: string; reason: string }>
    hash: string
}

/** Loads and validates candidates. Failing entries (incl. never-list) are rejected, never repaired. Order is kept (= preference). */
export function loadSoftwareCandidates(raw: readonly unknown[] = BUILTIN_SOFTWARE_CANDIDATES, installCatalog: InstallCatalog = getInstallCatalog()): SoftwareCandidateCatalog {
    const entries: SoftwareCandidate[] = []
    const rejected: Array<{ id: string; reason: string }> = []
    const seen = new Set<string>()
    for (const item of raw) {
        const id = typeof (item as any)?.id === 'string' ? (item as any).id : '?'
        const reason = validateSoftwareCandidate(item, installCatalog) || (seen.has(id) ? 'doppelte id' : null)
        if (reason) { rejected.push({ id: String(id).slice(0, 80), reason }); continue }
        seen.add(id)
        entries.push(Object.freeze(structuredClone(item)) as SoftwareCandidate)
    }
    return { version: 1, entries, rejected, hash: sha256Hex(canonicalJson(entries)) }
}

let builtin: SoftwareCandidateCatalog | null = null
export function getSoftwareCandidates(): SoftwareCandidateCatalog {
    builtin ||= loadSoftwareCandidates()
    return builtin
}
export function findSoftwareCandidate(id: unknown, catalog = getSoftwareCandidates()): SoftwareCandidate | undefined {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined
    return catalog.entries.find(entry => entry.id === id)
}

/** Published form for docs/generated (reproducible from source). */
export function publishedSoftwareCandidates(catalog = getSoftwareCandidates()): { version: 1; candidatesHash: string; entries: SoftwareCandidate[]; rejected: Array<{ id: string; reason: string }> } {
    return { version: 1, candidatesHash: catalog.hash, entries: catalog.entries, rejected: catalog.rejected }
}
