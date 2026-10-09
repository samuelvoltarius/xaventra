/**
 * System prompt budget by block priority.
 *
 * Up to 2.82.0 the cap kept the first 25 %, the next 20 % and the last 55 %
 * of the budget and cut everything in between, blind to content. Live on the
 * Spark ("systemPrompt too large ... capping to 12000") that removed the
 * ENTSCHEIDUNGEN block, which sits in the middle of the assembled prompt.
 *
 * Now the prompt is split at its `## ` headings and every block gets a
 * priority:
 *   0  never cut while anything else can go: Eingehendes Bild (its file path must stay exact), ENTSCHEIDUNGEN, saved routine
 *      skill, known procedure, security/user rights, strict mode, corrections
 *   1  important: identity (text before the first heading), critical rules,
 *      HANDELN, system time, operating mode
 *   2  normal context
 *   3  background: learned knowledge, live status, hardware, mesh, journal,
 *      reflection, suggestions, emotion, patterns, insights
 * Lower tiers are trimmed (head and tail of each block kept) or dropped
 * first; the order of the remaining blocks never changes.
 */

import { mentionsEnvironment } from './request-capabilities.js'

export interface PromptBudgetResult {
    prompt: string
    truncated: boolean
    sections: {
        /** Characters kept per priority tier (0 = protected ... 3 = background). */
        keptByPriority: [number, number, number, number]
        /** Headings of blocks that were trimmed or dropped. */
        reduced: string[]
        dropped: number
    }
}

export type BlockPriority = 0 | 1 | 2 | 3

const PROTECTED = /eingehendes bild|entscheidung|gespeicherter skill|bekannte lösung|prozedur|user-kontext|nutzerkorrektur|sicherheit|security|strict|freigabe|rechte|bot-profil|verifiziertes gedächtnis|entitätenbezug|gedächtniswege/i
const IMPORTANT = /kritisch|regeln|handeln|systemzeit|bedienmodus|ehrlichkeit|nicht verfügbar/i
const BACKGROUND = /gelerntes wissen|hintergrund|system-status|system-befund|hardware|mesh|journal|tagebuch|reflexion|reflection|proaktiv|proactive|vorschl|emotion|stimmung|empath|muster|pattern|vorhersage|predict|insight|trace|inventar|inventory|persönlichkeit|session management|soziale|node updates|gesprächs-kontext/i

/** Priority of a block from its heading line. */
export function blockPriority(heading: string): BlockPriority {
    if (PROTECTED.test(heading)) return 0
    if (IMPORTANT.test(heading)) return 1
    if (BACKGROUND.test(heading)) return 3
    return 2
}

interface Block {
    text: string
    heading: string
    priority: BlockPriority
    keep: number
}

const TRIM_MARKER = '\n[… gekürzt …]\n'
/** Below this a trimmed block carries no useful content and is dropped. */
const MIN_TRIMMED_BLOCK = 160

function splitBlocks(input: string, activeRequest: string): Block[] {
    // A block starts at a line beginning with "## " (level-2 heading).
    const starts = [0]
    const re = /\n(?=## )/g
    let match: RegExpExecArray | null
    while ((match = re.exec(input)) !== null) {
        if (match.index > 0) starts.push(match.index)
    }
    const blocks: Block[] = []
    for (let i = 0; i < starts.length; i++) {
        const text = input.slice(starts[i], starts[i + 1] ?? input.length)
        if (!text) continue
        const headingLine = text.replace(/^\n+/, '').split('\n', 1)[0] || ''
        const isHeading = headingLine.startsWith('## ')
        // Text before the first heading is the identity (soul + persona).
        const relevantLiveState = mentionsEnvironment(activeRequest) && /mesh|system-status|system-befund|inventar|inventory|umgebungsbeobachtungen/i.test(headingLine)
        const priority: BlockPriority = isHeading ? (relevantLiveState ? 1 : blockPriority(headingLine)) : 1
        blocks.push({ text, heading: isHeading ? headingLine.trim() : '(Identität)', priority, keep: text.length })
    }
    return blocks
}

function renderBlock(block: Block): string {
    if (block.keep >= block.text.length) return block.text
    if (block.keep <= 0) return ''
    const usable = Math.max(0, block.keep - TRIM_MARKER.length)
    const head = Math.ceil(usable * 0.7)
    const tail = usable - head
    return block.text.slice(0, head) + TRIM_MARKER + (tail > 0 ? block.text.slice(-tail) : '')
}

/** Shrinks the blocks of one tier proportionally into `budget` characters. */
function fitTier(blocks: Block[], budget: number): void {
    const total = blocks.reduce((sum, block) => sum + block.text.length, 0)
    if (total <= budget) return
    if (budget <= 0) {
        for (const block of blocks) block.keep = 0
        return
    }
    const ratio = budget / total
    for (const block of blocks) {
        const share = Math.floor(block.text.length * ratio)
        block.keep = share >= MIN_TRIMMED_BLOCK ? share : 0
    }
}

/** Keeps the most important blocks in full and trims background first. */
export function applySystemPromptBudget(input: string, maxChars: number, activeRequest = ''): PromptBudgetResult {
    const blocks = splitBlocks(input, activeRequest)
    const kept = (): [number, number, number, number] => {
        const out: [number, number, number, number] = [0, 0, 0, 0]
        for (const block of blocks) out[block.priority] += renderBlock(block).length
        return out
    }
    if (input.length <= maxChars) {
        return { prompt: input, truncated: false, sections: { keptByPriority: kept(), reduced: [], dropped: 0 } }
    }
    const note = (dropped: number) => dropped > 0 ? `\n\n[Kontext budgetiert: ${dropped} Block/Blöcke ausgelassen]` : ''
    // Reserve room for the closing note so the result never exceeds the cap.
    const limit = Math.max(0, maxChars - note(99).length)
    for (const tier of [3, 2, 1, 0] as const) {
        const higher = blocks.filter(block => block.priority < tier).reduce((sum, block) => sum + block.text.length, 0)
        const lower = blocks.filter(block => block.priority > tier).reduce((sum, block) => sum + renderBlock(block).length, 0)
        const tierBlocks = blocks.filter(block => block.priority === tier)
        fitTier(tierBlocks, limit - higher - lower)
        const used = blocks.reduce((sum, block) => sum + renderBlock(block).length, 0)
        if (used <= limit) break
    }
    const dropped = blocks.filter(block => block.keep <= 0).length
    let prompt = blocks.map(renderBlock).join('') + note(dropped)
    if (prompt.length > maxChars) {
        // Last resort (protected blocks alone exceed the cap): keep head and tail.
        const usable = Math.max(0, maxChars - TRIM_MARKER.length)
        const head = Math.ceil(usable * 0.45)
        prompt = prompt.slice(0, head) + TRIM_MARKER + prompt.slice(-(usable - head))
    }
    return {
        prompt,
        truncated: true,
        sections: {
            keptByPriority: kept(),
            reduced: blocks.filter(block => block.keep < block.text.length).map(block => block.heading),
            dropped,
        },
    }
}
