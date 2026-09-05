/**
 * Nova Capability Researcher
 *
 * When the Self-Setup-Orchestrator finds a missing capability, this module
 * spawns a focused subagent with web_search to find the CURRENT best solution —
 * not a hardcoded recipe from when the code was written.
 *
 * Flow per missing capability:
 *   1. Build hardware-aware research prompt (Apple Silicon / CUDA / ARM / Windows)
 *   2. Spawn subagent: web_search + read_url → structured JSON response
 *   3. Parse candidate list (recommended + alternatives)
 *   4. Cache result 7 days (re-search on force or expiry)
 *   5. Convert to SetupAction for applySelfSetupAction()
 *
 * Static fallbacks are used when web search is unavailable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { MeshSetupNode, SetupAction } from './self-setup-orchestrator.js'

// ============================================
// Types
// ============================================

export interface CapabilityCandidate {
    name: string
    version?: string
    installCommand: string
    sourceUrl?: string
    rationale: string
}

export interface CapabilityResearchResult {
    capability: string
    nodeName: string
    nodeHost?: string
    os: string
    hardware: string
    recommended: CapabilityCandidate
    alternatives: CapabilityCandidate[]
    researchedAt: string
    searchQueries?: string[]
    cached?: boolean
    /** high = aktuell aus offiziellen Quellen; medium = web-Fallback; low = statisch hardcoded */
    confidence: 'high' | 'medium' | 'low'
}

export interface ResearchOptions {
    force?: boolean
    timeoutMs?: number
    skipWeb?: boolean      // use static fallbacks only (for tests/offline)
}

// ============================================
// Cache
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const RESEARCH_CACHE_FILE = join(DATA_DIR, 'capability-research.json')
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days

type ResearchCache = Record<string, CapabilityResearchResult & { cachedAt: number }>

function loadCache(): ResearchCache {
    if (!existsSync(RESEARCH_CACHE_FILE)) return {}
    try { return JSON.parse(readFileSync(RESEARCH_CACHE_FILE, 'utf-8')) } catch { return {} }
}

function saveCache(cache: ResearchCache): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(RESEARCH_CACHE_FILE, JSON.stringify(cache, null, 2))
}

function cacheKey(capability: string, nodeName: string, hw: string): string {
    return `${capability}:${nodeName}:${hw}`.replace(/[^a-z0-9:]/gi, '_').toLowerCase().slice(0, 120)
}

// ============================================
// Hardware helpers
// ============================================

function isAppleSilicon(hardware: unknown): boolean {
    return /apple|m[1-4]|metal/i.test(JSON.stringify(hardware ?? ''))
}

function hasNvidiaCuda(hardware: unknown): boolean {
    return /nvidia|cuda|jetson|rtx|gtx/i.test(JSON.stringify(hardware ?? ''))
}

function isArmEdge(node: MeshSetupNode): boolean {
    return /pi|rpi|raspberry|arm|aarch/i.test(`${node.name} ${node.role ?? ''} ${JSON.stringify(node.hardware ?? '')}`)
}

function detectOs(node: MeshSetupNode): 'macos' | 'windows' | 'linux' | 'arm-linux' {
    const hw = JSON.stringify(node.hardware ?? {}).toLowerCase()
    const name = (node.name + ' ' + (node.role ?? '')).toLowerCase()
    if (/mac|apple|m[1-4]/.test(hw) || /mac/.test(name)) return 'macos'
    if (/win/.test(hw) || /windows/.test(name)) return 'windows'
    if (isArmEdge(node)) return 'arm-linux'
    return 'linux'
}

// ============================================
// Research prompt
// ============================================

const TODAY = new Date().toISOString().split('T')[0]

const CAPABILITY_CONTEXT: Record<string, string> = {
    stt: 'Speech-to-Text (lokale Transkription, kein Cloud), z.B. Whisper-Varianten, Vosk, wav2vec2',
    tts: 'Text-to-Speech (lokal oder leichtgewichtig), z.B. edge-tts, piper, coqui, mimic3',
    llm: 'Lokale LLM-Inferenz-Server, z.B. Ollama, llama.cpp, LM Studio, vllm',
    embedding: 'Lokale Embedding-Modelle via Ollama oder sentence-transformers',
    vision: 'Multimodale Vision-LLMs lokal, z.B. LLaVA, moondream, minicpm-v via Ollama',
    whisper: 'OpenAI Whisper Implementierungen: faster-whisper, whisper.cpp, whisperx',
    ffmpeg: 'FFmpeg Installation (aktuellste stabile Version)',
    ollama: 'Ollama lokale Installation und Einrichtung',
}

function buildResearchPrompt(capability: string, node: MeshSetupNode): string {
    const os = detectOs(node)
    const apple = isAppleSilicon(node.hardware)
    const cuda = hasNvidiaCuda(node.hardware)
    const arm = isArmEdge(node)
    const hw = JSON.stringify(node.hardware ?? {})
    const context = CAPABILITY_CONTEXT[capability] ?? capability

    const hwHint = apple
        ? 'Apple Silicon (Metal-Unterstützung bevorzugen, kein CUDA)'
        : cuda
            ? 'NVIDIA CUDA GPU (CUDA-beschleunigte Pakete bevorzugen)'
            : arm
                ? 'ARM-Linux (Raspberry Pi / Jetson, leichtgewichtige Pakete bevorzugen)'
                : 'x86 Linux/Windows (CPU-Inferenz)'

    return `Du bist ein Software-Recherche-Assistent. Finde die BESTE aktuelle Lösung für eine KI-Capability.

CAPABILITY: ${capability}
KONTEXT: ${context}
HARDWARE: ${hwHint}
RAW HARDWARE: ${hw}
OS: ${os}
DATUM HEUTE: ${TODAY}

AUFGABE:
1. Suche nach der aktuell besten Lösung für "${capability}" auf ${hwHint} (Stand ${TODAY}).
2. Prüfe offizielle Repos/Docs auf aktuelle Version und Install-Commands.
3. Berücksichtige Hardware-spezifische Optimierungen (Metal für Apple, CUDA für Nvidia, etc.).
4. Liste max. 2 sinnvolle Alternativen.

WICHTIG: Antworte NUR mit folgendem JSON (kein Markdown, kein Text davor/danach):
{
  "recommended": {
    "name": "Paketname oder Tool",
    "version": "aktuelle Version z.B. 1.2.3",
    "installCommand": "exakter Install-Command für dieses OS",
    "sourceUrl": "https://github.com/... oder offizielle Docs",
    "rationale": "Warum diese Wahl für diese Hardware (1-2 Sätze)"
  },
  "alternatives": [
    {
      "name": "Alternative 1",
      "version": "Version",
      "installCommand": "...",
      "sourceUrl": "...",
      "rationale": "Wann besser als Empfehlung"
    }
  ],
  "confidence": "high",
  "searchQueries": ["Query 1 die du genutzt hast", "Query 2"]
}

confidence-Werte: "high" = offizielle aktuelle Quelle gefunden, "medium" = Quelle gefunden aber Version unsicher, "low" = nur allgemeine Informationen`
}

// ============================================
// Static fallbacks (offline / test mode)
// ============================================

function getStaticFallback(capability: string, node: MeshSetupNode): CapabilityResearchResult {
    const os = detectOs(node)
    const apple = isAppleSilicon(node.hardware)
    const cuda = hasNvidiaCuda(node.hardware)

    type StaticMap = Record<string, Record<string, CapabilityCandidate>>
    const statics: StaticMap = {
        stt: {
            macos: {
                name: 'faster-whisper',
                installCommand: apple
                    ? 'pip install faster-whisper pyaudio coremltools'
                    : 'pip install faster-whisper pyaudio',
                sourceUrl: 'https://github.com/SYSTRAN/faster-whisper',
                rationale: 'Schnellste Whisper-Variante; Apple-Silicon-Support via coremltools',
            },
            windows: {
                name: 'faster-whisper',
                installCommand: 'pip install faster-whisper pyaudio',
                sourceUrl: 'https://github.com/SYSTRAN/faster-whisper',
                rationale: 'Beste Whisper-Implementierung für Windows CPU/GPU',
            },
            linux: {
                name: 'faster-whisper',
                installCommand: cuda
                    ? 'pip install faster-whisper[cuda] pyaudio'
                    : 'pip install faster-whisper pyaudio',
                sourceUrl: 'https://github.com/SYSTRAN/faster-whisper',
                rationale: cuda ? 'CUDA-beschleunigt via CTranslate2' : 'CPU-Inferenz mit CTranslate2',
            },
            'arm-linux': {
                name: 'faster-whisper',
                installCommand: 'pip install faster-whisper pyaudio',
                sourceUrl: 'https://github.com/SYSTRAN/faster-whisper',
                rationale: 'Läuft auf ARM; tiny/base-Modell für Pi5 empfohlen',
            },
        },
        tts: {
            _default: {
                name: 'edge-tts',
                installCommand: 'pip install edge-tts',
                sourceUrl: 'https://github.com/rany2/edge-tts',
                rationale: 'Kostenlos, hochwertige Stimmen, keine lokale GPU nötig',
            },
        },
        embedding: {
            _default: {
                name: 'nomic-embed-text',
                installCommand: 'ollama pull nomic-embed-text',
                sourceUrl: 'https://ollama.com/library/nomic-embed-text',
                rationale: 'Bestes lokal verfügbares Embedding-Modell, 137M Parameter',
            },
        },
        llm: {
            macos: {
                name: 'ollama',
                installCommand: 'brew install ollama',
                sourceUrl: 'https://ollama.com',
                rationale: 'Native Apple-Silicon-Unterstützung, Metal-Beschleunigung',
            },
            windows: {
                name: 'ollama',
                installCommand: 'winget install Ollama.Ollama',
                sourceUrl: 'https://ollama.com',
                rationale: 'Einfachste lokale LLM-Lösung für Windows',
            },
            linux: {
                name: 'ollama',
                installCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
                sourceUrl: 'https://ollama.com',
                rationale: cuda ? 'NVIDIA CUDA automatisch erkannt' : 'CPU-Inferenz mit GGUF',
            },
            'arm-linux': {
                name: 'ollama',
                installCommand: 'curl -fsSL https://ollama.com/install.sh | sh',
                sourceUrl: 'https://ollama.com',
                rationale: 'ARM64-Build verfügbar, kleine Modelle (phi3:mini, qwen2:0.5b) für Pi5',
            },
        },
        vision: {
            _default: {
                name: 'llava',
                installCommand: 'ollama pull llava',
                sourceUrl: 'https://ollama.com/library/llava',
                rationale: 'Multimodales Vision-LLM via Ollama, Apple Silicon und CUDA unterstützt',
            },
        },
        ffmpeg: {
            macos: {
                name: 'ffmpeg',
                installCommand: 'brew install ffmpeg',
                sourceUrl: 'https://ffmpeg.org',
                rationale: 'Aktuellste Version via Homebrew',
            },
            windows: {
                name: 'ffmpeg',
                installCommand: 'winget install --id Gyan.FFmpeg --source winget --accept-package-agreements',
                sourceUrl: 'https://ffmpeg.org',
                rationale: 'Aktuellste stabile Version via winget',
            },
            linux: {
                name: 'ffmpeg',
                installCommand: 'sudo apt-get install -y ffmpeg',
                sourceUrl: 'https://ffmpeg.org',
                rationale: 'Distribution-Paket, ausreichend für Voice-Pipeline',
            },
            'arm-linux': {
                name: 'ffmpeg',
                installCommand: 'sudo apt-get install -y ffmpeg',
                sourceUrl: 'https://ffmpeg.org',
                rationale: 'ARM64-Binary verfügbar in Raspberry Pi OS',
            },
        },
    }

    const capEntry = statics[capability]
    const candidate: CapabilityCandidate = capEntry
        ? (capEntry[os] ?? capEntry['_default'] ?? {
            name: capability,
            installCommand: `echo "Kein Rezept fuer ${capability} auf ${os}"`,
            rationale: 'Statisches Fallback nicht vorhanden — Web-Recherche empfohlen',
        })
        : {
            name: capability,
            installCommand: `echo "Kein Rezept fuer ${capability}"`,
            rationale: 'Unbekannte Capability — manuelle Recherche nötig',
        }

    return {
        capability,
        nodeName: node.name,
        nodeHost: node.host,
        os,
        hardware: JSON.stringify(node.hardware ?? {}),
        recommended: { ...candidate, version: candidate.version ?? 'latest' },
        alternatives: [],
        researchedAt: new Date().toISOString(),
        confidence: 'low',  // static fallback — no live verification
    }
}

// ============================================
// Parse LLM JSON output (handles code fences)
// ============================================

function parseResearchJson(output: string): { recommended: CapabilityCandidate; alternatives: CapabilityCandidate[]; searchQueries?: string[]; confidence?: 'high' | 'medium' | 'low' } | null {
    // Strip markdown code fences if present
    const stripped = output
        .replace(/^```(?:json)?\n?/m, '')
        .replace(/\n?```$/m, '')
        .trim()

    // Find first { ... } block
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end < 0) return null

    try {
        const parsed = JSON.parse(stripped.slice(start, end + 1))
        if (!parsed?.recommended?.name || !parsed?.recommended?.installCommand) return null
        return parsed
    } catch {
        return null
    }
}

// ============================================
// Node selection for capability
// ============================================

function scoreNodeForCapability(capability: string, node: MeshSetupNode): number {
    let score = 0
    const apple = isAppleSilicon(node.hardware)
    const cuda = hasNvidiaCuda(node.hardware)
    const caps = node.capabilities

    switch (capability) {
        case 'stt': case 'tts': case 'whisper':
            if (apple) score += 10
            if (cuda) score += 8
            break
        case 'llm':
            if (apple) score += 10
            if (cuda) score += 9
            break
        case 'embedding':
            // Any capable node, prefer low latency
            score += caps.includes('ollama') ? 5 : 0
            break
        case 'vision':
            if (cuda) score += 10
            if (apple) score += 8
            break
    }

    // Prefer reachable/low-latency nodes
    if (node.latencyMs !== undefined) score += Math.max(0, 5 - node.latencyMs / 200)
    // Slight preference for local node
    if (node.name === hostname() || node.host === 'localhost') score += 2

    return score
}

export function selectBestNodeForCapability(capability: string, nodes: MeshSetupNode[]): MeshSetupNode | null {
    const online = nodes.filter(n => n.online)
    if (!online.length) return nodes[0] ?? null  // fallback to first even if offline

    return online
        .map(n => ({ node: n, score: scoreNodeForCapability(capability, n) }))
        .sort((a, b) => b.score - a.score)[0]?.node ?? null
}

// ============================================
// Core research function
// ============================================

export async function researchCapability(
    capability: string,
    node: MeshSetupNode,
    options: ResearchOptions = {},
): Promise<CapabilityResearchResult> {
    const hwKey = JSON.stringify(node.hardware ?? {}).slice(0, 80)
    const key = cacheKey(capability, node.name, hwKey)

    // Check cache first
    if (!options.force) {
        const cache = loadCache()
        const cached = cache[key]
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
            console.log(`[CapabilityResearcher] 📦 Cache hit: ${capability} on ${node.name}`)
            return { ...cached, cached: true }
        }
    }

    // Skip web in test/offline mode
    if (options.skipWeb) {
        return getStaticFallback(capability, node)
    }

    console.log(`[CapabilityResearcher] 🔬 Researching: ${capability} on ${node.name} (${detectOs(node)})`)

    let result: CapabilityResearchResult

    try {
        const { spawnSubagent } = await import('../agents/subagent-orchestrator.js')

        const subResult = await spawnSubagent({
            task: buildResearchPrompt(capability, node),
            tools: ['web_search', 'read_url'],
            timeoutMs: options.timeoutMs ?? 90_000,
            systemPrompt: 'Du bist ein präziser Software-Recherche-Assistent. Antworte IMMER mit validem JSON ohne Markdown.',
        })

        if (subResult.status !== 'completed' || !subResult.output) {
            throw new Error(`Subagent ${subResult.status}: ${subResult.error ?? 'no output'}`)
        }

        const parsed = parseResearchJson(subResult.output)
        if (!parsed) {
            throw new Error(`JSON-Parsing fehlgeschlagen. Output: ${subResult.output.slice(0, 200)}`)
        }

        const confidence: 'high' | 'medium' | 'low' =
            parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
                ? parsed.confidence
                : 'medium'  // unknown value from LLM → conservative default

        result = {
            capability,
            nodeName: node.name,
            nodeHost: node.host,
            os: detectOs(node),
            hardware: hwKey,
            recommended: {
                ...parsed.recommended,
                version: parsed.recommended.version ?? 'latest',
            },
            alternatives: (parsed.alternatives ?? []).slice(0, 3),
            searchQueries: parsed.searchQueries,
            researchedAt: new Date().toISOString(),
            confidence,
        }

        console.log(`[CapabilityResearcher] ✅ Found: ${result.recommended.name} v${result.recommended.version} [confidence: ${confidence}]`)
    } catch (err) {
        console.warn(`[CapabilityResearcher] ⚠️ Web-Recherche fehlgeschlagen (${err}) — nutze statisches Fallback`)
        result = getStaticFallback(capability, node)
    }

    // Write cache
    const cache = loadCache()
    cache[key] = { ...result, cachedAt: Date.now() }
    saveCache(cache)

    return result
}

// ============================================
// Research all missing capabilities in parallel
// ============================================

export async function researchAllMissingCapabilities(
    missingCapabilities: string[],
    nodes: MeshSetupNode[],
    options: ResearchOptions = {},
): Promise<CapabilityResearchResult[]> {
    if (!missingCapabilities.length) return []

    const tasks = missingCapabilities.map(async cap => {
        const bestNode = selectBestNodeForCapability(cap, nodes)
        if (!bestNode) {
            console.warn(`[CapabilityResearcher] No suitable node for ${cap}`)
            return null
        }
        try {
            return await researchCapability(cap, bestNode, options)
        } catch {
            return null
        }
    })

    const results = await Promise.all(tasks)
    return results.filter((r): r is CapabilityResearchResult => r !== null)
}

// ============================================
// Convert research result → SetupAction
// ============================================

export function researchResultToSetupAction(res: CapabilityResearchResult): SetupAction {
    const localHost = hostname()
    const isLocal = res.nodeName === localHost
        || res.nodeName === 'localhost'
        || res.nodeHost === 'localhost'

    const id = `research:${res.capability}:${res.nodeName}`
        .replace(/[^a-zA-Z0-9:_-]/g, '_')
        .slice(0, 96)

    const versionLabel = res.recommended.version && res.recommended.version !== 'latest'
        ? ` v${res.recommended.version}`
        : ''

    return {
        id,
        type: isLocal ? 'local_shell' : 'remote_shell',
        target: res.nodeName,
        title: `${res.capability} installieren: ${res.recommended.name}${versionLabel}`,
        reason: res.recommended.rationale,
        risk: 'medium',
        command: isLocal
            ? res.recommended.installCommand
            : res.nodeHost
                ? `ssh ${res.nodeHost} "${res.recommended.installCommand.replace(/"/g, '\\"')}"`
                : undefined,
        // Full research metadata — shown in /setup plan, never affects execution
        research: {
            name: res.recommended.name,
            version: res.recommended.version,
            hardwareMatch: res.recommended.rationale,
            installMethod: res.recommended.installCommand,
            sourceUrl: res.recommended.sourceUrl,
            researchedAt: res.researchedAt,
            confidence: res.confidence,
            alternatives: res.alternatives.map(a => a.name),
        },
    }
}

// ============================================
// Format for Telegram/CLI output
// ============================================

export function formatResearchResult(res: CapabilityResearchResult): string {
    const cacheLabel = res.cached ? ' _(cached)_' : ''
    const version = res.recommended.version && res.recommended.version !== 'latest'
        ? ` v${res.recommended.version}`
        : ''

    const lines = [
        `🔬 **${res.capability}** auf \`${res.nodeName}\` (${res.os})${cacheLabel}`,
        `📅 Stand: ${res.researchedAt.slice(0, 10)}`,
        '',
        `✅ **${res.recommended.name}${version}**`,
        `   ${res.recommended.rationale}`,
        `   \`${res.recommended.installCommand}\``,
        res.recommended.sourceUrl ? `   🔗 ${res.recommended.sourceUrl}` : '',
    ]

    if (res.alternatives.length > 0) {
        lines.push('', '**Alternativen:**')
        for (const alt of res.alternatives) {
            const altVer = alt.version && alt.version !== 'latest' ? ` v${alt.version}` : ''
            lines.push(`• **${alt.name}${altVer}**: ${alt.rationale}`)
        }
    }

    return lines.filter(l => l !== '').join('\n')
}

export function formatAllResearchResults(results: CapabilityResearchResult[]): string {
    if (!results.length) return '✅ Keine fehlenden Capabilities recherchiert.'
    return results.map(formatResearchResult).join('\n\n---\n\n')
}

export default {
    researchCapability,
    researchAllMissingCapabilities,
    researchResultToSetupAction,
    selectBestNodeForCapability,
    formatResearchResult,
    formatAllResearchResults,
}
