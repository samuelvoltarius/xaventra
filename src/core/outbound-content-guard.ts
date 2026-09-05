/** Content that belongs to an LLM planner/reasoner and must never reach a user channel. */
export function isInternalOutboundArtifact(value: unknown): boolean {
    const text = String(value ?? '').trim()
    if (!text) return false

    if (/<\/?(?:think|thinking)>/i.test(text)) return true
    if (/\bhere(?:'s| is) (?:a |the )?thinking process\b/i.test(text)) return true
    if (/^\s*(?:analysis|reasoning)\s*:/im.test(text)) return true
    if (/\bthe user (?:wants|asks|requested)\b/i.test(text)) return true
    if (/^\s*\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/is.test(text)) return true
    if (/^\s*(?:ich bin (?:ein )?hilfreicher assistent|der user hat\b|ich sollte\b|lass mich\b)/i.test(text)) return true

    return false
}

/** Remove embedded tool plans/reasoning while preserving legitimate text. */
export function sanitizeInternalOutboundArtifacts(value: unknown): string {
    let text = String(value ?? '')
    text = text
        .replace(/^[\s\S]*?<\/(?:think|thinking)>/i, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<(?:think|thinking)>[\s\S]*$/gi, '')
        .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/gi, '')
        .replace(/^\s*(?:ich bin (?:ein )?hilfreicher assistent|der user hat\b|ich sollte\b|lass mich\b)[^\n]*(?:\n|$)/gim, '')
        .replace(/^\s*(?:analysis|reasoning)\s*:[^\n]*(?:\n|$)/gim, '')
        .replace(/^.*\brm\s+-rf\b.*$/gim, '⚠️ Destruktiver Löschbefehl unterdrückt – zuerst Diagnose, Sicherung und Freigabe erforderlich.')
        .replace(/^.*\bRemove-Item\b.*-(?:Recurse|Force)\b.*$/gim, '⚠️ Destruktiver Löschbefehl unterdrückt – zuerst Diagnose, Sicherung und Freigabe erforderlich.')
    return text.replace(/\n{3,}/g, '\n\n').trim()
}
