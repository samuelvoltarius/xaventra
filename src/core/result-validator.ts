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

    if (intent?.kind === 'screenshot' && /screenshot|desktop/i.test(toolName)) {
        return evidence.some(key => /path|file|screenshot|url/i.test(key))
            ? { success: true, evidence }
            : { success: false, evidence: [], reason: 'screenshot tool returned no transferable file' }
    }

    return { success: true, evidence }
}
