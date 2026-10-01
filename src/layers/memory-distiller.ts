/**
 * Nova Memory Distiller — Nightly Layer
 * ======================================
 * Runs at 02:00 AM (Europe/Vienna) via CronerScheduler.
 *
 * What it does:
 *   1. Reads today's journal (all events, topics, users)
 *   2. Makes a rich LLM call to extract structured knowledge:
 *      - User facts & preferences (Sample's preferences, hardware, projects)
 *      - Decisions made today
 *      - Technical learnings & insights
 *      - Unresolved issues / TODOs
 *   3. Writes a detailed diary entry → .nova-data/memories/diary/YYYY-MM-DD.md
 *   4. Pushes extracted facts as Brain episodes (POST /add_episode)
 *      so they become part of Nova's long-term Graphiti memory
 *   5. Runs gracefully even if Brain is offline (diary still written)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDurableMemoryCandidate } from '../memory/memory-quality.js'
import { structuredTriple } from '../memory/memory-triple.js'
import { principalScope, resolvePrincipalId } from '../users/principal-id.js'
import { resolveConfigPath } from '../config/config-path.js'


// ── Types ─────────────────────────────────────────────────────────────────────

/** Optional Knowledge-Graph structure of one user fact (user → beziehung → wert). */
export interface DistilledFactTriple { fact: string; predicate: string; value: string }

export interface DistilledMemory {
    date: string
    userFacts: string[]        // Persistent facts about the user(s)
    /** Structure for some userFacts; governance projects canonical ones into the graph. */
    factTriples?: DistilledFactTriple[]
    decisions: string[]        // Decisions made or confirmed
    learnings: string[]        // Technical or factual learnings
    openQuestions: string[]    // Unresolved topics / TODOs
    mistakes: string[]         // Errors Nova made today (to AVOID, not to learn as behavior)
    mood: string               // Nova's perceived tone of the day
    diaryText: string          // Full narrative diary entry
}

interface BrainEpisode {
    content: string
    type: 'fact' | 'decision' | 'preference' | 'learning'
    source: string
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR   = join(process.cwd(), '.nova-data')
const DIARY_DIR  = join(DATA_DIR, 'memories', 'diary')
const CONFIG_PATH = resolveConfigPath()

function readDistillerConfig(): any {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) } catch { return {} }
}

/** Canonical principal of the configured owner (first allowFrom entry). */
function ownerPrincipalId(config: any = readDistillerConfig()): string {
    const telegramOwner = config.channels?.telegram?.allowFrom?.[0]
    if (telegramOwner) return resolvePrincipalId(config, 'telegram', String(telegramOwner))
    const whatsappOwner = config.channels?.whatsapp?.allowFrom?.[0]
    if (whatsappOwner) return resolvePrincipalId(config, 'whatsapp', String(whatsappOwner))
    return 'owner'
}

const sanitizeSessionName = (value: string) => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_')

/**
 * Map a session log (named after the display alias or raw id, see logSession)
 * and a line's channel back to the canonical principal. Ambiguous mappings
 * return null so the line is skipped instead of being attributed to someone.
 */
export function sessionLinePrincipal(config: any, sessionName: string, channel: string): string | null {
    const aliases: Record<string, string> = config?.userAliases || {}
    const rawCandidates = new Set<string>()
    for (const [raw, alias] of Object.entries(aliases)) {
        if (sanitizeSessionName(alias) === sessionName) rawCandidates.add(raw)
    }
    if (rawCandidates.size === 0) rawCandidates.add(sessionName)
    // A raw id that is explicitly bound to another channel only (e.g.
    // `discord:d-9`) cannot be the sender of a line logged on this channel.
    const mappings: Record<string, string> = config?.userPrincipals || {}
    const normalizedChannel = String(channel || '').trim().toLowerCase() || 'unknown'
    const plausible = [...rawCandidates].filter(raw => {
        if (mappings[`${normalizedChannel}:${raw}`] || mappings[raw]) return true
        return !Object.keys(mappings).some(key => key.endsWith(`:${raw}`))
    })
    const principals = new Set(plausible.map(raw => resolvePrincipalId(config, normalizedChannel, raw)))
    return principals.size === 1 ? [...principals][0] : null
}

function ensureDiaryDir(): void {
    if (!existsSync(DIARY_DIR)) mkdirSync(DIARY_DIR, { recursive: true })
}

function getDateString(offsetDays = 0): string {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return d.toISOString().split('T')[0]
}

// ── Brain API Integration ─────────────────────────────────────────────────────

function getBrainUrl(): string | null {
    try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
        return cfg.brain?.brainUrl || cfg.plugins?.['brain-hook']?.brainUrl || null
    } catch { return null }
}

async function pushToBrain(episodes: BrainEpisode[], date: string): Promise<{ pushed: number; failed: number }> {
    // Raw distiller output must not become a parallel memory authority.
    // Compatibility export is opt-in until Brain consumes governance records.
    if (process.env.NOVA_ALLOW_LEGACY_BRAIN_EXPORT !== '1') return { pushed: 0, failed: 0 }
    const brainUrl = getBrainUrl()
    if (!brainUrl) return { pushed: 0, failed: 0 }

    let pushed = 0
    let failed = 0

    for (const ep of episodes) {
        try {
            const resp = await fetch(`${brainUrl}/add_episode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: ep.content,
                    type: ep.type,
                    source: ep.source,
                    group_id: 'nova',
                    reference_time: `${date}T02:00:00Z`,
                }),
                signal: AbortSignal.timeout(10000),
            })
            if (resp.ok) {
                pushed++
            } else {
                failed++
                console.warn(`[MemoryDistiller] Brain episode rejected: ${resp.status}`)
            }
        } catch (e: any) {
            failed++
            console.warn(`[MemoryDistiller] Brain push failed: ${e.message}`)
        }
    }

    return { pushed, failed }
}

// ── LLM Extraction ────────────────────────────────────────────────────────────

async function extractWithLLM(
    llm: any,
    journalText: string,
    date: string,
    subject = 'den Benutzer',
): Promise<DistilledMemory | null> {
    const prompt = `Du bist Nova, eine autonome KI-Assistentin. Heute ist ${date}.

Analysiere die heutigen Gespräche und destilliere NUR echtes, dauerhaftes Wissen.
Die Gespräche stammen ausschließlich von EINER Person (${subject}); ordne nichts anderen Personen zu.

KRITISCHE REGELN für die Extraktion:
- userFacts: NUR dauerhafte Fakten über ${subject} (Name, Hardware, Projekte, Vorlieben, Haustiere, Familie).
  KEINE Gesprächsfetzen, KEINE einzelnen Wörter, KEINE Fragen, KEINE deiner eigenen Antworten.
  Jeder Fakt muss ein vollständiger, eigenständiger Satz sein der in 6 Monaten noch wahr ist.
  FALSCH: "Name: da", "Warum ging das nicht?", "Context: ich habe..."
  RICHTIG: "Sample nutzt einen 3D-Drucker mit Moonraker/Klipper."
- mistakes: Fehler die DU heute gemacht hast (z.B. falsches Modell genutzt, Tool nicht aufgerufen,
  halluziniert). Diese sind Dinge die du VERMEIDEN sollst — NICHT als neues Verhalten lernen!
- Wenn ein Gespräch nur Smalltalk/Fehler war: leere Arrays zurückgeben. Lieber nichts als Müll.

Gespräche des Tages:
${journalText}

Antworte NUR mit validem JSON (keine Codeblöcke):
{
  "userFacts": ["Dauerhafte Fakten über ${subject} — vollständige Sätze — max 6, lieber weniger und gut. Hat ein Fakt eine klare Beziehung (Wohnort, Gerät, Projekt, Haustier, Person), schreib ihn als Objekt {\"satz\": \"…\", \"beziehung\": \"wohnt_in|arbeitet_an|drucker|hund|…\", \"wert\": \"kurzer Name, höchstens 50 Zeichen\"}. Nie Passwörter, Tokens oder Zugangsdaten."],
  "decisions": ["Heute getroffene konkrete Entscheidungen — max 5"],
  "learnings": ["Technische Erkenntnisse die dauerhaft nützlich sind — max 6"],
  "openQuestions": ["Offene TODOs / ungelöste Probleme — max 5"],
  "mistakes": ["Fehler die du heute gemacht hast und vermeiden sollst — max 5"],
  "mood": "Ein Satz: Stimmung/Ton des Tages",
  "diaryText": "2-4 Sätze Tagebucheintrag aus deiner Perspektive (Deutsch, persönlich)"
}`

    try {
        const result = await llm.complete(prompt)
        const raw = typeof result === 'string' ? result : result?.text || result?.content || ''

        // Strip any markdown code fences if LLM wraps it anyway
        const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')

        const parsed = JSON.parse(cleaned)
        const { userFacts, factTriples } = splitUserFacts(parsed.userFacts)
        return {
            date,
            userFacts,
            factTriples,
            decisions:     Array.isArray(parsed.decisions)     ? parsed.decisions     : [],
            learnings:     Array.isArray(parsed.learnings)     ? parsed.learnings     : [],
            openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
            mistakes:      Array.isArray(parsed.mistakes)      ? parsed.mistakes      : [],
            mood:          typeof parsed.mood       === 'string' ? parsed.mood       : '',
            diaryText:     typeof parsed.diaryText  === 'string' ? parsed.diaryText  : '',
        }
    } catch (e: any) {
        console.error(`[MemoryDistiller] LLM parse failed: ${e.message}`)
        return null
    }
}

/** userFacts may be plain sentences or {satz, beziehung, wert} objects. */
function splitUserFacts(raw: unknown): { userFacts: string[]; factTriples: DistilledFactTriple[] } {
    const userFacts: string[] = []
    const factTriples: DistilledFactTriple[] = []
    for (const item of Array.isArray(raw) ? raw : []) {
        if (typeof item === 'string') { userFacts.push(item); continue }
        if (!item || typeof item !== 'object') continue
        const fact = String((item as any).satz ?? (item as any).fact ?? '').trim()
        if (!fact) continue
        userFacts.push(fact)
        const predicate = String((item as any).beziehung ?? (item as any).predicate ?? '').trim()
        const value = String((item as any).wert ?? (item as any).value ?? '').trim()
        if (predicate && value) factTriples.push({ fact, predicate, value })
    }
    return { userFacts, factTriples }
}

// Fallback: rule-based extraction from journal entry
function extractFallback(entry: any, date: string): DistilledMemory {
    const learnings = entry.events
        .filter((e: any) => e.type === 'learning')
        .map((e: any) => e.summary.replace(/^Gelernt:\s*/i, ''))
        .slice(0, 8)

    const diaryText = entry.dailySummary ||
        `Am ${date} waren ${entry.events.length} Events, Topics: ${entry.topics.join(', ') || 'keine'}.`

    return {
        date,
        userFacts:     [],
        decisions:     [],
        learnings,
        openQuestions: [],
        mistakes:      [],
        mood:          'neutral',
        diaryText,
    }
}

// ── Diary Writer ──────────────────────────────────────────────────────────────

function writeDiary(memory: DistilledMemory): void {
    ensureDiaryDir()
    const path = join(DIARY_DIR, `${memory.date}.md`)

    const lines: string[] = [
        `# Nova Tagebuch — ${memory.date}`,
        '',
        `> 🌡️ ${memory.mood}`,
        '',
        '## Tagebucheintrag',
        '',
        memory.diaryText,
        '',
    ]

    if (memory.userFacts.length > 0) {
        lines.push('## Fakten über den User', '')
        memory.userFacts.forEach(f => lines.push(`- ${f}`))
        lines.push('')
    }

    if (memory.decisions.length > 0) {
        lines.push('## Entscheidungen', '')
        memory.decisions.forEach(d => lines.push(`- ${d}`))
        lines.push('')
    }

    if (memory.learnings.length > 0) {
        lines.push('## Erkenntnisse & Learnings', '')
        memory.learnings.forEach(l => lines.push(`- ${l}`))
        lines.push('')
    }

    if (memory.openQuestions.length > 0) {
        lines.push('## Offene Fragen / TODOs', '')
        memory.openQuestions.forEach(q => lines.push(`- ${q}`))
        lines.push('')
    }

    if (memory.mistakes && memory.mistakes.length > 0) {
        lines.push('## ⚠️ Fehler heute (zu vermeiden, NICHT wiederholen)', '')
        memory.mistakes.forEach(m => lines.push(`- ${m}`))
        lines.push('')
    }

    lines.push(`---\n*Destilliert am ${new Date().toISOString()} von Nova Memory Distiller*`)

    writeFileSync(path, lines.join('\n'))
    console.log(`[MemoryDistiller] 📔 Diary written: ${path}`)
}

// ── Session Reader — the REAL conversation source ──────────────────────────────

const SESSIONS_DIR = join(DATA_DIR, 'sessions')

interface PrincipalTranscript {
    principalId: string
    displayName: string
    transcript: string
}

/**
 * Read today's conversations from session JSONL files, grouped per canonical
 * principal. These are the raw, ground-truth conversations (logSession writes
 * them). Users are never merged into one transcript: each principal is
 * distilled on its own and only into its own memory scope.
 */
function readTodaysSessionsByPrincipal(date: string, config: any): PrincipalTranscript[] {
    if (!existsSync(SESSIONS_DIR)) return []

    const skipUsers = new Set(['nova-self', 'Nova-Autonomy', 'system', 'internal'])
    const byPrincipal = new Map<string, { displayName: string; blocks: string[] }>()

    for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.jsonl')) continue
        const userName = file.replace('.jsonl', '')
        if (skipUsers.has(userName)) continue

        try {
            const lines = readFileSync(join(SESSIONS_DIR, file), 'utf-8')
                .split('\n')
                .filter(l => l.trim())

            const todayLines = new Map<string, string[]>()
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line)
                    // Only today's messages
                    if (!entry.ts || !String(entry.ts).startsWith(date)) continue
                    const principalId = sessionLinePrincipal(config, userName, String(entry.channel || ''))
                    if (!principalId) continue
                    const role = entry.role === 'user' ? userName : 'Nova'
                    const bucket = todayLines.get(principalId) || []
                    bucket.push(`${role}: ${(entry.content || '').slice(0, 500)}`)
                    todayLines.set(principalId, bucket)
                } catch { /* skip malformed line */ }
            }

            for (const [principalId, bucket] of todayLines) {
                const current = byPrincipal.get(principalId) || { displayName: userName, blocks: [] }
                current.blocks.push(`=== Gespräch mit ${userName} ===\n${bucket.join('\n')}`)
                byPrincipal.set(principalId, current)
            }
        } catch { /* skip unreadable file */ }
    }

    return [...byPrincipal.entries()].map(([principalId, value]) => ({
        principalId,
        displayName: value.displayName,
        transcript: value.blocks.join('\n\n'),
    }))
}

// ── CORE_FACTS Writer — curated persistent facts ───────────────────────────────

/**
 * Merge distilled user facts into CORE_FACTS.json (deduplicated).
 * Only high-quality, LLM-curated facts reach this — never raw conversation.
 */
/**
 * Store distilled facts + learnings into LanceDB for associative recall.
 * Again: only curated content, never raw transcripts.
 */
async function storeGovernedMemory(memory: DistilledMemory, principalId: string, isOwner = false): Promise<number> {
    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        // Everything distilled from a principal's conversation stays in that
        // principal's scope. Nothing is promoted to `global` automatically:
        // a distilled "learning" can still carry private details.
        const scope = principalScope(principalId)
        let stored = 0

        for (const fact of memory.userFacts) {
            if (!isDurableMemoryCandidate(fact)) continue
            // Graph structure only in the owner's own context; governance
            // re-checks length and secrets and projects canonical records only.
            const triple = isOwner ? memory.factTriples?.find(item => item.fact === fact) : undefined
            const structure = triple ? structuredTriple({ subject: scope, predicate: triple.predicate, value: triple.value }) : null
            const record = await governance.record({
                content: fact,
                kind: 'fact',
                scope,
                source: `distiller:${memory.date}`,
                evidence: 'distillation',
                confidence: 0.85,
                verified: true,
                ...(structure || {}),
            })
            if (record) stored++
        }
        for (const learning of memory.learnings) {
            if (!isDurableMemoryCandidate(learning)) continue
            const record = await governance.record({
                content: learning,
                kind: 'learning',
                scope,
                source: `distiller:${memory.date}`,
                evidence: 'distillation',
                confidence: 0.8,
                verified: true,
            })
            if (record) stored++
        }
        return stored
    } catch (e: any) {
        console.warn(`[MemoryDistiller] Governance store failed: ${e.message}`)
        return 0
    }
}

// ── Main Distillation Run ─────────────────────────────────────────────────────

function mergeDistilledMemories(memories: DistilledMemory[], date: string): DistilledMemory {
    return {
        date,
        userFacts: memories.flatMap(item => item.userFacts),
        decisions: memories.flatMap(item => item.decisions),
        learnings: memories.flatMap(item => item.learnings),
        openQuestions: memories.flatMap(item => item.openQuestions),
        mistakes: memories.flatMap(item => item.mistakes),
        mood: memories.map(item => item.mood).find(Boolean) || '',
        diaryText: memories.map(item => item.diaryText).filter(Boolean).join('\n\n'),
    }
}

/**
 * Run the nightly distillation for a given date (default: yesterday at 02:00 = today's data).
 * At 02:00 AM we distill the day that just ended (= today in most cases).
 */
export async function runDistillation(
    llm: any | null,
    targetDate?: string
): Promise<DistilledMemory | null> {
    // At 02:00 AM we want "today" (the day that just passed midnight)
    const date = targetDate ?? getDateString()

    console.log(`[MemoryDistiller] 🌙 Starting nightly distillation for ${date}...`)

    // ── 1. Read TODAY'S CONVERSATIONS per principal (the ground truth) ─────────
    const config = readDistillerConfig()
    const ownerId = ownerPrincipalId(config)
    const transcripts = readTodaysSessionsByPrincipal(date, config)

    // Also load journal for tool stats / topics (supplementary)
    let entry: any = null
    try {
        const { getTodayEntry, getRecentEntries } = await import('../memory/journal.js')
        const today = getDateString()
        entry = date === today ? getTodayEntry() : (getRecentEntries(7).find((e: any) => e.date === date) || null)
    } catch { /* journal optional */ }

    // Need at least conversations OR journal events to distill
    if (transcripts.length === 0 && (!entry || entry.events?.length === 0)) {
        console.log(`[MemoryDistiller] No conversations or journal data for ${date} — skipping`)
        return null
    }

    if (!llm) {
        console.log('[MemoryDistiller] No LLM — skipping (curation needs LLM, no regex fallback to avoid garbage)')
        return null
    }

    // The journal is process-wide (all users' tool stats/topics). It is only
    // ever attached to the owner's own distillation.
    const technicalText = entry
        ? `\nTECHNISCHE EVENTS:\nTools genutzt: ${entry.toolsUsed?.join(', ') || 'keine'} | Fehler: ${entry.errorsEncountered || 0} | Topics: ${entry.topics?.join(', ') || 'keine'}`
        : ''
    if (technicalText && !transcripts.some(item => item.principalId === ownerId)) {
        transcripts.push({ principalId: ownerId, displayName: 'den Benutzer', transcript: '' })
    }

    // ── 2./3. Distill each principal separately and store into ITS scope ───────
    const distilled: Array<{ principalId: string; memory: DistilledMemory }> = []
    let governedStored = 0
    for (const item of transcripts) {
        const isOwner = item.principalId === ownerId
        const input = [
            item.transcript ? `GESPRÄCHE DES TAGES:\n${item.transcript.slice(0, 12000)}` : '',
            isOwner ? technicalText : '',
        ].filter(Boolean).join('\n')
        if (!input) continue
        const extracted = await extractWithLLM(llm, input, date, item.displayName)
        const principalMemory = extracted ?? (isOwner && entry ? extractFallback(entry, date) : null)
        if (!principalMemory) continue
        governedStored += await storeGovernedMemory(principalMemory, item.principalId, isOwner)
        distilled.push({ principalId: item.principalId, memory: principalMemory })
    }
    if (distilled.length === 0) {
        console.log('[MemoryDistiller] LLM extraction failed, no fallback data')
        return null
    }
    const memory = mergeDistilledMemories(distilled.map(item => item.memory), date)
    const ownerMemory = distilled.find(item => item.principalId === ownerId)?.memory

    // ── 4. Write diary (local operator artifact, not a prompt source) ─────────
    writeDiary(memory)

    // ── 4b. Governed records were written per principal above ─────────────────
    console.log(`[MemoryDistiller] 💾 Governed: ${governedStored} memory records evaluated for canonical projection`)

    // ── 4c. Record mistakes as anti-patterns (NOT as behavior) ─────────────────
    if (memory.mistakes.length > 0) {
        console.log(`[MemoryDistiller] ⚠️ ${memory.mistakes.length} Fehler erkannt (werden vermieden, nicht gelernt):`)
        memory.mistakes.forEach(m => console.log(`     - ${m}`))
        // Mistakes go into the diary only — they're context for self-awareness,
        // explicitly NOT stored as facts/behavior to avoid reinforcing them.
    }

    // ── 5. Push to Brain ──────────────────────────────────────────────────────
    // The legacy Brain export has no per-user scope, so it only ever receives
    // the owner's own distillation.
    const episodes: BrainEpisode[] = []
    const exported = ownerMemory ?? { userFacts: [], decisions: [], learnings: [] }

    exported.userFacts.forEach(f => episodes.push({
        content: f,
        type: 'fact',
        source: `nova-distiller:${date}`,
    }))

    exported.decisions.forEach(d => episodes.push({
        content: d,
        type: 'decision',
        source: `nova-distiller:${date}`,
    }))

    exported.learnings.forEach(l => episodes.push({
        content: l,
        type: 'learning',
        source: `nova-distiller:${date}`,
    }))

    // Diary text stays episodic and is not promoted to a durable fact.

    if (episodes.length > 0) {
        const { pushed, failed } = await pushToBrain(episodes, date)
        console.log(`[MemoryDistiller] 🧠 Brain: ${pushed}/${episodes.length} episodes stored (${failed} failed)`)
    } else {
        console.log('[MemoryDistiller] No episodes to push (empty extraction)')
    }

    // ── 6. Record in journal ──────────────────────────────────────────────────
    try {
        const { recordEvent } = await import('../memory/journal.js')
        recordEvent(
            'system',
            `Memory Distilled: ${memory.learnings.length} learnings, ${memory.userFacts.length} facts, ${memory.decisions.length} decisions`,
            memory.diaryText.slice(0, 200)
        )
    } catch { /* non-critical */ }

    console.log(`[MemoryDistiller] ✅ Distillation complete for ${date}`)
    return memory
}

// ── LLM Singleton (set by daemon, used by /distill command) ──────────────────

let _llm: any = null

export function setDistillerLlm(llm: any): void {
    _llm = llm
}

export function getDistillerLlm(): any {
    return _llm
}

// ── Cron Registration ─────────────────────────────────────────────────────────

/**
 * Register the nightly memory distillation cron job.
 * Called from daemon.ts after LLM and journal are initialized.
 *
 * Schedule: every day at 02:00 AM (Europe/Vienna)
 */
export async function initMemoryDistiller(llmGetter: () => any): Promise<void> {
    try {
        const { getCronerScheduler } = await import('../core/croner-scheduler.js')
        const scheduler = getCronerScheduler()

        await scheduler.schedule(
            'memory-distill-nightly',
            '0 2 * * *',        // 02:00 AM every day
            'Nightly Memory Distiller',
            async () => {
                const llm = llmGetter()
                await runDistillation(llm)
            }
        )

        console.log('[Nova] ✓ Memory Distiller 🌙 aktiv — läuft täglich um 02:00 Uhr (Europe/Vienna)')
    } catch (err: any) {
        console.warn(`[MemoryDistiller] Cron registration failed: ${err.message}`)
    }
}

export default { initMemoryDistiller, runDistillation }
