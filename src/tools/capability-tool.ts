/**
 * Nova Tool: resolve_capability
 *
 * Nova calls this autonomously when she needs a tool/binary/package
 * that might not be installed. She decides:
 *   - What node is the best fit (most RAM, GPU, right OS)
 *   - Whether it already exists somewhere in the mesh
 *   - Whether to install it locally or remotely
 *   - How to route the resulting work
 *
 * Example usage by Nova:
 *   resolve_capability({ name: "whisper", task: "transcribe voice message" })
 *   resolve_capability({ name: "ffmpeg", task: "convert video to mp4" })
 *   resolve_capability({ name: "tesseract", task: "OCR image to text" })
 *   resolve_capability({ name: "ollama", task: "run local LLM" })
 */

import { resolveCapability, CAPABILITIES, formatResolution, CapabilityQuery } from '../intelligence/capability-router.js'

// ============================================
// Named capability registry (human-friendly)
// ============================================

const CAPABILITY_REGISTRY: Record<string, () => CapabilityQuery> = {
    // Voice / Audio
    'whisper': CAPABILITIES.whisper,
    'openai-whisper': CAPABILITIES.whisper,
    'stt': CAPABILITIES.whisper,
    'speech-to-text': CAPABILITIES.whisper,
    'voice': CAPABILITIES.whisper,
    'ffmpeg': CAPABILITIES.ffmpeg,

    // Local LLM
    'ollama': CAPABILITIES.ollama,
    'llm': CAPABILITIES.ollama,
    'local-llm': CAPABILITIES.ollama,

    // Download
    'yt-dlp': CAPABILITIES.yt_dlp,
    'youtube': CAPABILITIES.yt_dlp,
    'downloader': CAPABILITIES.yt_dlp,
    'video-download': CAPABILITIES.yt_dlp,

    // Image / OCR
    'imagemagick': CAPABILITIES.imagemagick,
    'convert': CAPABILITIES.imagemagick,
    'tesseract': CAPABILITIES.tesseract,
    'ocr': CAPABILITIES.tesseract,

    // Documents
    'pandoc': CAPABILITIES.pandoc,
    'document-converter': CAPABILITIES.pandoc,
}

// ============================================
// Tool handler
// ============================================

async function handleResolveCapability(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = (params.name as string || '').toLowerCase().trim()
    const taskDescription = params.task as string | undefined

    // Look up the capability definition
    const queryFn = CAPABILITY_REGISTRY[name]
    if (!queryFn) {
        const available = Object.keys(CAPABILITY_REGISTRY).join(', ')
        return {
            error: `Unbekannte Capability: "${name}". Bekannte: ${available}`,
            available: Object.keys(CAPABILITY_REGISTRY),
        }
    }

    const query = queryFn()
    console.log(`[CapabilityTool] 🔍 Nova resolving capability: ${query.name}${taskDescription ? ` für: ${taskDescription}` : ''}`)

    const resolution = await resolveCapability(query)

    const result: Record<string, unknown> = {
        capability: query.name,
        task: taskDescription,
        resolved: !resolution.error,
        runLocally: !resolution.runRemotely && !resolution.error,
        runRemotely: resolution.runRemotely,
        installed: resolution.installed,
        summary: formatResolution(query, resolution),
    }

    if (resolution.runRemotely && resolution.node) {
        result.node = {
            hostname: resolution.node.hostname,
            ip: resolution.node.ip,
            platform: resolution.node.platform,
        }
        result.sshPrefix = resolution.sshPrefix
        result.guidance = `Benutze SSH-Tool mit host="${resolution.node.ip}" um den Task auf ${resolution.node.hostname} auszuführen.`
    } else if (!resolution.error) {
        result.guidance = `${query.name} ist lokal verfügbar. Fahre mit dem Task direkt fort.`
    } else {
        result.error = resolution.error
        result.guidance = `Capability konnte nicht aufgelöst werden. Manuelle Installation erforderlich.`
    }

    return result
}

// ============================================
// Tool export
// ============================================

export const capabilityTool = {
    name: 'resolve_capability',
    description: `Prüft ob eine benötigte Software/Tool verfügbar ist und installiert sie ggf. automatisch auf dem besten verfügbaren Node.
Nova ruft dies auf wenn sie merkt dass ein Tool fehlt — sie entscheidet selbst wo und wie sie es installiert.
Gibt zurück: ob lokal oder remote ausführbar, welcher Node, wie via SSH verbinden.
Bekannte Capabilities: whisper (STT), ffmpeg, ollama (LLM), yt-dlp, tesseract (OCR), imagemagick, pandoc.`,
    category: 'system' as const,
    parameters: [
        {
            name: 'name',
            type: 'string' as const,
            description: 'Name der benötigten Capability z.B. "whisper", "ffmpeg", "ollama", "tesseract"',
            required: true,
        },
        {
            name: 'task',
            type: 'string' as const,
            description: 'Optionale Beschreibung warum die Capability benötigt wird (für besseres Logging)',
            required: false,
        },
    ],
    handler: handleResolveCapability,
}

export default capabilityTool
