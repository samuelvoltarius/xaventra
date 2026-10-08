/**
 * Nova — AI Service Scanner
 *
 * Scans localhost and mesh nodes for AI services:
 * LLM, VLM, TTS, STT, Embeddings
 *
 * Supports: Ollama, LM Studio, llama.cpp, vLLM, KoboldCPP, LocalAI,
 *           Whisper, Chatterbox, Piper TTS, Coqui/XTTS, and more.
 *
 * Two scan modes:
 *   1. Port Scan — what's running?
 *   2. Binary Scan — what's installed but not running?
 */

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'
import { getAiProbeClient, type DiscoveryProbeClient } from './discovery-probe.js'
import type { MeshNode } from './mesh-registry.js'
import { ownSubnets, scanHosts, scanTargetAllowed, type InterfaceMap } from '../sensing/net-scope.js'
import { ProbeLimiter, realTcpProbe } from '../sensing/discovery.js'
import { parseSensingConfig } from '../sensing/config.js'
import { isXaventraVoiceHealth, VOICE_SERVICE_NAME, VOICE_SERVICE_PORT } from '../voice/voice-contract.js'
import { isWhisperGpuHealth, whisperGpuModels, WHISPER_GPU_NAME, WHISPER_GPU_PORT } from '../voice/whisper-gpu.js'
import {
    isOpenAiSttHealth, isPocketTtsHealth, openAiAudioModels,
    OPENAI_AUDIO_STT_NAME, OPENAI_AUDIO_STT_PORT, POCKET_TTS_NAME, POCKET_TTS_PORT,
} from '../voice/openai-audio.js'


const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// ============================================
// Types
// ============================================

/** `search`: local helper services Xaventra can use itself (SearXNG, 2.85 Paket C). */
export type AIServiceType = 'llm' | 'vlm' | 'tts' | 'stt' | 'embeddings' | 'image' | 'search'

export interface AIServiceProbe {
    name: string
    type: AIServiceType
    defaultPort: number
    healthEndpoint: string
    modelsEndpoint?: string
    /** How to parse the health response to confirm it's this service */
    detectFn: (body: string) => boolean
    /** How to extract model list from the models endpoint response */
    parseModelsFn?: (body: string) => string[]
    /** Binary names to search for on disk (installed but not running) */
    binaries?: string[]
    /** systemd service names to check */
    systemdServices?: string[]
}

export interface DiscoveredAIService {
    id: string
    name: string
    type: AIServiceType
    provider: string
    host: string
    port: number
    endpoint: string
    models: string[]
    status: 'running' | 'installed' | 'stopped'
    lastSeen: string
    sourceNode?: string
    capabilities?: string[]
    metadata?: Record<string, unknown>
}

export interface AIScanResult {
    lastScan: string
    scanDurationMs: number
    services: DiscoveredAIService[]
    sleepingSoftware?: SleepingSoftware[]
}

// ============================================
// Service Probe Definitions (extensible)
// ============================================

export const AI_SERVICE_PROBES: AIServiceProbe[] = [
    {
        name: 'comfyui',
        type: 'image',
        defaultPort: 8188,
        healthEndpoint: '/system_stats',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return Boolean(data.system || data.devices)
            } catch { return false }
        },
        binaries: ['comfyui', 'comfy'],
    },
    // === LLM Servers ===
    {
        name: 'ollama',
        type: 'llm',
        defaultPort: 11434,
        healthEndpoint: '/api/tags',
        modelsEndpoint: '/api/tags',
        detectFn: (body) => {
            try { return 'models' in JSON.parse(body) } catch { return false }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.models || []).map((m: { name: string }) => m.name)
            } catch { return [] }
        },
        binaries: ['ollama'],
        systemdServices: ['ollama'],
    },
    {
        name: 'lm-studio',
        type: 'llm',
        defaultPort: 1234,
        healthEndpoint: '/v1/models',
        modelsEndpoint: '/v1/models',
        detectFn: (body) => {
            try { return 'data' in JSON.parse(body) } catch { return false }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.data || []).map((m: { id: string }) => m.id)
            } catch { return [] }
        },
    },
    {
        name: 'llama-cpp',
        type: 'llm',
        defaultPort: 8080,
        healthEndpoint: '/health',
        modelsEndpoint: '/v1/models',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return data.status === 'ok' || 'data' in data
            } catch { return body.includes('ok') }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.data || []).map((m: { id: string }) => m.id)
            } catch { return [] }
        },
        binaries: ['llama-server', 'llama-cpp-server', 'server'],
        systemdServices: ['llama-cpp'],
    },
    {
        name: 'vllm',
        type: 'llm',
        defaultPort: 8000,
        healthEndpoint: '/health',
        modelsEndpoint: '/v1/models',
        // vLLM commonly answers /health with HTTP 200 and an empty body.
        detectFn: (body) => body.trim() === '' || body.includes('ok') || body.includes('healthy'),
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.data || []).map((m: { id: string }) => m.id)
            } catch { return [] }
        },
        binaries: ['vllm'],
    },
    {
        name: 'koboldcpp',
        type: 'llm',
        defaultPort: 5001,
        healthEndpoint: '/api/v1/model',
        detectFn: (body) => {
            try { return 'result' in JSON.parse(body) } catch { return false }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return data.result ? [data.result] : []
            } catch { return [] }
        },
        binaries: ['koboldcpp'],
    },
    {
        name: 'localai',
        type: 'llm',
        defaultPort: 8080,
        healthEndpoint: '/readyz',
        modelsEndpoint: '/v1/models',
        detectFn: (body) => body.includes('ok') || body.includes('ready'),
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.data || []).map((m: { id: string }) => m.id)
            } catch { return [] }
        },
    },
    {
        name: 'tabbyapi',
        type: 'llm',
        defaultPort: 5000,
        healthEndpoint: '/v1/models',
        detectFn: (body) => {
            try { return 'data' in JSON.parse(body) } catch { return false }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.data || []).map((m: { id: string }) => m.id)
            } catch { return [] }
        },
    },

    // === TTS Servers ===
    {
        name: 'chatterbox',
        type: 'tts',
        defaultPort: 8150,
        healthEndpoint: '/health',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return data.status === 'ok' || data.status === 'healthy'
            } catch { return body.includes('ok') || body.includes('chatterbox') }
        },
        binaries: ['chatterbox', 'chatterbox-server'],
        systemdServices: ['chatterbox'],
    },
    {
        name: 'piper',
        type: 'tts',
        defaultPort: 5030,
        healthEndpoint: '/',
        detectFn: (body) => body.includes('piper') || body.includes('tts'),
        binaries: ['piper', 'piper-tts'],
        systemdServices: ['piper'],
    },
    {
        name: 'coqui-xtts',
        type: 'tts',
        defaultPort: 8020,
        healthEndpoint: '/api/ready',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return data === true || data === 'ready' || data?.ready === true || data?.status === 'ready'
            } catch { return false }
        },
        binaries: ['xtts', 'tts-server'],
    },
    {
        name: 'f5-tts',
        type: 'tts',
        defaultPort: 7860,
        healthEndpoint: '/',
        detectFn: (body) => body.includes('f5') || body.includes('gradio'),
        binaries: ['f5-tts'],
    },

    // === STT Servers ===
    {
        name: 'whisper-server',
        type: 'stt',
        defaultPort: 9000,
        healthEndpoint: '/health',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return data.status === 'ok' || 'status' in data
            } catch { return body.includes('whisper') || body.includes('ok') }
        },
        binaries: ['whisper-server', 'whisper', 'faster-whisper-server'],
        systemdServices: ['whisper', 'faster-whisper'],
    },
    {
        name: 'vosk-server',
        type: 'stt',
        defaultPort: 2700,
        healthEndpoint: '/',
        detectFn: (body) => body.includes('vosk') || body.length > 0,
        binaries: ['vosk-server'],
    },

    // 2.86 Paket O: Xaventras eigener Sprachdienst (Verstehen + Sprechen + Freisprechen).
    // Strenge Erkennung: nur die eigene Health-Antwort, nie ein beliebiges {status: ok}.
    {
        name: VOICE_SERVICE_NAME,
        type: 'stt',
        defaultPort: VOICE_SERVICE_PORT,
        healthEndpoint: '/health',
        detectFn: isXaventraVoiceHealth,
    },

    // 2.86.1 Ergänzung b: whisper-gpu (OpenAI-kompatibel, Audio ≤ 30 s), z. B. auf dem Spark.
    // Strenge Erkennung: Health-JSON mit status ok UND einem whisper-Modell.
    {
        name: WHISPER_GPU_NAME,
        type: 'stt',
        defaultPort: WHISPER_GPU_PORT,
        healthEndpoint: '/health',
        modelsEndpoint: '/health',
        detectFn: isWhisperGpuHealth,
        parseModelsFn: whisperGpuModels,
    },

    // 2.89.4: OpenAI-kompatible Sprachdienste im eigenen Netz (Pocket-TTS & Co.).
    // Erkennung über /v1/models — statt „installieren“ anzubieten, wenn sie laufen.
    {
        name: POCKET_TTS_NAME,
        type: 'tts',
        defaultPort: POCKET_TTS_PORT,
        healthEndpoint: '/v1/models',
        modelsEndpoint: '/v1/models',
        detectFn: isPocketTtsHealth,
        parseModelsFn: openAiAudioModels,
        binaries: ['pocket-tts', 'pocket_tts'],
        systemdServices: ['pocket-tts'],
    },
    {
        name: OPENAI_AUDIO_STT_NAME,
        type: 'stt',
        defaultPort: OPENAI_AUDIO_STT_PORT,
        healthEndpoint: '/v1/models',
        modelsEndpoint: '/v1/models',
        detectFn: isOpenAiSttHealth,
        parseModelsFn: openAiAudioModels,
    },

    // === Embedding Servers ===
    {
        name: 'ollama-embeddings',
        type: 'embeddings',
        defaultPort: 11434,
        healthEndpoint: '/api/tags',
        detectFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.models || []).some((m: { name: string }) =>
                    m.name.includes('embed') || m.name.includes('nomic')
                )
            } catch { return false }
        },
        parseModelsFn: (body) => {
            try {
                const data = JSON.parse(body)
                return (data.models || [])
                    .filter((m: { name: string }) =>
                        m.name.includes('embed') || m.name.includes('nomic') || m.name.includes('bge')
                    )
                    .map((m: { name: string }) => m.name)
            } catch { return [] }
        },
    },

    // === Local helper services (2.85 Paket C) ===
    // SearXNG answers its public, unauthenticated `/config` with a JSON
    // description (engines, categories, instance_name). Docker default 8080,
    // settings.yml default 8888, common reverse-proxy port 8088.
    ...[8080, 8888, 8088].map((port): AIServiceProbe => ({
        name: 'searxng',
        type: 'search',
        defaultPort: port,
        healthEndpoint: '/config',
        detectFn: isSearxngConfig,
    })),
]

/** True for SearXNG's `/config` JSON. */
export function isSearxngConfig(body: string): boolean {
    try {
        const data = JSON.parse(body)
        return Boolean(data && typeof data === 'object' && Array.isArray(data.engines) && Array.isArray(data.categories)
            && ('instance_name' in data || 'safe_search' in data || 'brand' in data))
    } catch { return false }
}

// ============================================
// In-Memory Registry
// ============================================

let discoveredServices: DiscoveredAIService[] = []
let lastScanResult: AIScanResult | null = null
let scanInFlight: Promise<AIScanResult> | null = null
let scanInterval: ReturnType<typeof setInterval> | null = null
let firstOwnNetworkTimer: ReturnType<typeof setTimeout> | null = null

const SCAN_RESULTS_FILE = '.nova-data/ai-services.json'
const DEFAULT_SCAN_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_FULL_SCAN_INTERVAL_MS = 30 * 60 * 1000
let lastFullScanAt = 0

export function isFullInventoryDue(
    lastFullAt: number,
    now = Date.now(),
    intervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
): boolean {
    return lastFullAt === 0 || now - lastFullAt >= intervalMs
}

// ============================================
// Port Scanner
// ============================================

// One shared KI-port probe client with result cache (mesh/discovery-probe.ts, 2.82.0).
function getDiscoveryProbeClient(): DiscoveryProbeClient {
    return getAiProbeClient()
}

async function probeEndpoint(
    host: string,
    port: number,
    path: string,
    timeoutMs = 3000
): Promise<string | null> {
    return getDiscoveryProbeClient().probe(`http://${host}:${port}${path}`, timeoutMs)
}

// ============================================
// Service Scanner (per host)
// ============================================

export async function scanHost(
    host: string,
    nodeLabel?: string,
    timeoutMs = 3000,
    probes: readonly AIServiceProbe[] = AI_SERVICE_PROBES,
): Promise<DiscoveredAIService[]> {
    const found: DiscoveredAIService[] = []
    const endpointCache = new Map<string, Promise<string | null>>()
    const probeCached = (port: number, path: string) => {
        const key = `${host}:${port}:${path}`
        if (!endpointCache.has(key)) endpointCache.set(key, probeEndpoint(host, port, path, timeoutMs))
        return endpointCache.get(key)!
    }

    const probePromises = probes.map(async (probe) => {
        const probeUrl = `http://${host}:${probe.defaultPort}${probe.healthEndpoint}`
        if (!getDiscoveryProbeClient().allowsService(probeUrl, probe.name)) return
        const body = await probeCached(probe.defaultPort, probe.healthEndpoint)
        if (body === null) return

        const matches = probe.detectFn(body)
        getDiscoveryProbeClient().recordService(probeUrl, probe.name, matches)
        if (!matches) return

        // Service detected! Get model list
        let models: string[] = []
        if (probe.modelsEndpoint && probe.parseModelsFn) {
            const modelsBody = probe.modelsEndpoint === probe.healthEndpoint
                ? body
                : await probeCached(probe.defaultPort, probe.modelsEndpoint)
            if (modelsBody) {
                models = probe.parseModelsFn(modelsBody)
            }
        }

        const endpoint = `http://${host}:${probe.defaultPort}`
        found.push({
            id: `${probe.name}@${host}:${probe.defaultPort}`,
            name: probe.name,
            type: probe.type,
            provider: probe.name,
            host,
            port: probe.defaultPort,
            endpoint,
            models,
            status: 'running',
            lastSeen: new Date().toISOString(),
            sourceNode: nodeLabel || (host === 'localhost' || host === '127.0.0.1' ? 'local' : host),
        })
    })

    await Promise.allSettled(probePromises)
    return found
}

// ============================================
// Own network (2.85 Paket C): unknown devices in the own LAN/Tailnet
// ============================================
//
// Phases 1-5 only look at localhost, mesh nodes and configured SSH nodes.
// This phase finds KI/helper services on other machines of the OWN private
// networks, with the same limits as the device discovery (src/sensing):
//   - targets only from net-scope (own private subnets, max /24 each; Tailnet
//     only with an own Tailnet interface) and `scanTargetAllowed` directly
//     before every connection (public/foreign addresses are never touched);
//   - first a plain TCP connect per probe port, then only the unauthenticated
//     read-only GET paths of the probes above (health/models/config);
//   - rate limit, bounded parallelism and a hard overall deadline;
//   - no credentials, no writes, no installation commands.
// Findings become ordinary scan services (status running, sourceNode = host,
// metadata.source = 'own-network'): the capability graph and the model
// registry pick them up; Paket A lists them silently under "Gefunden".

export const OWN_NETWORK_SOURCE = 'own-network'
/** Hourly, plus once shortly after start (first start of Paket B included). */
export const OWN_NETWORK_SCAN_INTERVAL_MS = 60 * 60 * 1000
export const OWN_NETWORK_FIRST_RUN_DELAY_MS = 60 * 1000

export interface OwnNetworkScanOptions {
    deadlineMs: number
    ratePerSec: number
    concurrency: number
    maxHosts: number
    tailnetHosts: string[]
    probeTimeoutMs?: number
    /** Hosts already covered by phases 1-5 (mesh/config nodes). */
    skipHosts?: string[]
}

export interface OwnNetworkScanDeps {
    interfaces?: InterfaceMap
    tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
    /** Unauthenticated GET; body or null. Default: the shared KI probe client. */
    httpGet?: (url: string, timeoutMs: number) => Promise<string | null>
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    probes?: readonly AIServiceProbe[]
}

export interface OwnNetworkScanReport {
    services: DiscoveredAIService[]
    scannedHosts: number
    probes: number
    rejected: Array<{ host: string; reason: string }>
    timedOut: boolean
    durationMs: number
}

export async function scanOwnNetworkAIServices(options: OwnNetworkScanOptions, deps: OwnNetworkScanDeps = {}): Promise<OwnNetworkScanReport> {
    const now = deps.now || Date.now
    const sleep = deps.sleep || ((ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
    const tcpProbe = deps.tcpProbe || realTcpProbe
    const httpGet = deps.httpGet || ((url: string, timeoutMs: number) => getDiscoveryProbeClient().probe(url, timeoutMs))
    const probes = deps.probes || AI_SERVICE_PROBES
    const startedAt = now()
    const probeTimeout = Math.max(100, Math.min(options.probeTimeoutMs ?? 800, options.deadlineMs))
    const scope = ownSubnets(deps.interfaces)
    const skip = new Set([...(options.skipHosts || []), ...scope.own])
    const plan = scanHosts(scope, options.tailnetHosts || [], options.maxHosts)
    const hosts = plan.hosts.filter(host => !skip.has(host))
    const limiter = new ProbeLimiter(options.ratePerSec, options.concurrency, startedAt + options.deadlineMs, now, sleep)
    const ports = [...new Set(probes.map(probe => probe.defaultPort))]
    const services: DiscoveredAIService[] = []

    const probeHost = async (host: string): Promise<void> => {
        const answers = new Map<string, Promise<string | null | undefined>>()
        const get = (port: number, path: string) => {
            const url = `http://${host}:${port}${path}`
            if (!answers.has(url)) answers.set(url, limiter.run(() => httpGet(url, probeTimeout)))
            return answers.get(url)!
        }
        for (const port of ports) {
            if (limiter.expired()) return
            // The one gate, directly before every connection.
            if (!scanTargetAllowed(host, scope).allowed) return
            const open = await limiter.run(() => tcpProbe(host, port, probeTimeout))
            if (!open) continue
            for (const probe of probes.filter(item => item.defaultPort === port)) {
                if (!scanTargetAllowed(host, scope).allowed) return
                const body = await get(port, probe.healthEndpoint)
                if (typeof body !== 'string' || !probe.detectFn(body)) continue
                let models: string[] = []
                if (probe.parseModelsFn) {
                    const modelsPath = probe.modelsEndpoint || probe.healthEndpoint
                    const modelsBody = modelsPath === probe.healthEndpoint ? body : await get(port, modelsPath)
                    if (typeof modelsBody === 'string') models = probe.parseModelsFn(modelsBody)
                }
                services.push({
                    id: `${probe.name}@${host}:${port}`, name: probe.name, type: probe.type, provider: probe.name,
                    host, port, endpoint: `http://${host}:${port}`, models, status: 'running',
                    lastSeen: new Date(now()).toISOString(), sourceNode: host,
                    metadata: { source: OWN_NETWORK_SOURCE, datenklasse: 'lokal' },
                })
            }
        }
    }

    let index = 0
    const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, hosts.length)) }, async () => {
        while (index < hosts.length && !limiter.expired()) await probeHost(hosts[index++])
    })
    await Promise.all(workers)
    return {
        services,
        scannedHosts: Math.min(index, hosts.length),
        probes: limiter.started,
        rejected: plan.rejected,
        timedOut: limiter.expired() && index < hosts.length,
        durationMs: now() - startedAt,
    }
}

/** Own-network settings from `autonomy.sensing.discovery` (same switch and limits as device discovery). */
export function ownNetworkScanSettings(config: any, env: NodeJS.ProcessEnv = process.env): (OwnNetworkScanOptions & { enabled: true }) | { enabled: false } {
    // Test/acceptance runs (NOVA_NO_SIDE_EFFECTS=1) never scan a network.
    if (env.NOVA_NO_SIDE_EFFECTS === '1') return { enabled: false }
    const sensing = parseSensingConfig(config?.autonomy?.sensing)
    if (!sensing.enabled || !sensing.discovery.enabled) return { enabled: false }
    return {
        enabled: true,
        deadlineMs: sensing.discovery.deadlineSec * 1000,
        ratePerSec: sensing.discovery.ratePerSec,
        concurrency: sensing.discovery.concurrency,
        maxHosts: sensing.discovery.maxHosts,
        tailnetHosts: sensing.discovery.tailnetHosts,
    }
}

export function isOwnNetworkScanDue(lastAt: number, now = Date.now(), intervalMs = OWN_NETWORK_SCAN_INTERVAL_MS): boolean {
    return lastAt === 0 || now - lastAt >= intervalMs
}

/** A running SearXNG found on this machine or in the own network (localhost first). */
export function getDiscoveredSearxngUrl(services: readonly DiscoveredAIService[] = discoveredServices): string | null {
    const found = services.filter(service => service.name === 'searxng' && service.type === 'search' && service.status === 'running')
    const local = (service: DiscoveredAIService) => service.host === 'localhost' || service.host === '127.0.0.1' || service.sourceNode === 'local'
    const best = found.find(local) || found[0]
    return best ? best.endpoint : null
}

// ============================================
// Binary Scanner (installed but not running)
// ============================================

async function scanInstalledBinaries(): Promise<DiscoveredAIService[]> {
    const found: DiscoveredAIService[] = []

    for (const probe of AI_SERVICE_PROBES) {
        if (!probe.binaries || probe.binaries.length === 0) continue

        for (const binary of probe.binaries) {
            try {
                // The one program search (EnvScanner, 2.82.0) instead of an own which/where.
                const { locateProgram } = await import('../startup/environment-scanner.js')
                const stdout = locateProgram(binary) ?? ''

                if (stdout.trim()) {
                    // Check if it's already running (skip if we found it in port scan)
                    const alreadyRunning = discoveredServices.some(
                        s => s.name === probe.name && s.status === 'running' && s.sourceNode === 'local'
                    )
                    if (alreadyRunning) continue

                    found.push({
                        id: `${probe.name}@local:installed`,
                        name: probe.name,
                        type: probe.type,
                        provider: probe.name,
                        host: 'localhost',
                        port: probe.defaultPort,
                        endpoint: `http://localhost:${probe.defaultPort}`,
                        models: [],
                        status: 'installed',
                        lastSeen: new Date().toISOString(),
                        sourceNode: 'local',
                        metadata: { binaryPath: stdout.trim().split('\n')[0] },
                    })
                    break // Found the binary, no need to check other names
                }
            } catch {
                // Binary not found — that's fine
            }
        }
    }

    // Also check systemd services
    if (process.platform !== 'win32') {
        for (const probe of AI_SERVICE_PROBES) {
            if (!probe.systemdServices) continue
            for (const svc of probe.systemdServices) {
                try {
                    const { stdout } = await execAsync(
                        `systemctl is-enabled ${svc} 2>/dev/null || echo "not-found"`,
                        { timeout: 3000 }
                    )
                    const status = stdout.trim()
                    if (status === 'enabled' || status === 'disabled') {
                        const alreadyFound = found.some(s => s.name === probe.name) ||
                            discoveredServices.some(s => s.name === probe.name && s.sourceNode === 'local')
                        if (!alreadyFound) {
                            found.push({
                                id: `${probe.name}@local:systemd`,
                                name: probe.name,
                                type: probe.type,
                                provider: probe.name,
                                host: 'localhost',
                                port: probe.defaultPort,
                                endpoint: `http://localhost:${probe.defaultPort}`,
                                models: [],
                                status: status === 'enabled' ? 'stopped' : 'installed',
                                lastSeen: new Date().toISOString(),
                                sourceNode: 'local',
                                metadata: { systemdService: svc, systemdStatus: status },
                            })
                        }
                    }
                } catch { /* not found */ }
            }
        }
    }

    return found
}

// ============================================
// Mesh Node Scanner
// ============================================

async function scanMeshNodes(): Promise<DiscoveredAIService[]> {
    const found: DiscoveredAIService[] = []
    const scannedIPs = new Set<string>()

    try {
        // Source 1: Mesh registry nodes (registered via heartbeat)
        const { discoverNodes } = await import('./mesh-registry.js')
        const nodes = await discoverNodes()

        if (nodes && nodes.length > 0) {
            const scanPromises = nodes.map(async (node) => {
                const ip = node.ip
                if (!ip || ip === '127.0.0.1' || ip === 'localhost') return []
                scannedIPs.add(ip)

                const nodeLabel = node.hostname || node.node_id || ip
                console.log(`[AIScan] 🌐 Scanning mesh node: ${nodeLabel} (${ip})`)
                return scanHost(ip, nodeLabel, 5000)
            })

            const results = await Promise.allSettled(scanPromises)
            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    found.push(...result.value)
                }
            }
        }

        // Source 2: xaventra.config.json nodes (always available, even if edge daemons aren't running)
        try {
            const { readFileSync } = await import('node:fs')
            const { join } = await import('node:path')
            const configPath = resolveConfigPath()
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            const configNodes = config.nodes || []

            for (const cn of configNodes) {
                if ((cn as any).enabled === false) continue  // skip disabled placeholders

                // Extract IP from host field like "xaventra@100.64.0.21"
                const hostPart = cn.host?.split('@').pop() || ''
                const ip = hostPart.split(':')[0] // strip port if present
                if (!ip || ip === '127.0.0.1' || ip === 'localhost') continue

                const label = cn.name || ip

                // Port-scan this host (if not already scanned)
                let liveServices: DiscoveredAIService[] = []
                if (!scannedIPs.has(ip)) {
                    scannedIPs.add(ip)
                    console.log(`[AIScan] 🌐 Scanning config node: ${label} (${ip})`)
                    try {
                        liveServices = await scanHost(ip, label, 5000)
                        found.push(...liveServices)
                    } catch {
                        console.log(`[AIScan] ⚠️ Config node ${label} (${ip}) not reachable`)
                    }
                }

                // --- Fallback: inject config-defined ollamaModels when live scan found no models ---
                // This ensures the model-resolver can still route to known models even if
                // Tailscale is momentarily slow or the scan times out.
                const configModels: string[] = cn.ollamaModels || []
                if (configModels.length > 0) {
                    const ollamaSvcUrl = cn.services?.ollama as string | undefined
                    const ollamaHost = ollamaSvcUrl ? new URL(ollamaSvcUrl).hostname : ip
                    const ollamaPort = ollamaSvcUrl ? parseInt(new URL(ollamaSvcUrl).port) || 11434 : 11434
                    const ollamaEndpoint = `http://${ollamaHost}:${ollamaPort}`

                    const existingSvc = found.find(s => s.host === ollamaHost && s.port === ollamaPort && s.name === 'ollama')
                    if (existingSvc) {
                        // Live scan found it — merge any missing models from config
                        const missing = configModels.filter(m => !existingSvc.models.includes(m))
                        if (missing.length > 0) {
                            existingSvc.models = [...existingSvc.models, ...missing]
                            console.log(`[AIScan] 📦 ${label}: merged ${missing.length} config models into live scan`)
                        }
                    } else {
                        // Live scan missed this node — add it from config as best-effort
                        // Try to probe once more with a quick ping, mark status accordingly
                        const alive = await probeEndpoint(ollamaHost, ollamaPort, '/api/tags', 3000)
                        let liveModels = configModels  // start with config list
                        if (alive) {
                            try {
                                const data = JSON.parse(alive)
                                const probed = (data.models || []).map((m: { name: string }) => m.name).filter(Boolean)
                                if (probed.length > 0) liveModels = probed
                            } catch { /* keep config list */ }
                        }
                        found.push({
                            id: `ollama@${ollamaHost}:${ollamaPort}`,
                            name: 'ollama',
                            type: 'llm',
                            provider: 'ollama',
                            host: ollamaHost,
                            port: ollamaPort,
                            endpoint: ollamaEndpoint,
                            models: liveModels,
                            status: alive ? 'running' : 'stopped',
                            lastSeen: new Date().toISOString(),
                            sourceNode: label,
                            metadata: { source: alive ? 'probe' : 'config-fallback' },
                        })
                        console.log(`[AIScan] 📦 ${label}: ${alive ? 'live' : 'config-fallback'} — ${liveModels.length} models @ ${ollamaEndpoint}`)
                    }
                }

                // Also probe explicitly defined service URLs from config (non-ollama)
                if (cn.services && typeof cn.services === 'object') {
                    for (const [svcType, svcUrl] of Object.entries(cn.services)) {
                        if (typeof svcUrl !== 'string' || !svcUrl.startsWith('http')) continue
                        if (svcType === 'ollama') continue  // already handled above
                        try {
                            const url = new URL(svcUrl as string)
                            const svcHost = url.hostname
                            const svcPort = parseInt(url.port) || 80

                            // Already found this service via port scan?
                            const alreadyFound = found.some(s =>
                                s.host === svcHost && s.port === svcPort
                            )
                            if (alreadyFound) continue

                            // probe status defaults
                            let probeStatus: 'running' | 'stopped' = 'stopped'
                            
                            // vLLM: probe real models from API, fallback to config model
                            let models: string[] = []
                            
                            if (svcType === 'vllm' && cn.runtime === 'vllm') {
                                // Probe /v1/models for real model list
                                const modelsBody = await probeEndpoint(svcHost, svcPort, '/v1/models', 3000)
                                if (modelsBody) {
                                    try {
                                        const data = JSON.parse(modelsBody)
                                        const rawModels = (data.data || data.models || []) as Array<{ id?: string; name?: string; model_name?: string }>
                                        models = rawModels
                                            .map((m: any) => m.id || m.name || m.model_name)
                                            .filter(Boolean)
                                        if (models.length > 0) {
                                            console.log(`[AIScan] 📦 ${label}: vLLM real models from API: ${models.length} models`)
                                            probeStatus = 'running'
                                        }
                                    } catch { /* continue to config fallback */ }
                                }
                                
                                // Fallback: use config.model if API failed
                                if (models.length === 0 && cn.hardware?.model) {
                                    models = [cn.hardware.model]
                                    console.log(`[AIScan] 📦 ${label}: vLLM fallback model from config: ${cn.hardware.model}`)
                                }
                            }
                            
                            // Update status after vLLM probe
                            const serviceType = (['llm', 'tts', 'stt', 'vlm', 'embeddings'].includes(svcType) ? svcType : 'llm') as AIServiceType
                            
                            found.push({
                                id: `config:${svcType}@${label}:${svcPort}`,
                                name: cn.runtime || svcType,
                                type: serviceType,
                                provider: cn.runtime || svcType,
                                host: svcHost,
                                port: svcPort,
                                endpoint: svcUrl as string,
                                models,
                                status: probeStatus,
                                lastSeen: new Date().toISOString(),
                                sourceNode: label,
                                metadata: { source: 'config', configService: svcType },
                            })
                            console.log(`[AIScan] 🌐 Config service ${svcType} on ${label} — ${probeStatus} @ :${svcPort} (${models.length} models)`)
                        } catch { /* probe failed */ }
                    }
                }
            }
        } catch { /* no config or parse error */ }

    } catch (err) {
        console.log(`[AIScan] 🌐 Mesh scan error: ${err}`)
    }

    return found
}

// ============================================
// Phase 4: Remote "Schlafende Schätze" Discovery
// ============================================

type AISoftwareCategory = AIServiceType | 'framework' | 'runtime'

interface AIKeyword {
    pattern: string
    category: AISoftwareCategory
    label: string
}

const AI_KEYWORDS: AIKeyword[] = [
    // LLM
    { pattern: 'ollama', category: 'llm', label: 'Ollama' },
    { pattern: 'llama-cpp', category: 'llm', label: 'llama.cpp' },
    { pattern: 'llama-server', category: 'llm', label: 'llama.cpp Server' },
    { pattern: 'vllm', category: 'llm', label: 'vLLM' },
    { pattern: 'koboldcpp', category: 'llm', label: 'KoboldCPP' },
    { pattern: 'text-generation', category: 'llm', label: 'Text Generation' },
    { pattern: 'localai', category: 'llm', label: 'LocalAI' },
    { pattern: 'tabbyapi', category: 'llm', label: 'TabbyAPI' },
    { pattern: 'lm-studio', category: 'llm', label: 'LM Studio' },
    { pattern: 'exllamav2', category: 'llm', label: 'ExLlamaV2' },
    { pattern: 'mlx-lm', category: 'llm', label: 'MLX LM' },
    // TTS
    { pattern: 'chatterbox', category: 'tts', label: 'Chatterbox TTS' },
    { pattern: 'piper', category: 'tts', label: 'Piper TTS' },
    { pattern: 'piper-tts', category: 'tts', label: 'Piper TTS' },
    { pattern: 'coqui', category: 'tts', label: 'Coqui TTS' },
    { pattern: 'xtts', category: 'tts', label: 'Coqui XTTS' },
    { pattern: 'bark', category: 'tts', label: 'Bark TTS' },
    { pattern: 'tortoise-tts', category: 'tts', label: 'Tortoise TTS' },
    { pattern: 'f5-tts', category: 'tts', label: 'F5 TTS' },
    { pattern: 'styletts', category: 'tts', label: 'StyleTTS' },
    { pattern: 'vits', category: 'tts', label: 'VITS' },
    { pattern: 'nvidia-riva', category: 'tts', label: 'NVIDIA Riva' },
    { pattern: 'espeak', category: 'tts', label: 'eSpeak' },
    { pattern: 'festival', category: 'tts', label: 'Festival TTS' },
    // STT
    { pattern: 'whisper', category: 'stt', label: 'Whisper' },
    { pattern: 'faster-whisper', category: 'stt', label: 'Faster Whisper' },
    { pattern: 'whisper.cpp', category: 'stt', label: 'Whisper.cpp' },
    { pattern: 'whispercpp', category: 'stt', label: 'Whisper.cpp' },
    { pattern: 'vosk', category: 'stt', label: 'Vosk' },
    { pattern: 'speechrecognition', category: 'stt', label: 'SpeechRecognition' },
    { pattern: 'nemo', category: 'stt', label: 'NVIDIA NeMo' },
    // Vision
    { pattern: 'yolo', category: 'vlm', label: 'YOLO' },
    { pattern: 'ultralytics', category: 'vlm', label: 'Ultralytics YOLO' },
    { pattern: 'deepstream', category: 'vlm', label: 'DeepStream' },
    { pattern: 'moondream', category: 'vlm', label: 'Moondream' },
    { pattern: 'llava', category: 'vlm', label: 'LLaVA' },
    { pattern: 'opencv', category: 'vlm', label: 'OpenCV' },
    { pattern: 'detectron', category: 'vlm', label: 'Detectron2' },
    { pattern: 'comfyui', category: 'vlm', label: 'ComfyUI' },
    { pattern: 'stable-diffusion', category: 'vlm', label: 'Stable Diffusion' },
    // Embeddings
    { pattern: 'sentence-transformers', category: 'embeddings', label: 'Sentence Transformers' },
    { pattern: 'nomic', category: 'embeddings', label: 'Nomic Embed' },
    { pattern: 'fastembed', category: 'embeddings', label: 'FastEmbed' },
    { pattern: 'chromadb', category: 'embeddings', label: 'ChromaDB' },
    { pattern: 'qdrant', category: 'embeddings', label: 'Qdrant' },
    { pattern: 'weaviate', category: 'embeddings', label: 'Weaviate' },
    { pattern: 'milvus', category: 'embeddings', label: 'Milvus' },
    // Frameworks & Runtimes
    { pattern: 'torch', category: 'framework', label: 'PyTorch' },
    { pattern: 'pytorch', category: 'framework', label: 'PyTorch' },
    { pattern: 'tensorflow', category: 'framework', label: 'TensorFlow' },
    { pattern: 'tensorrt', category: 'framework', label: 'TensorRT' },
    { pattern: 'tritonserver', category: 'framework', label: 'Triton Server' },
    { pattern: 'cuda-toolkit', category: 'runtime', label: 'CUDA Toolkit' },
    { pattern: 'cudnn', category: 'runtime', label: 'cuDNN' },
    { pattern: 'jetpack', category: 'runtime', label: 'JetPack' },
    { pattern: 'transformers', category: 'framework', label: 'Hugging Face Transformers' },
    { pattern: 'huggingface', category: 'framework', label: 'Hugging Face Hub' },
    { pattern: 'accelerate', category: 'framework', label: 'HF Accelerate' },
    { pattern: 'onnxruntime', category: 'framework', label: 'ONNX Runtime' },
    { pattern: 'openvino', category: 'framework', label: 'OpenVINO' },
]

export interface SleepingSoftware {
    name: string
    category: AISoftwareCategory
    label: string
    source: 'apt' | 'pip' | 'docker' | 'binary' | 'systemd' | 'snap'
    version?: string
    node: string
}

async function scanRemoteAISoftware(
    host: string,
    user: string,
    nodeLabel: string
): Promise<SleepingSoftware[]> {
    const found: SleepingSoftware[] = []
    const seenLabels = new Set<string>()

    try {
        // Single SSH call — get ALL software inventory
        // NOTE: No single-quotes around echo markers — cmd.exe on Windows passes them literally
        const remoteCommand = `echo ===APT===; dpkg --get-selections 2>/dev/null; ` +
            `echo ===PIP===; pip3 list --format=freeze 2>/dev/null; ` +
            `echo ===DOCKER===; docker images 2>/dev/null; ` +
            `echo ===SYSTEMD===; systemctl list-unit-files --state=enabled --no-pager 2>/dev/null; ` +
            `echo ===SNAP===; snap list 2>/dev/null; ` +
            `echo ===END===`

        // The one SSH runner (mesh/node-ssh.ts, 2.82.0): an unreachable node L21 already
        // found is skipped; the full inventory runs at most every 30 min anyway.
        const { sshNodeRun } = await import('./node-ssh.js')
        const outcome = await sshNodeRun(`${user}@${host}`, remoteCommand, { timeoutMs: 30000, maxBuffer: 5 * 1024 * 1024, connectTimeoutS: 5, cacheMs: 25 * 60_000 })
        if (!outcome.ok) throw new Error(outcome.error)
        const stdout = outcome.stdout

        // Parse sections — robust against quoting artifacts
        const sections: Record<string, string> = {}
        let currentSection = ''
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim().replace(/['"]/g, '') // strip any quote artifacts
            const sectionMatch = trimmed.match(/^===(\w+)===$/)
            if (sectionMatch) {
                currentSection = sectionMatch[1]
                sections[currentSection] = ''
            } else if (currentSection && currentSection !== 'END') {
                sections[currentSection] += trimmed.toLowerCase() + '\n'
            }
        }

        // Match each section against AI keywords
        const matchSection = (sectionKey: string, source: SleepingSoftware['source']): void => {
            const content = sections[sectionKey]
            if (!content) return

            for (const kw of AI_KEYWORDS) {
                if (seenLabels.has(kw.label)) continue
                const pattern = kw.pattern.toLowerCase()

                // Check each line for the keyword
                for (const line of content.split('\n')) {
                    if (!line) continue
                    if (line.includes(pattern)) {
                        seenLabels.add(kw.label)

                        // Try to extract version
                        let version: string | undefined
                        const vMatch = line.match(/==([0-9][0-9.]+)/) // pip format
                            || line.match(/\s([0-9][0-9.]+)/) // general
                        if (vMatch) version = vMatch[1]

                        found.push({
                            name: kw.pattern,
                            category: kw.category,
                            label: kw.label,
                            source,
                            version,
                            node: nodeLabel,
                        })
                        break
                    }
                }
            }
        }

        matchSection('APT', 'apt')
        matchSection('PIP', 'pip')
        matchSection('DOCKER', 'docker')
        matchSection('SYSTEMD', 'systemd')
        matchSection('SNAP', 'snap')

    } catch (err) {
        console.log(`[AIScan] 💤 Remote scan failed for ${nodeLabel}: ${String(err).slice(0, 100)}`)
    }

    return found
}

// Convert sleeping software to DiscoveredAIService for unified display
function sleepingToService(sw: SleepingSoftware): DiscoveredAIService | null {
    // Skip frameworks/runtimes — they're not services
    if (sw.category === 'framework' || sw.category === 'runtime') return null

    return {
        id: `sleeping:${sw.name}@${sw.node}`,
        name: sw.label,
        type: sw.category as AIServiceType,
        provider: sw.name,
        host: sw.node,
        port: 0,
        endpoint: '',
        models: [],
        status: 'installed',
        lastSeen: new Date().toISOString(),
        sourceNode: sw.node,
        metadata: { source: sw.source, version: sw.version },
    }
}

// ============================================
// Mesh advertisements (AIScan phase 4)
// ============================================

/** What mesh nodes say they run. This is the node's own advertisement, not a
 * probe by this node. */
export function servicesFromMeshAdvertisements(nodes: Array<Pick<MeshNode, 'node_id' | 'hostname' | 'last_heartbeat' | 'capabilities' | 'software'>>): DiscoveredAIService[] {
    const found: DiscoveredAIService[] = []
    for (const node of nodes) {
        const nodeLabel = node.hostname || node.node_id
        for (const advertised of node.software?.ai_services || []) {
            try {
                const endpointUrl = new URL(advertised.endpoint)
                found.push({
                    id: `${advertised.name}@${node.node_id}:${endpointUrl.port}`,
                    name: advertised.name,
                    type: advertised.type as AIServiceType,
                    provider: advertised.name,
                    host: endpointUrl.hostname,
                    port: Number(endpointUrl.port),
                    endpoint: advertised.endpoint,
                    models: advertised.models || [],
                    status: advertised.status,
                    lastSeen: node.last_heartbeat,
                    sourceNode: nodeLabel,
                    capabilities: node.capabilities,
                    // Hotfix 2.80.1: bound to the advertising node, never probe evidence.
                    metadata: { source: 'mesh-advertised', nodeId: node.node_id },
                })
            } catch { /* malformed endpoint */ }
        }
    }
    return found
}

// ============================================
// Full Scan
// ============================================

export interface AIScanOptions {
    skipMesh?: boolean
    skipBinaryCheck?: boolean
    forceFresh?: boolean
    skipRemoteSSH?: boolean
    preserveRemoteEvidence?: boolean
    /** 2.85: also scan the own LAN/Tailnet (net-scope rules). */
    ownNetwork?: boolean
    /** 2.85: print the scan lines only when the found services changed. */
    logOnlyOnChange?: boolean
    /** Tests only: replaces the own-network scan. */
    ownNetworkScan?: (options: OwnNetworkScanOptions) => Promise<OwnNetworkScanReport>
}

let lastOwnNetworkScanAt = 0
let lastLoggedSignature = ''

/** What counts as a change for the log: service, status and models. */
export function servicesSignature(services: readonly DiscoveredAIService[]): string {
    return services.map(service => `${service.id}|${service.status}|${[...service.models].sort().join(',')}`).sort().join('\n')
}

function currentConfig(): any {
    const live = (globalThis as any).__novaState?.config
    if (live && typeof live === 'object') return live
    try {
        const path = resolveConfigPath()
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {}
    } catch { return {} }
}

async function performAIScan(options?: AIScanOptions): Promise<AIScanResult> {
    const startTime = Date.now()
    const previous = lastScanResult
    // 2.85: the periodic refresh logs only when the found services changed.
    const buffered: string[] = []
    const log = (line: string): void => { if (options?.logOnlyOnChange) buffered.push(line); else console.log(line) }
    log('[AIScan] 🔍 Starting AI service scan...')

    const allServices: DiscoveredAIService[] = []

    // Phase 1: Localhost port scan
    log('[AIScan] 📡 Phase 1: Scanning localhost ports...')
    const localServices = await scanHost('localhost')
    allServices.push(...localServices)
    if (localServices.length > 0) {
        log(`[AIScan] ✅ Found ${localServices.length} local services:`)
        for (const s of localServices) {
            log(`[AIScan]    ${s.type.toUpperCase()} ${s.name} — ${s.models.length} models @ :${s.port}`)
        }
    } else {
        log('[AIScan] ⚠️  No running AI services on localhost')
    }

    // Phase 2: Binary/systemd scan
    if (!options?.skipBinaryCheck) {
        log('[AIScan] 📦 Phase 2: Checking installed binaries...')
        // Update discoveredServices with running ones first
        discoveredServices = [...allServices]
        const installed = await scanInstalledBinaries()
        allServices.push(...installed)
        if (installed.length > 0) {
            log(`[AIScan] 📦 Found ${installed.length} installed (not running):`)
            for (const s of installed) {
                log(`[AIScan]    ${s.type.toUpperCase()} ${s.name} — ${s.status}`)
            }
        }
    }

    // Phase 3: Mesh node scan
    if (!options?.skipMesh && !options?.skipRemoteSSH) {
        log('[AIScan] 🌐 Phase 3: Scanning mesh nodes...')
        const meshServices = await scanMeshNodes()
        allServices.push(...meshServices)
        if (meshServices.length > 0) {
            const liveMeshServices = meshServices.filter(service => service.status === 'running')
            const registeredMeshServices = meshServices.filter(service => service.status !== 'running')
            log(`[AIScan] 🌐 Mesh inventory: ${liveMeshServices.length} live, ${registeredMeshServices.length} registered/offline:`)
            for (const s of meshServices) {
                const state = s.status === 'running' ? 'LIVE' : 'OFFLINE/CACHED'
                log(`[AIScan]    ${state} ${s.type.toUpperCase()} ${s.name} on ${s.sourceNode} — ${s.models.length} models`)
            }
        }
    }

    // Phase 4: "Schlafende Schätze" — read installed AI software from mesh node registrations (via Supabase)
    let allSleeping: SleepingSoftware[] = []
    if (!options?.skipMesh) {
        log('[AIScan] 💤 Phase 4: Reading installed AI software from mesh node data...')
        try {
            const { discoverNodes } = await import('./mesh-registry.js')
            const nodes = await discoverNodes()

            for (const node of nodes) {
                const sw = node.software
                if (!sw) continue

                const nodeLabel = node.hostname || node.node_id
                for (const discovered of servicesFromMeshAdvertisements([node])) {
                    const duplicate = allServices.some(service => service.endpoint === discovered.endpoint && service.name === discovered.name)
                    if (!duplicate) allServices.push(discovered)
                }

                if (!sw.pip_packages?.length) continue
                log(`[AIScan] 💤 ${nodeLabel}: ${sw.pip_packages.length} AI packages registered`)

                for (const pkg of sw.pip_packages) {
                    const pkgLower = pkg.toLowerCase()
                    // Match against AI keywords to categorize
                    const matched = AI_KEYWORDS.find(kw => pkgLower.includes(kw.pattern))
                    if (matched) {
                        const sleeping: SleepingSoftware = {
                            name: pkg,
                            category: matched.category,
                            label: matched.label,
                            source: 'pip',
                            node: nodeLabel,
                        }
                        allSleeping.push(sleeping)

                        // Convert to DiscoveredAIService if it's a usable service type
                        const svc = sleepingToService(sleeping)
                        if (svc) {
                            const isRunning = allServices.some(s =>
                                s.sourceNode === nodeLabel &&
                                s.name.toLowerCase().includes(matched.pattern)
                            )
                            if (!isRunning) allServices.push(svc)
                        }
                    }
                }

                // Also add capabilities from node registration
                if (node.capabilities) {
                    for (const cap of node.capabilities) {
                        if (['stt', 'tts', 'vision', 'ml-inference', 'inference-runtime'].includes(cap)) {
                            log(`[AIScan] 💤 ${nodeLabel} has capability: ${cap}`)
                        }
                    }
                }

                // Add apt/docker/systemd info from node software
                if (sw.docker) {
                    allSleeping.push({ name: 'docker', category: 'runtime', label: `Docker ${sw.docker}`, source: 'apt', node: nodeLabel })
                }
                if (sw.cuda) {
                    allSleeping.push({ name: 'cuda', category: 'runtime', label: `CUDA ${sw.cuda}`, source: 'apt', node: nodeLabel })
                }
                if (sw.ollama) {
                    allSleeping.push({ name: 'ollama', category: 'llm', label: `Ollama ${sw.ollama}`, source: 'binary', node: nodeLabel })
                }
            }

            if (allSleeping.length > 0) {
                log(`[AIScan] 💤 Total sleeping: ${allSleeping.length} AI packages across mesh`)
            }
        } catch (err) {
            log(`[AIScan] 💤 Phase 4 error: ${String(err).slice(0, 300)}`)
        }
    }

    // Phase 5: SSH-based remote software discovery (for devices WITHOUT Nova daemon)
    if (!options?.skipMesh) {
        log('[AIScan] 🔑 Phase 5: SSH scanning remote devices for installed AI software...')
        const sshScannedIPs = new Set<string>()
        const sshTargets: Array<{ ip: string; user: string; label: string }> = []

        // Collect SSH targets ONLY from xaventra.config.json — explicitly configured nodes.
        // Mesh-registry discovery is skipped here: auto-discovered mDNS (.local) hosts
        // have unknown SSH users and cause noise. Only scan nodes with explicit user@host.
        try {
            const configPath = resolveConfigPath()
            const config = JSON.parse(readFileSync(configPath, 'utf-8'))
            for (const cn of (config.nodes || [])) {
                const hostField = cn.host || ''
                const parts = hostField.split('@')

                // Require explicit user in host field (user@host) — skip if no '@'
                if (parts.length < 2) continue

                const user = parts[0]
                const rawHost = parts[1].split(':')[0]

                // Prefer tailscaleIp if available (more reliable), fall back to host IP
                const ip = cn.tailscaleIp || rawHost

                // Skip localhost/Windows host — can't SSH into self
                if (!ip || ip === '127.0.0.1' || ip === 'localhost' || rawHost === 'localhost') continue
                // Skip already-scanned IPs
                if (sshScannedIPs.has(ip)) continue

                sshScannedIPs.add(ip)
                sshTargets.push({ ip, user, label: cn.name || ip })
            }
        } catch { /* no config */ }

        // SSH scan each target (parallel, with timeout)
        if (sshTargets.length > 0) {
            const sshResults = await Promise.allSettled(
                sshTargets.map(async ({ ip, user, label }) => {
                    log(`[AIScan] 🔑 SSH scanning: ${label} (${user}@${ip})`)
                    const remoteSoftware = await scanRemoteAISoftware(ip, user, label)
                    return { label, software: remoteSoftware }
                })
            )

            for (const result of sshResults) {
                if (result.status === 'fulfilled' && result.value.software.length > 0) {
                    const { label, software } = result.value
                    log(`[AIScan] 🔑 ${label}: ${software.length} AI packages via SSH`)
                    allSleeping.push(...software)

                    // Convert to services
                    for (const sw of software) {
                        const svc = sleepingToService(sw)
                        if (svc) {
                            const alreadyFound = allServices.some(s =>
                                s.sourceNode === label && s.name.toLowerCase().includes(sw.name.toLowerCase())
                            )
                            if (!alreadyFound) allServices.push(svc)
                        }
                    }
                }
            }
        }
    }

    // Lightweight local refreshes keep recent remote evidence until the next
    // full inventory pass instead of replacing the graph with a partial scan.
    if (options?.preserveRemoteEvidence && previous) {
        const retained = previous.services.filter(service =>
            service.sourceNode !== 'local'
            && service.host !== 'localhost'
            && service.host !== '127.0.0.1'
            && Date.now() - Date.parse(service.lastSeen) < DEFAULT_FULL_SCAN_INTERVAL_MS * 2)
        for (const service of retained) {
            if (!allServices.some(current => current.id === service.id || (current.endpoint === service.endpoint && current.name === service.name))) {
                allServices.push(service)
            }
        }
        if (!allSleeping.length && previous.sleepingSoftware?.length) allSleeping = [...previous.sleepingSoftware]
    }

    // Phase 6 (2.85 Paket C): own LAN/Tailnet, net-scope rules, hourly.
    const ownNetwork = options?.ownNetwork ? ownNetworkScanSettings(currentConfig()) : { enabled: false as const }
    if (ownNetwork.enabled) {
        log('[AIScan] 🏠 Phase 6: Scanning own network (private subnets, rate-limited)...')
        try {
            const covered = allServices.filter(service => service.metadata?.source !== OWN_NETWORK_SOURCE).map(service => service.host)
            const report = await (options?.ownNetworkScan || scanOwnNetworkAIServices)({ ...ownNetwork, skipHosts: covered })
            for (const service of report.services) {
                if (!allServices.some(current => current.id === service.id)) allServices.push(service)
            }
            log(`[AIScan] 🏠 Own network: ${report.services.length} services on ${report.scannedHosts} hosts (${report.probes} probes${report.timedOut ? ', time limit reached' : ''})`)
        } catch (err) {
            log(`[AIScan] 🏠 Own network scan failed: ${String(err).slice(0, 200)}`)
        }
    } else if (previous) {
        // Between the hourly passes, keep what the last own-network pass found.
        for (const service of previous.services) {
            if (service.metadata?.source !== OWN_NETWORK_SOURCE) continue
            if (Date.now() - Date.parse(service.lastSeen) >= OWN_NETWORK_SCAN_INTERVAL_MS * 2) continue
            if (!allServices.some(current => current.id === service.id)) allServices.push(service)
        }
    }

    // Update global registry
    discoveredServices = allServices

    const result: AIScanResult = {
        lastScan: new Date().toISOString(),
        scanDurationMs: Date.now() - startTime,
        services: allServices,
        sleepingSoftware: allSleeping.length > 0 ? allSleeping : undefined,
    }
    lastScanResult = result

    // Every node advertises its own live/installed AI stack. The main node can
    // then build a provider pool without SSH-scanning that node again.
    try {
        const { updateLocalAIServices } = await import('./mesh-registry.js')
        const localServices = allServices
            .filter(service => service.sourceNode === 'local' || service.host === 'localhost' || service.host === '127.0.0.1')
            .map(service => ({
                name: service.name,
                type: service.type,
                endpoint: service.endpoint,
                status: service.status,
                models: service.models,
            }))
        await updateLocalAIServices(localServices)
    } catch { /* mesh registry is optional */ }

    // The scanner remains the discovery authority. The persistent graph only
    // normalizes its verified findings together with mesh heartbeats.
    try {
        const [{ getCapabilityGraph }, { discoverNodes, getLocalNodeId }] = await Promise.all([
            import('./capability-graph.js'),
            import('./mesh-registry.js'),
        ])
        // The main node has no NOVA_NODE_ID: its id comes from the registry, otherwise its own
        // vLLM/whisper end up on a nameless "local" node that the projection drops.
        getCapabilityGraph().ingest(result, await discoverNodes(), process.env.NOVA_NODE_ID?.trim() || getLocalNodeId())
        const { syncCapabilityGraphOnce } = await import('./capability-graph-sync.js')
        await syncCapabilityGraphOnce()
    } catch { /* capability graph is best-effort during bootstrap */ }

    // Persist to disk
    try {
        const dir = join(process.cwd(), '.nova-data')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(
            join(process.cwd(), SCAN_RESULTS_FILE),
            JSON.stringify(result, null, 2)
        )
    } catch { /* non-critical */ }

    const summary = {
        running: allServices.filter(s => s.status === 'running').length,
        installed: allServices.filter(s => s.status !== 'running').length,
        llm: allServices.filter(s => s.type === 'llm').length,
        tts: allServices.filter(s => s.type === 'tts').length,
        stt: allServices.filter(s => s.type === 'stt').length,
        embeddings: allServices.filter(s => s.type === 'embeddings').length,
    }
    log(`[AIScan] ✅ Scan complete in ${result.scanDurationMs}ms — ${summary.running} running, ${summary.installed} installed (LLM:${summary.llm} TTS:${summary.tts} STT:${summary.stt} EMB:${summary.embeddings})`)
    if (!options?.skipMesh && !options?.skipRemoteSSH) lastFullScanAt = Date.now()
    if (ownNetwork.enabled) lastOwnNetworkScanAt = Date.now()

    const signature = servicesSignature(allServices)
    if (options?.logOnlyOnChange && signature !== lastLoggedSignature) {
        for (const line of buffered) console.log(line)
    }
    lastLoggedSignature = signature

    return result
}

/** One shared scan per process. Boot consumers reuse a recent result instead
 * of probing the same offline SSH nodes several times in parallel. */
export async function scanAllAIServices(options?: AIScanOptions): Promise<AIScanResult> {
    const ageMs = lastScanResult
        ? Date.now() - new Date(lastScanResult.lastScan).getTime()
        : Number.POSITIVE_INFINITY
    if (!options?.forceFresh && lastScanResult && ageMs < 2 * 60_000) {
        console.log(`[AIScan] Reusing ${Math.round(ageMs / 1000)}s old scan result`)
        return lastScanResult
    }
    if (scanInFlight) {
        console.log('[AIScan] Joining scan already in progress')
        return scanInFlight
    }
    scanInFlight = performAIScan(options)
    try {
        return await scanInFlight
    } finally {
        scanInFlight = null
    }
}

// ============================================
// Periodic Scanner
// ============================================

export function startPeriodicScan(
    intervalMs = DEFAULT_SCAN_INTERVAL_MS,
    fullIntervalMs = DEFAULT_FULL_SCAN_INTERVAL_MS,
): void {
    if (scanInterval) clearInterval(scanInterval)

    console.log(`[AIScan] ⏱️  Local refresh every ${Math.round(intervalMs / 60000)}min; full mesh inventory every ${Math.round(fullIntervalMs / 60000)}min`)

    // 2.85 Paket C: the own LAN/Tailnet once shortly after start, then hourly.
    if (firstOwnNetworkTimer) clearTimeout(firstOwnNetworkTimer)
    firstOwnNetworkTimer = setTimeout(() => {
        void scanAllAIServices({ skipMesh: true, skipBinaryCheck: true, skipRemoteSSH: true, preserveRemoteEvidence: true, forceFresh: true, ownNetwork: true, logOnlyOnChange: true })
            .then(() => syncToAvailableLLMs()).catch(err => console.log(`[AIScan] ⚠️  Own network scan failed: ${err}`))
    }, OWN_NETWORK_FIRST_RUN_DELAY_MS)
    firstOwnNetworkTimer.unref?.()

    scanInterval = setInterval(async () => {
        try {
            const fullScanDue = isFullInventoryDue(lastFullScanAt, Date.now(), fullIntervalMs)
            await scanAllAIServices({
                skipMesh: !fullScanDue,
                skipBinaryCheck: !fullScanDue,
                skipRemoteSSH: !fullScanDue,
                preserveRemoteEvidence: !fullScanDue,
                forceFresh: true,
                ownNetwork: isOwnNetworkScanDue(lastOwnNetworkScanAt),
                logOnlyOnChange: true,
            })

            // Integrate discovered local LLMs into availableLLMs
            await syncToAvailableLLMs()
        } catch (err) {
            console.log(`[AIScan] ⚠️  Periodic scan failed: ${err}`)
        }
    }, intervalMs)

    // Don't prevent Node.js from exiting
    if (scanInterval.unref) scanInterval.unref()
}

export function stopPeriodicScan(): void {
    if (firstOwnNetworkTimer) { clearTimeout(firstOwnNetworkTimer); firstOwnNetworkTimer = null }
    if (scanInterval) {
        clearInterval(scanInterval)
        scanInterval = null
    }
}

// ============================================
// Sync discovered services to availableLLMs
// ============================================

function isAutoModelConfig(): boolean {
    try {
        const configPath = resolveConfigPath()
        if (!existsSync(configPath)) return true
        const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { model?: string; autoModel?: boolean }
        return config.autoModel === true || !config.model || config.model === 'auto'
    } catch {
        return true
    }
}

function isChatModel(model: string): boolean {
    return !/embed|nomic|bge|mxbai|e5-|gte-|instructor/i.test(model)
}

function scoreMeshModel(model: string, sourceNode?: string): number {
    const name = model.toLowerCase()
    let score = 0
    const sizeMatch = name.match(/(\d+(?:\.\d+)?)\s*b/)
    if (sizeMatch) score += Number(sizeMatch[1]) * 10
    if (name.includes('qwen')) score += 80
    if (name.includes('llama')) score += 70
    if (name.includes('mistral') || name.includes('mixtral')) score += 65
    if (name.includes('gemma')) score += 45
    if (name.includes('coder') || name.includes('code')) score += 10
    if (name.includes('voice')) score -= 20
    if (name.includes('cloud')) score -= 200
    if (sourceNode === 'local') score += 5
    return score
}

async function maybeSwitchToBestMeshModel(): Promise<void> {
    if (!isAutoModelConfig()) return

    const state = (globalThis as any).__novaState
    if (!state?.llm?.switchModel) return

    const candidates: Array<{ model: string; endpoint?: string; sourceNode?: string }> = []
    for (const service of discoveredServices) {
        if (service.type !== 'llm' || service.status !== 'running') continue
        for (const model of service.models) {
            if (isChatModel(model)) candidates.push({ model, endpoint: service.endpoint, sourceNode: service.sourceNode })
        }
    }

    const best = candidates.sort((a, b) =>
        scoreMeshModel(b.model, b.sourceNode) - scoreMeshModel(a.model, a.sourceNode)
    )[0]
    if (!best || best.model === state.llm.modelId) return

    const currentScore = scoreMeshModel(String(state.llm.modelId || ''), 'current')
    const bestScore = scoreMeshModel(best.model, best.sourceNode)
    if (bestScore <= currentScore) return

    const previous = state.llm.modelId
    const switched = await state.llm.switchModel(best.model, 'local')
    if (switched) {
        console.log(`[AIScan] Auto mesh switch: ${previous} -> ${best.model} (${best.sourceNode ?? best.endpoint ?? 'mesh'})`)
    }
}

async function syncToAvailableLLMs(): Promise<void> {
    try {
        const { availableLLMs } = await import('../core/llm-factory.js')
        const { sameEndpoint } = await import('../llm/local-llm.js')

        for (const service of discoveredServices) {
            if (service.type !== 'llm' || service.status !== 'running') continue

            for (const model of service.models) {
                // Check if already registered — localhost and this machine's own
                // (tailnet) address are the same server (2.82.0).
                const exists = availableLLMs.some(
                    (l: { model: string; provider: string; endpoint?: string }) =>
                        l.model === model && !!l.endpoint && sameEndpoint(l.endpoint, service.endpoint)
                )
                if (!exists) {
                    availableLLMs.push({
                        provider: 'local',
                        model,
                        local: true,
                        endpoint: service.endpoint,
                        nodeName: service.sourceNode,
                    })
                    console.log(`[AIScan] ➕ Registered: ${service.provider}/${model} (${service.sourceNode})`)
                }
            }
        }

        await maybeSwitchToBestMeshModel()
    } catch (err) {
        console.log(`[AIScan] Sync to availableLLMs failed: ${err}`)
    }
}

// ============================================
// Accessors
// ============================================

export function getDiscoveredServices(): DiscoveredAIService[] {
    return [...discoveredServices]
}

export function getServicesByType(type: AIServiceType): DiscoveredAIService[] {
    return discoveredServices.filter(s => s.type === type)
}

export function getRunningServices(): DiscoveredAIService[] {
    return discoveredServices.filter(s => s.status === 'running')
}

export function getInstalledServices(): DiscoveredAIService[] {
    return discoveredServices.filter(s => s.status === 'installed' || s.status === 'stopped')
}

export function getLastScanResult(): AIScanResult | null {
    return lastScanResult
}

/** Get a formatted status string for display */
export function getAIStatusReport(): string {
    if (!lastScanResult || lastScanResult.services.length === 0) {
        return '🔍 Kein AI-Scan durchgeführt oder keine Services gefunden.'
    }

    const lines: string[] = ['🤖 **AI Services im Netzwerk**\n']

    const byNode = new Map<string, DiscoveredAIService[]>()
    for (const s of lastScanResult.services) {
        const node = s.sourceNode || 'unknown'
        if (!byNode.has(node)) byNode.set(node, [])
        byNode.get(node)!.push(s)
    }

    for (const [node, services] of byNode) {
        const icon = node === 'local' ? '🖥️' : '🌐'
        lines.push(`${icon} **${node}**`)

        for (const s of services) {
            const statusIcon = s.status === 'running' ? '🟢' : s.status === 'stopped' ? '🟡' : '⚪'
            const modelCount = s.models.length > 0 ? ` (${s.models.length} models)` : ''
            lines.push(`  ${statusIcon} ${s.type.toUpperCase()} **${s.name}** :${s.port}${modelCount}`)
            if (s.models.length > 0 && s.models.length <= 5) {
                for (const m of s.models) {
                    lines.push(`    • ${m}`)
                }
            } else if (s.models.length > 5) {
                for (const m of s.models.slice(0, 3)) {
                    lines.push(`    • ${m}`)
                }
                lines.push(`    • ... +${s.models.length - 3} more`)
            }
        }
        lines.push('')
    }

    lines.push(`⏱️ Letzter Scan: ${lastScanResult.lastScan} (${lastScanResult.scanDurationMs}ms)`)
    return lines.join('\n')
}

// ============================================
// Custom Probe Registration
// ============================================

export function registerProbe(probe: AIServiceProbe): void {
    // Replace if same name exists
    const idx = AI_SERVICE_PROBES.findIndex(p => p.name === probe.name)
    if (idx >= 0) {
        AI_SERVICE_PROBES[idx] = probe
    } else {
        AI_SERVICE_PROBES.push(probe)
    }
    console.log(`[AIScan] 📋 Registered probe: ${probe.name} (${probe.type})`)
}

export default {
    scanAllAIServices,
    startPeriodicScan,
    stopPeriodicScan,
    getDiscoveredServices,
    getServicesByType,
    getRunningServices,
    getInstalledServices,
    getLastScanResult,
    getAIStatusReport,
    registerProbe,
    AI_SERVICE_PROBES,
}
