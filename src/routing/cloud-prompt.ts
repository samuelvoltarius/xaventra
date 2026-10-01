/**
 * Phase 6d — bereinigter Prompt für Cloud-Ziele (Pflicht).
 *
 * Before anything goes to a cloud model, memory, journal, conversation history
 * and customer data are removed. What remains: one neutral system prompt, the
 * current task (last user message) and the tool loop of the current turn
 * (needed code context), each scrubbed of private blocks and secrets. Images
 * never leave. Allow-list, not deny-list: every pipeline system message is
 * dropped, because it carries USER.md/MEMORY.md, journal, facts and context.
 */
import { redactSecrets } from '../security/secret-redaction.js'

export const CLOUD_SYSTEM_PROMPT = [
    'Du bist ein Assistent für eine klar umrissene Aufgabe (meist Code).',
    'Du bekommst bewusst nur die Aufgabe und den nötigen Code-Kontext — keine Erinnerungen, keinen Gesprächsverlauf, keine persönlichen Daten.',
    'Frage nicht nach persönlichen Daten. Antworte auf Deutsch, knapp und überprüfbar.',
].join(' ')

/** Headings that open a private section; the section ends at the next heading. */
const PRIVATE_HEADING = /^\s{0,3}#{1,6}\s*.*?(erinnerung|gedächtnis|gedaechtnis|memory|journal|tagebuch|user-kontext|user kontext|nutzer-kontext|gesprächs-kontext|gespraechs-kontext|verlauf|kunde|kunden|customer|core facts|kern-fakten|fakten|persönlich|persoenlich|familie|kontakte|gelerntes|gelernte|profil|bot-profil|autoobserver|empathie|emotion)/i
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/
const PRIVATE_TAGS = /<(memory|memories|erinnerung(?:en)?|journal|user[-_]?context|customer[-_]?data|kundendaten|history|verlauf|facts)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const PRIVATE_LINE = /^\s*\[(memory|erinnerung|journal|kunde|customer|fakt|fact|verlauf|history)[^\]]*\].*$/gim

export function scrubPrivateBlocks(text: string): string {
    const withoutTags = String(text ?? '').replace(PRIVATE_TAGS, '[entfernt: privat]').replace(PRIVATE_LINE, '')
    const out: string[] = []
    let skipping = false
    for (const line of withoutTags.split('\n')) {
        if (ANY_HEADING.test(line)) skipping = PRIVATE_HEADING.test(line)
        if (!skipping) out.push(line)
    }
    return redactSecrets(out.join('\n')).trim()
}

export interface CloudSanitizeResult {
    messages: any[]
    removed: { systemMessages: number; historyMessages: number; images: number }
}

export function sanitizeMessagesForCloud(messages: readonly any[]): CloudSanitizeResult {
    const list = Array.isArray(messages) ? messages : []
    let lastUser = -1
    for (let index = list.length - 1; index >= 0; index--) if (list[index]?.role === 'user') { lastUser = index; break }
    const removed = { systemMessages: 0, historyMessages: 0, images: 0 }
    const out: any[] = [{ role: 'system', content: CLOUD_SYSTEM_PROMPT }]
    list.forEach((message, index) => {
        if (!message || typeof message !== 'object') return
        if (message.role === 'system') { removed.systemMessages++; return }
        if (index < lastUser) { removed.historyMessages++; return }
        const { image, images, ...rest } = message
        if (image || images) removed.images++
        const cleaned: any = { ...rest }
        if (typeof rest.content === 'string') cleaned.content = scrubPrivateBlocks(rest.content)
        else if (Array.isArray(rest.content)) {
            cleaned.content = rest.content
                .filter((part: any) => !(part && (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image')))
                .map((part: any) => part && typeof part.text === 'string' ? { ...part, text: scrubPrivateBlocks(part.text) } : part)
        }
        out.push(cleaned)
    })
    return { messages: out, removed }
}

/** Proxy that sanitizes every `complete` call of a cloud client (all rounds of a run). */
export function createCloudSafeClient<T extends object>(client: T): T {
    if ((client as any)?.__cloudSafe) return client
    return new Proxy(client, {
        get: (target, key) => {
            if (key === '__cloudSafe') return true
            if (key === 'complete') return (messages: any[], ...rest: any[]) =>
                (target as any).complete(sanitizeMessagesForCloud(messages).messages, ...rest)
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
        },
    })
}
