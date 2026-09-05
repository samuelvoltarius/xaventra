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
import { principalScope, resolvePrincipalId } from '../users/principal-id.js'
import { resolveConfigPath } from '../config/config-path.js'


// ── Types ─────────────────────────────────────────────────────────────────────

export interface DistilledMemory {
    date: string
    userFacts: string[]        // Persistent facts about the user(s)
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

function ownerMemoryScope(): string {
    try {
        const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
        const owner = String(config.channels?.telegram?.allowFrom?.[0]
            || config.channels?.whatsapp?.allowFrom?.[0] || 'owner')
        return principalScope(resolvePrincipalId(config, 'telegram', owner))
    } catch {
        return principalScope('owner')
    }
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
    date: string
): Promise<DistilledMemory | null> {
    const prompt = `Du bist Nova, eine autonome KI-Assistentin. Heute ist ${date}.

Analysiere die heutigen Gespräche und destilliere NUR echtes, dauerhaftes Wissen.

KRITISCHE REGELN für die Extraktion:
- userFacts: NUR dauerhafte Fakten über Sample (Name, Hardware, Projekte, Vorlieben, Haustiere, Familie).
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
  "userFacts": ["Dauerhafte Fakten über Sample — vollständige Sätze — max 6, lieber weniger und gut"],
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
        return {
            date,
            userFacts:     Array.isArray(parsed.userFacts)     ? parsed.userFacts     : [],
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

/**
 * Read today's conversations from session JSONL files.
 * These are the raw, ground-truth conversations (logSession writes them).
 * Returns a clean transcript per real user (skips system/autonomy identities).
 */
function readTodaysSessions(date: string): string {
    if (!existsSync(SESSIONS_DIR)) return ''

    const skipUsers = new Set(['nova-self', 'Nova-Autonomy', 'system', 'internal'])
    const transcripts: string[] = []

    for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith('.jsonl')) continue
        const userName = file.replace('.jsonl', '')
        if (skipUsers.has(userName)) continue

        try {
            const lines = readFileSync(join(SESSIONS_DIR, file), 'utf-8')
                .split('\n')
                .filter(l => l.trim())

            const todayLines: string[] = []
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line)
                    // Only today's messages
                    if (entry.ts && entry.ts.startsWith(date)) {
                        const role = entry.role === 'user' ? userName : 'Nova'
                        todayLines.push(`${role}: ${(entry.content || '').slice(0, 500)}`)
                    }
                } catch { /* skip malformed line */ }
            }

            if (todayLines.length > 0) {
                transcripts.push(`=== Gespräch mit ${userName} ===\n${todayLines.join('\n')}`)
            }
        } catch { /* skip unreadable file */ }
    }

    return transcripts.join('\n\n')
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
async function storeGovernedMemory(memory: DistilledMemory): Promise<number> {
    try {
        const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const ownerScope = ownerMemoryScope()
        let stored = 0

        for (const fact of memory.userFacts) {
            if (!isDurableMemoryCandidate(fact)) continue
            const record = await governance.record({
                content: fact,
                kind: 'fact',
                scope: ownerScope,
                source: `distiller:${memory.date}`,
                evidence: 'distillation',
                confidence: 0.85,
                verified: true,
            })
            if (record) stored++
        }
        for (const learning of memory.learnings) {
            if (!isDurableMemoryCandidate(learning)) continue
            const record = await governance.record({
                content: learning,
                kind: 'learning',
                scope: 'global',
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

    // ── 1. Read TODAY'S CONVERSATIONS from sessions (the ground truth) ──────────
    const sessionText = readTodaysSessions(date)

    // Also load journal for tool stats / topics (supplementary)
    let entry: any = null
    try {
        const { getTodayEntry, getRecentEntries } = await import('../memory/journal.js')
        const today = getDateString()
        entry = date === today ? getTodayEntry() : (getRecentEntries(7).find((e: any) => e.date === date) || null)
    } catch { /* journal optional */ }

    // Need at least conversations OR journal events to distill
    if (!sessionText && (!entry || entry.events?.length === 0)) {
        console.log(`[MemoryDistiller] No conversations or journal data for ${date} — skipping`)
        return null
    }

    // ── 2. Build distillation input — conversations are primary ────────────────
    const journalText = [
        sessionText ? `GESPRÄCHE DES TAGES:\n${sessionText.slice(0, 12000)}` : '',
        entry ? `\nTECHNISCHE EVENTS:\nTools genutzt: ${entry.toolsUsed?.join(', ') || 'keine'} | Fehler: ${entry.errorsEncountered || 0} | Topics: ${entry.topics?.join(', ') || 'keine'}` : '',
    ].filter(Boolean).join('\n')

    // ── 3. Extract structured knowledge via LLM ────────────────────────────────
    let memory: DistilledMemory

    if (llm) {
        const extracted = await extractWithLLM(llm, journalText, date)
        memory = extracted ?? (entry ? extractFallback(entry, date) : null as any)
        if (!memory) { console.log('[MemoryDistiller] LLM extraction failed, no fallback data'); return null }
    } else {
        console.log('[MemoryDistiller] No LLM — skipping (curation needs LLM, no regex fallback to avoid garbage)')
        return null
    }

    // ── 4. Write diary ────────────────────────────────────────────────────────
    writeDiary(memory)

    // ── 4b. PERSIST curated facts → CORE_FACTS + LanceDB ───────────────────────
    const governedStored = await storeGovernedMemory(memory)
    console.log(`[MemoryDistiller] 💾 Governed: ${governedStored} memory records evaluated for canonical projection`)

    // ── 4c. Record mistakes as anti-patterns (NOT as behavior) ─────────────────
    if (memory.mistakes.length > 0) {
        console.log(`[MemoryDistiller] ⚠️ ${memory.mistakes.length} Fehler erkannt (werden vermieden, nicht gelernt):`)
        memory.mistakes.forEach(m => console.log(`     - ${m}`))
        // Mistakes go into the diary only — they're context for self-awareness,
        // explicitly NOT stored as facts/behavior to avoid reinforcing them.
    }

    // ── 5. Push to Brain ──────────────────────────────────────────────────────
    const episodes: BrainEpisode[] = []

    memory.userFacts.forEach(f => episodes.push({
        content: f,
        type: 'fact',
        source: `nova-distiller:${date}`,
    }))

    memory.decisions.forEach(d => episodes.push({
        content: d,
        type: 'decision',
        source: `nova-distiller:${date}`,
    }))

    memory.learnings.forEach(l => episodes.push({
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
