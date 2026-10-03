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
    // A bare number answers offered options: keep the last turns (R2 NZ-38;
    // previously FOLLOW_UP below cleared them again).
    const numericChoice = /^\d+$/.test(current.trim())
    if (numericChoice) active = active.slice(-3)
    // Explicit new turns never inherit tool packs merely because an older
    // conversation mentioned setup/install/deploy. Short messages used to keep
    // the entire window and could turn "dich besser machen" into an unrelated
    // self_setup_plan call. Deictic follow-ups retain the active task window.
    // Explicit short name corrections retain only the immediate exchange, not
    // arbitrary historical install/deploy intents. This is routing, not consent.
    const nameCorrection = /^(?:[\p{L}\p{N}_.-]{1,64}\s*[,;]?\s+(?:sorry|pardon|meinte ich)|(?:sorry|pardon|ich meinte)\s*[,;]?\s+[\p{L}\p{N}_.-]{1,64})[.!]?$/iu.test(current.trim())
    if (nameCorrection) active = active.slice(-2)
    if (!numericChoice && !nameCorrection && !FOLLOW_UP.test(current.trim())) active = []

    return [...active.map(m => m.content), current].join('\n')
}
