/**
 * Picture turns (2.89.3): decides whether the active model already looks at the picture of this message.
 * If so, analyze_image for that picture is redundant work: live 08.10.2026 the model answered within 14 s
 * with the picture in the call, then called analyze_image anyway and ran into its 90 s limit.
 */
import { readProbeResults } from '../llm/capability-probe.js'

/** Name patterns of models that read pictures when no probe result exists. */
const VISION_NAME = /gpt-[45]|claude|gemini|gemma-?3|llava|pixtral|minicpm-v|(?:^|[-_:/])vl(?:$|[-_:./])|vision|qwen\d?(?:\.\d+)?-?vl/i

/** True when the model is known (probe) or recognisably (name) able to read pictures. */
export function activeModelSeesImages(modelId?: string, probes: ReturnType<typeof readProbeResults> = safeProbes()): boolean {
    const id = String(modelId || '').trim()
    if (!id) return false
    const probe = probes.find(entry => entry.model === id && typeof entry.supportsVision === 'boolean')
    if (probe) return probe.supportsVision === true
    return VISION_NAME.test(id)
}

function safeProbes(): ReturnType<typeof readProbeResults> {
    try { return readProbeResults() } catch { return [] }
}

/** Tools that are redundant for a picture the active model already sees. */
export const REDUNDANT_WHEN_MODEL_SEES_IMAGE = ['analyze_image'] as const
