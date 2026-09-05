import { hostname, platform, arch, totalmem, cpus, networkInterfaces } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AIScanResult, DiscoveredAIService, SleepingSoftware } from './ai-scanner.js'
import { resolveConfigPath } from '../config/config-path.js'


interface ConfigNode {
    name?: string
    host?: string
    services?: Record<string, string>
    ollamaModels?: string[]
    enabled?: boolean
}

interface PlannedNode {
    label: string
    host?: string
    source: 'local' | 'config' | 'scan'
    running: DiscoveredAIService[]
    installed: DiscoveredAIService[]
    sleeping: SleepingSoftware[]
    role: string
    strengths: string[]
    gaps: string[]
    actions: string[]
}

function localIps(): string[] {
    return Object.values(networkInterfaces())
        .flat()
        .filter((iface): iface is NonNullable<typeof iface> => !!iface && iface.family === 'IPv4' && !iface.internal)
        .map(iface => iface.address)
}

function loadConfigNodes(): ConfigNode[] {
    try {
        const cfgPath = resolveConfigPath()
        if (!existsSync(cfgPath)) return []
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { nodes?: ConfigNode[] }
        return (cfg.nodes || []).filter(node => node.enabled !== false)
    } catch {
        return []
    }
}

function parseHost(host?: string): string | undefined {
    if (!host) return undefined
    const withoutUser = host.includes('@') ? host.split('@').slice(1).join('@') : host
    return withoutUser.split(':')[0]
}

function serviceNodeLabel(service: DiscoveredAIService): string {
    if (service.sourceNode) return service.sourceNode
    if (service.host === 'localhost' || service.host === '127.0.0.1') return hostname()
    return service.host
}

function hasService(node: PlannedNode, type: string, name?: string): boolean {
    return node.running.some(s =>
        s.type === type && (!name || s.name.toLowerCase().includes(name.toLowerCase()))
    )
}

function hasInstalled(node: PlannedNode, type: string, name?: string): boolean {
    return node.installed.some(s =>
        s.type === type && (!name || s.name.toLowerCase().includes(name.toLowerCase()))
    ) || node.sleeping.some(s =>
        s.category === type && (!name || s.name.toLowerCase().includes(name.toLowerCase()) || s.label.toLowerCase().includes(name.toLowerCase()))
    )
}

function bestModels(node: PlannedNode): string[] {
    return node.running
        .filter(s => s.type === 'llm')
        .flatMap(s => s.models)
        .filter(m => !/embed|nomic|bge|mxbai|e5-|gte-|instructor/i.test(m))
        .slice(0, 5)
}

function inferRole(node: PlannedNode): void {
    const models = bestModels(node).join(' ').toLowerCase()
    const hasLlm = hasService(node, 'llm')
    const hasTts = hasService(node, 'tts') || hasInstalled(node, 'tts')
    const hasStt = hasService(node, 'stt') || hasInstalled(node, 'stt')
    const hasCuda = node.sleeping.some(s => /cuda|tensorrt|nvidia/i.test(`${s.name} ${s.label}`))

    if (node.source === 'local') {
        node.role = hasLlm ? 'Main + Desktop LLM fallback' : 'Main Orchestrator'
    } else if (hasCuda) {
        node.role = hasLlm ? 'GPU LLM Worker' : 'GPU Worker bereitmachen'
    } else if (hasLlm && /qwen|llama|mistral|[1-9]\d+b/.test(models)) {
        node.role = 'Primary LLM Worker'
    } else if (hasLlm) {
        node.role = 'Small LLM Worker'
    } else if (hasTts || hasStt) {
        node.role = 'Voice/Audio Worker'
    } else {
        node.role = 'Edge Node / Kandidat'
    }

    if (hasLlm) node.strengths.push(`LLM läuft: ${bestModels(node).join(', ') || 'Modelle erkannt'}`)
    if (hasTts) node.strengths.push('Voice/TTS möglich')
    if (hasStt) node.strengths.push('STT/Whisper möglich')
    if (hasCuda) node.strengths.push('GPU/CUDA Hinweise erkannt')

    if (!hasLlm) node.gaps.push('kein laufender LLM-Service')
    if (!hasService(node, 'llm', 'ollama') && !hasInstalled(node, 'llm', 'ollama')) node.gaps.push('Ollama nicht erkannt')
    if (node.source !== 'local' && !node.host) node.gaps.push('keine erreichbare Host/IP-Config')

    if (!hasLlm && hasInstalled(node, 'llm', 'ollama')) {
        node.actions.push('Ollama starten und Models mit `/mesh scan` neu erfassen')
    } else if (!hasLlm) {
        node.actions.push('Ollama oder LM Studio installieren, wenn diese Node LLM-Arbeit übernehmen soll')
    }
    if (node.role.includes('Primary LLM') && !models.includes('qwen')) {
        node.actions.push('Größeres Qwen/Llama-Modell installieren, falls RAM/VRAM reicht')
    }
    if ((hasTts || hasStt) && !node.role.includes('Voice')) {
        node.actions.push('Optional als Voice-Worker markieren')
    }
    if (node.actions.length === 0) node.actions.push('Keine Pflichtaktion; Node ist nutzbar')
}

export function buildNodePlan(scan: AIScanResult): { text: string; nodes: PlannedNode[] } {
    const nodes = new Map<string, PlannedNode>()
    const ensure = (label: string, source: PlannedNode['source'], host?: string): PlannedNode => {
        const key = label.toLowerCase()
        const existing = nodes.get(key)
        if (existing) {
            if (!existing.host && host) existing.host = host
            if (existing.source !== 'local' && source === 'local') existing.source = 'local'
            return existing
        }
        const node: PlannedNode = {
            label,
            host,
            source,
            running: [],
            installed: [],
            sleeping: [],
            role: 'Unklar',
            strengths: [],
            gaps: [],
            actions: [],
        }
        nodes.set(key, node)
        return node
    }

    const local = ensure(hostname(), 'local', localIps()[0])
    local.strengths.push(`${platform()}/${arch()}, ${Math.round(totalmem() / 1024 / 1024 / 1024)}GB RAM, ${cpus().length} CPU Threads`)

    for (const configNode of loadConfigNodes()) {
        ensure(configNode.name || parseHost(configNode.host) || 'configured-node', 'config', parseHost(configNode.host))
    }

    for (const service of scan.services) {
        const node = ensure(serviceNodeLabel(service), service.host === 'localhost' ? 'local' : 'scan', service.host)
        if (service.status === 'running') node.running.push(service)
        else node.installed.push(service)
    }

    for (const sw of scan.sleepingSoftware || []) {
        ensure(sw.node || 'unknown', 'scan').sleeping.push(sw)
    }

    const planned = [...nodes.values()]
    for (const node of planned) inferRole(node)

    const lines: string[] = []
    lines.push(`*Nova Mesh Plan*`)
    lines.push(`Scan: ${new Date(scan.lastScan).toLocaleString('de')} (${scan.scanDurationMs}ms)`)
    lines.push(`Lokal: ${hostname()} (${localIps().join(', ') || 'keine IPv4'})`)
    lines.push('')

    for (const node of planned.sort((a, b) => a.label.localeCompare(b.label))) {
        lines.push(`*${node.label}*${node.host ? ` (${node.host})` : ''}`)
        lines.push(`Rolle: ${node.role}`)
        if (node.strengths.length > 0) lines.push(`Kann: ${node.strengths.join('; ')}`)
        if (node.gaps.length > 0) lines.push(`Fehlt: ${node.gaps.join('; ')}`)
        lines.push(`Naechste Schritte: ${node.actions.join('; ')}`)
        lines.push('')
    }

    lines.push('Config-Prinzip: `model` und `internalModel` auf `auto` lassen. Nodes liefern nur Erreichbarkeit/Services; Nova waehlt nach Scan und kann bei besserer Node hot-switchen.')
    return { text: lines.join('\n'), nodes: planned }
}

export async function scanAndBuildNodePlan(): Promise<string> {
    const { scanAllAIServices } = await import('./ai-scanner.js')
    const scan = await scanAllAIServices()
    return buildNodePlan(scan).text
}
