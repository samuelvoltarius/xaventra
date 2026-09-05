export interface RoutingMessage {
    role: string
    content: string
}

const COMPLETION = /\b(?:erledigt|fertig|erfolgreich (?:ausgeführt|erstellt|gesendet)|wurde (?:gesendet|erstellt|installiert)|task completed)\b/i
const FOLLOW_UP = /^(?:ja|nein|ok|okay|mach|mache|weiter|und|auch|noch einmal|das|dies|diese|dieser|die|den|ihn|sie|es|dafür|darauf|dort|dann|genau|bitte|nummer|option|variante|wo|wie|warum)\b/i

/**
 * Builds the active work context used exclusively for tool routing.
 * The LLM receives its normal summary/hot history separately.
 */
export function buildToolTaskContext(
    history: RoutingMessage[],
    current: string,
    maxMessages = 12,
): string {
    const prior = history
        .filter(m => m?.content?.trim())
        .slice(-maxMessages)

    // A clearly completed assistant action closes older tool intents. Keep the
    // messages after that boundary plus the current follow-up.
    let boundary = -1
    for (let i = prior.length - 1; i >= 0; i--) {
        if (prior[i].role === 'assistant' && COMPLETION.test(prior[i].content)) {
            boundary = i
            break
        }
    }

    let active = prior.slice(boundary + 1)
    if (/^\d+$/.test(current.trim())) active = active.slice(-3)
    // Explicit new turns never inherit tool packs merely because an older
    // conversation mentioned setup/install/deploy. Short messages used to keep
    // the entire window and could turn "dich besser machen" into an unrelated
    // self_setup_plan call. Deictic follow-ups retain the active task window.
    if (!FOLLOW_UP.test(current.trim())) active = []

    return [...active.map(m => m.content), current].join('\n')
}
