import type { ActionIntent } from './action-intent.js'
import { isSuccessfulToolResult } from '../tools/tool-result-quality.js'

export interface ValidationResult {
    success: boolean
    evidence: string[]
    reason?: string
}

function collectEvidence(result: unknown): string[] {
    if (!result || typeof result !== 'object') return []
    const value = result as Record<string, unknown>
    return ['path', 'file', 'filePath', 'outputPath', 'imagePath', 'screenshotPath', 'imageUrl', 'url', 'messageId', 'output']
        .filter(key => typeof value[key] === 'string' && String(value[key]).trim().length > 0)
        .map(key => `${key}:${String(value[key]).trim()}`)
}

/** Validates task evidence, not merely whether a tool returned without throwing. */
export function validateToolOutcome(toolName: string, result: unknown, intent?: ActionIntent): ValidationResult {
    if (!isSuccessfulToolResult(result)) return { success: false, evidence: [], reason: 'tool reported failure' }
    const evidence = collectEvidence(result)

    if (toolName === 'generate_image') {
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        const hasArtifact = evidence.length > 0 || /(?:https?:\/\/|[A-Z]:\\|\/)[^\s"']+\.(?:png|jpe?g|webp)/i.test(text)
        return hasArtifact
            ? { success: true, evidence: evidence.length ? evidence : ['image-reference'] }
            : { success: false, evidence: [], reason: 'image generator returned no image artifact' }
    }

    // 2.90.3: node captures keep the image privately (path per node) and never deliver it themselves.
    if (toolName === 'mesh_screenshot' || toolName === 'mesh_desktop_input') {
        const r = result as any
        const paths = toolName === 'mesh_screenshot'
            ? (Array.isArray(r?.captures) ? r.captures : []).filter((c: any) => c?.captured === true && typeof c.path === 'string').map((c: any) => c.path)
            : (typeof r?.capture?.path === 'string' ? [r.capture.path] : [])
        return paths.length
            ? { success: true, evidence: paths.map((path: string) => `path:${path}`) }
            : { success: false, evidence: [], reason: 'node capture returned no image' }
    }

    if (intent?.kind === 'screenshot' && /screenshot|desktop/i.test(toolName)) {
        return evidence.some(key => /path|file|screenshot|url/i.test(key))
            ? { success: true, evidence }
            : { success: false, evidence: [], reason: 'screenshot tool returned no transferable file' }
    }

    return { success: true, evidence }
}
