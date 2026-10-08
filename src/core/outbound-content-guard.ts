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
        // Orphan closing tag only (reasoning without an opening tag). If an
        // opening tag comes first, visible text before it is kept (R2 NZ-32).
        .replace(/^(?:(?!<(?:think|thinking)>)[\s\S])*?<\/(?:think|thinking)>/i, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<(?:think|thinking)>[\s\S]*$/gi, '')
        .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/gi, '')
        .replace(/^\s*(?:ich bin (?:ein )?hilfreicher assistent|der user hat\b|ich sollte\b|lass mich\b)[^\n]*(?:\n|$)/gim, '')
        .replace(/^\s*(?:analysis|reasoning)\s*:[^\n]*(?:\n|$)/gim, '')
        .replace(/^.*\brm\s+-rf\b.*$/gim, '⚠️ Destruktiver Löschbefehl unterdrückt – zuerst Diagnose, Sicherung und Freigabe erforderlich.')
        .replace(/^.*\bRemove-Item\b.*-(?:Recurse|Force)\b.*$/gim, '⚠️ Destruktiver Löschbefehl unterdrückt – zuerst Diagnose, Sicherung und Freigabe erforderlich.')
        // 2.89.4: internal escalation vocabulary never reaches a user channel.
        .replace(/verifiziert\s+fehlgeschlagen/gi, 'nicht gelungen')
        .replace(/(?:eine\s+)?begrenzte\s+Doctor-Diagnose\s+ist\s+bereits\s+vorgemerkt/gi, 'ich habe die Ursache intern vorgemerkt und prüfen lassen')
        .replace(/(?:eine\s+)?begrenzte\s+Doctor-Diagnose\s+(?:habe\s+ich\s+)?vorgemerkt/gi, 'ich habe die Ursache intern zur Prüfung vorgemerkt')
    return text.replace(/\n{3,}/g, '\n\n').trim()
}
