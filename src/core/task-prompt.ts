/**
 * 2.90.0 Aufgaben-Prompt („Kontext je Aufgabe“, Baustein B).
 *
 * Up to 2.89 every turn got the same assembled prompt (soul + ~60 blocks) and
 * the budget cut it afterwards: live 25 of 46 Telegram turns were cut to
 * 12 000 characters and always the same 20 blocks went missing, among them
 * „## Tools“, „## DEINE UMGEBUNG“, „## Vorherige fehlgeschlagene Versuche“ and
 * „## Eskalationskette“ (C-Messung 28.10.). The cap is blind to the task.
 *
 * Here every block gets a topic from its heading, the turn gets topics from
 * its tool route (tool-router.ts, deterministic) and its context policy, and
 * only `kern` plus matching blocks are kept. Blocks without a known topic are
 * always kept and reported, so nothing is lost silently. The prompt budget
 * (prompt-budget.ts) stays the safety net behind this.
 *
 * Switch `taskPrompt` (context-switches.ts): shadow builds and measures, on sends it.
 */
import { blockPriority, splitPromptBlocks } from './prompt-budget.js'
import { selectContextPolicy, type ContextPolicy } from './context-policy.js'

export type PromptTopic = 'kern' | 'aktion' | 'umgebung' | 'dateien' | 'selbst' | 'gedaechtnis' | 'sozial'

/** Order matters: the first match wins. */
const TOPIC_RULES: ReadonlyArray<[PromptTopic, RegExp]> = [
    ['kern', /ehrlich|systemzeit|kritische regeln\b|user-kontext|owner-profil|kern-fakten|fakten über den user|vorherige fehlgeschlagene|eskalationskette|bedienmodus|gesprächsabsicht|frage zum gespräch|nicht verfügbar|identität/i],
    ['umgebung', /umgebung|mesh|node updates|system-status|system-befund|hardware|ssh-ziele|system info|platform-awareness|verfügbare llms|llm endpoint|system health|self-check|geräte|tailnet/i],
    ['dateien', /arbeitsverzeichnis|dateisystem|projekt|aktueller plan/i],
    ['selbst', /selbst-evolution|selbst-erweiterung|selbst-lernen|selbst-diagnose|model-auswahl|self-architecture|tool inventory/i],
    ['sozial', /persönlichkeit|soziale|emotion|empath|vibe|persona|reflexion|proaktiv|performance-erkenntnisse|predictive|session management|stimmung/i],
    ['gedaechtnis', /gedächtnis|memory|erinnerung|gelernt|lektionen|erkenntnisse|kontinuität|gesprächs-kontext|zuletzt in anderen|tagebuch|journal|wissen|gelöste probleme|instinkte/i],
    ['aktion', /handeln|tool|multi-step|workflow|qualitäts-gate|error handling|ergebnis sofort|denkprozess|thinking|regel \d|^regeln$/i],
]

/** Topic of a block from its heading line; null = unknown (kept). */
export function blockTopic(heading: string): PromptTopic | null {
    const text = String(heading || '').replace(/^##\s*/, '').trim()
    if (text === '(Identität)') return 'kern'
    if (blockPriority(`## ${text}`) === 0) return 'kern'
    for (const [topic, pattern] of TOPIC_RULES) if (pattern.test(text)) return topic
    return null
}

/** Tool routes (tool-router.ts `toolRoute`) that bring a topic. */
const ROUTE_TOPICS: Readonly<Record<string, PromptTopic>> = {
    'pack:system-shell': 'umgebung', 'pack:mesh-network': 'umgebung', 'pack:docker': 'umgebung', 'pack:process-management': 'umgebung',
    'pack:system-config': 'umgebung', 'pack:monitoring': 'umgebung', 'pack:computer-use': 'umgebung', 'pack:desktop-capture': 'umgebung',
    'live:mesh': 'umgebung', 'live:environment': 'umgebung', 'live:proxmox': 'umgebung', 'live:kubernetes': 'umgebung',
    'live:tailnet': 'umgebung', 'live:screenshot': 'umgebung', 'live:workstation-action': 'umgebung',
    'pack:files': 'dateien', 'pack:documents': 'dateien', 'pack:code-analysis': 'dateien', 'pack:developer-harness': 'dateien',
    'pack:git-updates': 'dateien', 'pack:projects': 'dateien',
    'pack:self-evolution': 'selbst', 'pack:self-setup': 'selbst', 'pack:patch-management': 'selbst', 'pack:llm-management': 'selbst',
    'pack:routing': 'selbst', 'pack:self-doctor': 'selbst', 'pack:plugins': 'selbst', 'pack:corrections': 'selbst',
    'pack:personal-memory': 'gedaechtnis', 'pack:knowledge-graph': 'gedaechtnis',
}
const WORK_CLASSES = new Set<ContextPolicy['taskClass']>(['action', 'analysis', 'research', 'recovery'])

export function turnTopics(input: {
    toolNames: readonly string[]
    policy: Pick<ContextPolicy, 'taskClass' | 'mesh' | 'hardware' | 'memoryDepth'>
    route?: (name: string) => string | null
}): Set<PromptTopic> {
    const topics = new Set<PromptTopic>(['kern'])
    const route = input.route ?? (() => null)
    for (const name of input.toolNames) {
        const way = route(name)
        if (!way || way === 'core' || way === 'fallback') continue
        topics.add('aktion')
        const topic = ROUTE_TOPICS[way]
        if (topic) topics.add(topic)
    }
    if (WORK_CLASSES.has(input.policy.taskClass)) topics.add('aktion')
    if (input.policy.taskClass === 'conversation') topics.add('sozial')
    if (input.policy.mesh || input.policy.hardware) topics.add('umgebung')
    if (input.policy.memoryDepth !== 'none') topics.add('gedaechtnis')
    return topics
}

export interface TaskPromptResult {
    prompt: string
    topics: PromptTopic[]
    kept: string[]
    omitted: string[]
    untagged: string[]
}

/** Keeps identity, `kern` and blocks of the given topics; order unchanged. */
export function buildTaskPrompt(prompt: string, topics: ReadonlySet<PromptTopic>): TaskPromptResult {
    const kept: string[] = [], omitted: string[] = [], untagged: string[] = []
    let out = ''
    for (const block of splitPromptBlocks(prompt)) {
        const topic = blockTopic(block.heading)
        if (topic === null) untagged.push(block.heading)
        if (topic === null || topics.has(topic)) {
            out += block.text
            kept.push(block.heading)
        } else omitted.push(block.heading)
    }
    return { prompt: out, topics: [...topics], kept, omitted, untagged }
}

/** The two tool-router functions the task prompt needs (loaded lazily by the caller: the router pulls in the registry). */
export interface TaskPromptRouter {
    getRelevantTools: (userMessage: string, primaryMessage?: string, options?: { quiet?: boolean }) => Array<{ name: string }>
    toolRoute: (name: string) => string | null
}

/**
 * Task prompt for one request: topics from the same tool route the runner
 * offers (or the execution's allowed tools) and the turn's context policy.
 */
export function taskPromptForRequest(
    prompt: string,
    request: string,
    options: { router: TaskPromptRouter; toolNames?: readonly string[]; policy?: ContextPolicy },
): TaskPromptResult {
    const toolNames = options.toolNames ?? options.router.getRelevantTools(request, request, { quiet: true }).map(tool => tool.name)
    const policy = options.policy ?? selectContextPolicy(request)
    return buildTaskPrompt(prompt, turnTopics({ toolNames, policy, route: options.router.toolRoute }))
}
