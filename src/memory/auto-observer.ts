/**
 * Nova Memory Auto-Observer
 * 
 * Automatically extracts facts, preferences, and key information
 * from every conversation and persists them in both VectorMemory
 * and LanceDB for fast, accurate recall.
 * 
 * Replaces the need for external observer.sh / reflector.sh scripts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDurableMemoryCandidate, memoryRelevance } from './memory-quality.js'
import { curateFacts } from './memory-curator.js'
import { getMemoryGovernanceCoordinator, type MemoryEvidence } from './memory-governance.js'

// ============================================
// Types
// ============================================

export interface ExtractedFact {
    id: string
    userId: string
    type: 'name' | 'preference' | 'project' | 'skill' | 'context' | 'instruction' | 'relationship'
    content: string
    source: string     // which message/session this came from
    confidence: number // 0-1 how confident we are
    createdAt: number
    accessCount: number
    lastAccessed: number
    governanceId?: string
    governanceStatus?: 'candidate' | 'verified' | 'canonical' | 'superseded' | 'rejected' | 'expired'
}

export interface ObserverConfig {
    dataDir: string
    maxFactsPerUser: number
    consolidationThreshold: number // consolidate when > N facts
    extractionPatterns: ExtractionPattern[]
}

interface ExtractionPattern {
    type: ExtractedFact['type']
    patterns: RegExp[]
    extractor: (match: RegExpMatchArray, full: string) => string
}

// ============================================
// Default Extraction Patterns
// ============================================

const DEFAULT_PATTERNS: ExtractionPattern[] = [
    {
        type: 'name',
        patterns: [
            /(?:ich (?:bin|heiße|heisse)|mein name ist|nennt? mich|I'?m called|my name is)\s+([A-Z][a-zäöüß]+(?:\s+[A-Z][a-zäöüß]+)?)/gi,
            /(?:merke?|remember|speicher)\s*(?:dir)?:?\s*.*?(?:name|heiße|bin)\s+([A-Z][a-zäöüß]+)/gi,
        ],
        extractor: (match) => `Name: ${match[1].trim()}`,
    },
    {
        type: 'preference',
        patterns: [
            /(?:ich (?:mag|bevorzuge|nutze|verwende|will)|I (?:prefer|like|use|want))\s+(.{3,60})/gi,
            /(?:benutze?|verwende?)\s+(?:immer|always)\s+(.{3,40})/gi,
            /(?:kein|keine|nie|never|nicht)\s+(.{3,30})\s+(?:verwenden|benutzen|nutzen|use)/gi,
        ],
        extractor: (match) => {
            const pref = match[1].trim()
            // Reject too-short or generic matches
            if (pref.split(/\s+/).length < 2) return ''
            return `Preference: ${pref}`
        },
    },
    {
        type: 'project',
        patterns: [
            /(?:ich (?:arbeite|baue|entwickle|programmiere) (?:an|auf)|I'?m (?:working on|building|developing))\s+(.{3,60})/gi,
            /(?:mein|unser|my|our)\s+(?:projekt|project|app|website|tool|server)\s+(?:ist|is|heißt|named?)?\s*(.{3,40})/gi,
            /(?:merke?|remember|speicher)\s*(?:dir)?:?\s*.*?(?:arbeite|project|baue)\s+(?:an\s+)?(.{3,60})/gi,
        ],
        extractor: (match) => `Project: ${match[1].trim()}`,
    },
    {
        type: 'skill',
        patterns: [
            /(?:ich (?:kann|kenne|beherrsche)|I (?:know|can use|am skilled in))\s+(.{3,40})/gi,
        ],
        extractor: (match) => `Skill: ${match[1].trim()}`,
    },
    {
        type: 'context',
        patterns: [
            /(?:mein|my)\s+(server|nas|rechner|computer|machine|laptop|desktop)\s+(?:ist|is|heißt|named?|läuft|runs)\s+(.{3,60})/gi,
            /(?:mein setup|my setup|meine? (?:infrastruktur|umgebung|architektur))\s+(?:ist|besteht|umfasst|hat)\s+(.{5,80})/gi,
        ],
        extractor: (match) => {
            const raw = match[0].trim()
            // Sentence-aware truncation (max 120 chars)
            let ctx = raw
            if (ctx.length > 120) {
                const cut = ctx.slice(0, 120)
                const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
                ctx = lastEnd > 40 ? ctx.slice(0, lastEnd + 1).trim() : cut.slice(0, cut.lastIndexOf(' ')).trim()
            }
            // Must mention something concrete (not just "ich habe gerade...")
            if (ctx.split(/\s+/).length < 4) return ''
            return `Context: ${ctx}`
        },
    },
    {
        type: 'relationship',
        patterns: [
            /(?:mein(?:e|er)?|my)\s+(hund|katze|partner|partnerin|frau|mann|sohn|tochter|bruder|schwester)\s+(?:hei(?:ß|ss)t|ist|is named)\s+([A-ZÄÖÜ][\p{L}-]{1,40})/giu,
        ],
        extractor: (match) => `Beziehung: ${match[0].trim()}`,
    },
    {
        type: 'instruction',
        patterns: [
            /(?:merke?|remember|speicher)\s*(?:dir)?:?\s*(.{5,120})/gi,
            /(?:vergiss? (?:das )?nie|never forget|wichtig|important):?\s*(.{5,120})/gi,
            /(?:ab jetzt|from now on|immer|always)\s+(.{5,80})/gi,
        ],
        extractor: (match) => match[1]?.trim() || match[0].trim(),
    },
]

// ============================================
// Auto-Observer Class
// ============================================

export class AutoObserver {
    private facts: Map<string, ExtractedFact[]> = new Map() // userId -> facts
    private dataDir: string
    private maxFactsPerUser: number
    private consolidationThreshold: number
    private patterns: ExtractionPattern[]
    private initialized = false

    constructor(config?: Partial<ObserverConfig>) {
        this.dataDir = config?.dataDir || join(process.cwd(), '.nova-data', 'observer')
        this.maxFactsPerUser = config?.maxFactsPerUser || 500
        this.consolidationThreshold = config?.consolidationThreshold || 200
        this.patterns = config?.extractionPatterns || DEFAULT_PATTERNS
    }

    async initialize(): Promise<void> {
        if (this.initialized) return

        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }

        this.loadFromDisk()
        let migrated = 0
        for (const facts of this.facts.values()) {
            for (const fact of facts) {
                if (fact.governanceId) continue
                const evidence: MemoryEvidence = fact.source === 'llm-deep-extract'
                    ? 'model_inference'
                    : fact.type === 'instruction' ? 'explicit_user_instruction' : 'user_statement'
                if (this.governFact(fact, evidence, false)) migrated++
            }
        }
        if (migrated > 0) this.saveToDisk()
        this.initialized = true
        console.log(`[Observer] ✅ Initialized with ${this.getTotalFacts()} facts`)
    }

    // ============================================
    // Core: Extract facts from a message
    // ============================================

    async observe(userId: string, message: string, role: 'user' | 'assistant', sessionId?: string): Promise<ExtractedFact[]> {
        if (!this.initialized) await this.initialize()

        const extracted: ExtractedFact[] = []

        for (const pattern of this.patterns) {
            for (const regex of pattern.patterns) {
                // Reset regex lastIndex for global patterns
                regex.lastIndex = 0
                let match: RegExpExecArray | null

                while ((match = regex.exec(message)) !== null) {
                    const content = pattern.extractor(match, message)

                    // Skip empty extractions (extractor rejected it)
                    const shortHighSignal = pattern.type === 'name' && content.length >= 5
                        || pattern.type === 'relationship' && content.length >= 12
                        || pattern.type === 'instruction' && content.length >= 10
                    if (!content || (!isDurableMemoryCandidate(content) && !shortHighSignal)) continue

                    // Don't store duplicates
                    if (this.isDuplicate(userId, content)) continue

                    const fact: ExtractedFact = {
                        id: crypto.randomUUID(),
                        userId,
                        type: pattern.type,
                        content,
                        source: sessionId || 'direct',
                        confidence: role === 'user' ? 0.9 : 0.6, // User statements > assistant inferences
                        createdAt: Date.now(),
                        accessCount: 0,
                        lastAccessed: Date.now(),
                    }

                    this.governFact(fact, role === 'user'
                        ? (/\b(?:merke|remember|speicher|vergiss(?: das)? nie)\b/i.test(message)
                            ? 'explicit_user_instruction' : 'user_statement')
                        : 'model_inference')

                    extracted.push(fact)
                }
            }
        }

        if (extracted.length > 0) {
            // Add to store
            if (!this.facts.has(userId)) this.facts.set(userId, [])
            const userFacts = this.facts.get(userId)!
            userFacts.push(...extracted)

            // Auto-register user alias when name is extracted for numeric IDs (e.g. Telegram)
            const nameFacts = extracted.filter(f => f.type === 'name')
            if (nameFacts.length > 0 && /^\d+$/.test(userId)) {
                try {
                    const configPath = join(process.cwd(), 'nova.config.json')
                    if (existsSync(configPath)) {
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                        if (!config.userAliases) config.userAliases = {}
                        // Extract clean name from "Name: Sample" format
                        const rawName = nameFacts[0].content.replace(/^Name:\s*/i, '').trim()
                        if (rawName && !config.userAliases[userId]) {
                            config.userAliases[userId] = rawName
                            writeFileSync(configPath, JSON.stringify(config, null, 2))
                            console.log(`[Observer] 🏷️ Auto-registered alias: ${userId} → ${rawName}`)
                        }
                    }
                } catch (err) {
                    console.error(`[Observer] Alias registration error: ${err}`)
                }
            }

            // Check if consolidation is needed
            if (userFacts.length > this.consolidationThreshold) {
                await this.consolidate(userId)
            }

            // Trim if too many
            if (userFacts.length > this.maxFactsPerUser) {
                this.trimFacts(userId)
            }

            this.saveToDisk()
            console.log(`[Observer] 📝 Extracted ${extracted.length} facts from ${role} (${extracted.map(f => f.type).join(', ')})`)

            // Personal observations remain local until explicitly curated.
        }

        // LLM Deep Extraction (async, non-blocking) — Nova decides what to remember
        if (role === 'user' && message.length > 50) {
            this.deepExtract(userId, message).catch(err =>
                console.debug('[Observer] Deep extract error:', err)
            )
        }

        return extracted
    }

    // ============================================
    // Recall: What do we know about this user?
    // ============================================

    recall(userId: string, query?: string): ExtractedFact[] {
        const userFacts = this.facts.get(userId) || []

        if (!query) return userFacts

        const queryLower = query.toLowerCase()
        const queryWords = new Set(queryLower.split(/\W+/).filter(w => w.length > 2))

        // Score and rank facts by relevance
        const scored = userFacts.map(fact => {
            const factLower = fact.content.toLowerCase()
            let score = 0

            // Direct substring match
            if (factLower.includes(queryLower)) score += 5

            // Word overlap
            const factWords = new Set(factLower.split(/\W+/).filter(w => w.length > 2))
            const overlap = [...queryWords].filter(w => factWords.has(w)).length
            score += overlap * 2

            // Type bonus for common queries
            if (queryLower.includes('name') && fact.type === 'name') score += 3
            if (queryLower.includes('projekt') && fact.type === 'project') score += 3
            if ((queryLower.includes('über mich') || queryLower.includes('about me')) && fact.type !== 'context') score += 2

            score += memoryRelevance(query, fact.content) * 4
            score *= fact.confidence

            return { fact, score }
        })

        // Update access counts
        const results = scored
            .filter(s => s.score >= 1.5 && isDurableMemoryCandidate(s.fact.content))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)

        for (const r of results) {
            r.fact.accessCount++
            r.fact.lastAccessed = Date.now()
        }

        if (results.length > 0) this.saveToDisk()

        return results.map(r => r.fact)
    }

    // ============================================
    // Recall for system prompt injection
    // ============================================

    getContextForPrompt(userId: string, currentMessage: string): string {
        const governance = getMemoryGovernanceCoordinator()
        const isTrusted = (fact: ExtractedFact) => Boolean(
            fact.governanceId && governance.isRecallable(fact.governanceId),
        )
        const facts = this.recall(userId, currentMessage).filter(isTrusted)
        const allFacts = (this.facts.get(userId) || []).filter(isTrusted)

        if (allFacts.length === 0) return ''

        const lines: string[] = ['## Was ich über den User weiß:']

        // Always include name and key facts
        const nameFacts = allFacts.filter(f => f.type === 'name')
        const projectFacts = facts.filter(f => f.type === 'project')
        const prefFacts = facts.filter(f => f.type === 'preference')
        const instructionFacts = facts.filter(f => f.type === 'instruction')

        if (nameFacts.length > 0) {
            lines.push(`- ${nameFacts.map(f => f.content).join(', ')}`)
        }
        if (projectFacts.length > 0) {
            lines.push(`- Projekte: ${projectFacts.map(f => f.content.replace('Project: ', '')).join(', ')}`)
        }
        if (prefFacts.length > 0) {
            lines.push(`- Präferenzen: ${prefFacts.slice(0, 3).map(f => f.content.replace('Preference: ', '')).join('; ')}`)
        }
        if (instructionFacts.length > 0) {
            lines.push(`- Anweisungen: ${instructionFacts.slice(0, 3).map(f => f.content).join('; ')}`)
        }

        // Add relevant context facts
        const contextFacts = facts.filter(f => f.type === 'context' || f.type === 'skill')
        if (contextFacts.length > 0) {
            lines.push(`- Kontext: ${contextFacts.slice(0, 3).map(f => f.content).join('; ')}`)
        }

        return lines.join('\n')
    }

    // ============================================
    // Consolidation: Merge similar/old facts
    // ============================================

    private async consolidate(userId: string): Promise<void> {
        const userFacts = this.facts.get(userId)
        if (!userFacts || userFacts.length < this.consolidationThreshold) return

        console.log(`[Observer] 🔄 Consolidating ${userFacts.length} facts for ${userId}`)

        const consolidated = curateFacts(userFacts)

        this.facts.set(userId, consolidated)
        console.log(`[Observer] ✅ Consolidated: ${userFacts.length} → ${consolidated.length} facts`)
    }

    // ============================================
    // LLM Deep Extraction — Nova decides what to remember
    // ============================================

    private lastDeepExtract: Map<string, number> = new Map()

    private async deepExtract(userId: string, message: string): Promise<void> {
        // Rate limit: max once per 2 minutes per user
        const lastTime = this.lastDeepExtract.get(userId) || 0
        if (Date.now() - lastTime < 120_000) return
        this.lastDeepExtract.set(userId, Date.now())

        try {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            const llm = await createNovaLLMClient({})

            const prompt = `Du bist ein Fakten-Extraktor. Analysiere die User-Nachricht und extrahiere NUR echte, persönliche Fakten über den User.

REGELN (STRIKT EINHALTEN!):
- Nur Fakten die der USER über SICH SELBST aussagt
- Jeder Fakt muss ein VOLLSTÄNDIGER Satz sein (min. 10 Zeichen)
- KEINE einzelnen Wörter, Fragmente oder abgeschnittenen Sätze
- KEINE technischen Logs, Fehlermeldungen oder Code-Snippets
- KEINE Fakten über Nova/AI/Bot selbst
- KEINE Emoji, Markdown-Syntax oder URLs in den Fakten
- Wenn die Nachricht nur Befehle, Code oder technisches enthält: antworte mit []

Kategorien: name, preference, project, skill, context, instruction, relationship

Nachricht: "${message.slice(0, 500).replace(/"/g, '\'')}"

Antworte NUR mit einem JSON-Array. Beispiel:
[{"type":"project","content":"Arbeitet an einer TypeScript-basierten AI namens Nova"},{"type":"preference","content":"Bevorzugt Dark Mode in allen Anwendungen"}]

Bei Unsicherheit oder wenn keine persönlichen Fakten erkennbar sind: []`

            const response = await llm.complete([
                { role: 'user', content: prompt },
            ])

            if (!response.content) return

            // Parse JSON from LLM response
            const jsonMatch = response.content.match(/\[[\s\S]*\]/)
            if (!jsonMatch) return

            const llmFacts = JSON.parse(jsonMatch[0]) as Array<{ type: string; content: string }>
            if (!Array.isArray(llmFacts) || llmFacts.length === 0) return

            const validTypes = ['name', 'preference', 'project', 'skill', 'context', 'instruction', 'relationship']
            let added = 0

            for (const f of llmFacts) {
                if (!validTypes.includes(f.type) || !f.content) continue
                if (this.isDuplicate(userId, f.content)) continue

                // Quality validation: reject garbage facts
                const content = f.content.trim()
                if (!isDurableMemoryCandidate(content)) continue
                if (content.split(/\s+/).length < 3) continue // Need at least 3 words
                if (/^[^a-zA-ZäöüÄÖÜß]{3,}/.test(content)) continue // Starts with non-letter garbage
                if (/[*#\[\]{}|<>]/.test(content)) continue // Contains markdown/code artifacts
                if (/https?:\/\//.test(content)) continue // Contains URLs
                if (content.split('').filter(c => /[\u{1F000}-\u{1FFFF}]/u.test(c)).length > 0) continue // Contains emoji
                // Reject tool/code output fragments
                if (/^(Tool|Name|Skill|Fact|Type|Source|Content):\s/.test(content)) continue
                if (/\.\.\.|update_memory|mich selbst|dein Schweizer/i.test(content)) continue
                if (content.includes('{') || content.includes('}') || content.includes('==>')) continue


                // Sentence-aware truncation (max 300 chars)
                let truncated = content
                if (truncated.length > 300) {
                    const cut = truncated.slice(0, 300)
                    const lastEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
                    truncated = lastEnd > 120 ? truncated.slice(0, lastEnd + 1).trim() : cut.slice(0, cut.lastIndexOf(' ')).trim()
                }

                const fact: ExtractedFact = {
                    id: crypto.randomUUID(),
                    userId,
                    type: f.type as ExtractedFact['type'],
                    content: truncated,
                    source: 'llm-deep-extract',
                    confidence: 0.7,
                    createdAt: Date.now(),
                    accessCount: 0,
                    lastAccessed: Date.now(),
                }

                this.governFact(fact, 'model_inference')

                if (!this.facts.has(userId)) this.facts.set(userId, [])
                this.facts.get(userId)!.push(fact)
                added++
            }

            if (added > 0) {
                console.log(`[Observer] 🧠 LLM Deep Extract: ${added} neue Fakten für ${userId}`)
            }

            // Persist facts immediately after extraction
            this.saveToDisk()
        } catch { /* LLM extraction is non-critical */ }
    }

    // ============================================
    // Helpers
    // ============================================

    private governFact(fact: ExtractedFact, evidence: MemoryEvidence, publish = true): boolean {
        try {
            const governance = getMemoryGovernanceCoordinator()
            const kind = fact.type === 'name' ? 'identity' : fact.type
            const value = fact.content.replace(/^(?:Name|Preference|Project|Skill|Context):\s*/i, '').trim()
            const record = governance.propose({
                content: fact.content,
                kind,
                scope: `user:${fact.userId}`,
                source: `observer:${fact.source}`,
                evidence,
                confidence: fact.confidence,
                timestamp: fact.createdAt,
                sessionId: fact.source,
                verified: evidence === 'user_statement' || evidence === 'explicit_user_instruction',
                subject: kind === 'identity' ? `user:${fact.userId}` : undefined,
                predicate: kind === 'identity' ? 'name' : undefined,
                value: kind === 'identity' ? value : undefined,
            })
            if (!record) return false
            fact.governanceId = record.id
            fact.governanceStatus = record.status
            if (publish && record.status !== 'candidate'
                && process.env.NOVA_NO_SIDE_EFFECTS !== '1'
                && process.env.NOVA_TEST_MODE !== '1') {
                void governance.publish(record.id).catch(() => { /* optional projection */ })
            }
            return true
        } catch { return false /* governance must never block conversation capture */ }
    }

    private isDuplicate(userId: string, content: string): boolean {
        const userFacts = this.facts.get(userId) || []
        return userFacts.some(f => this.similarity(f.content, content) > 0.85)
    }

    private similarity(a: string, b: string): number {
        const aLower = a.toLowerCase()
        const bLower = b.toLowerCase()
        if (aLower === bLower) return 1

        const aWords = new Set(aLower.split(/\W+/).filter(w => w.length > 2))
        const bWords = new Set(bLower.split(/\W+/).filter(w => w.length > 2))

        if (aWords.size === 0 || bWords.size === 0) return 0

        const intersection = [...aWords].filter(w => bWords.has(w)).length
        const union = new Set([...aWords, ...bWords]).size

        return intersection / union // Jaccard similarity
    }

    private trimFacts(userId: string): void {
        const userFacts = this.facts.get(userId)
        if (!userFacts) return

        // Access frequency cannot make a false memory more important.
        userFacts.sort((a, b) => {
            const weightA = a.confidence + (a.type === 'name' ? 2 : 0) + (a.type === 'instruction' ? 1 : 0)
            const weightB = b.confidence + (b.type === 'name' ? 2 : 0) + (b.type === 'instruction' ? 1 : 0)
            return weightB - weightA
        })

        this.facts.set(userId, userFacts.slice(0, this.maxFactsPerUser))
    }

    // ============================================
    // Persistence
    // ============================================

    private loadFromDisk(): void {
        try {
            const file = join(this.dataDir, 'facts.json')
            if (!existsSync(file)) return

            const data = JSON.parse(readFileSync(file, 'utf-8'))
            for (const [userId, facts] of Object.entries(data)) {
                this.facts.set(userId, facts as ExtractedFact[])
            }
        } catch (err) {
            console.error(`[Observer] Load error: ${err}`)
        }
    }

    saveToDisk(): void {
        try {
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true })
            }

            const data: Record<string, ExtractedFact[]> = {}
            for (const [userId, facts] of this.facts) {
                data[userId] = facts
            }

            writeFileSync(join(this.dataDir, 'facts.json'), JSON.stringify(data, null, 2))
        } catch (err) {
            console.error(`[Observer] Save error: ${err}`)
        }
    }

    // Stats
    getTotalFacts(): number {
        let total = 0
        for (const facts of this.facts.values()) {
            total += facts.length
        }
        return total
    }

    getUserFacts(userId: string): ExtractedFact[] {
        return this.facts.get(userId) || []
    }

    getStats() {
        const stats: Record<string, number> = {}
        for (const [userId, facts] of this.facts) {
            stats[userId] = facts.length
        }
        return {
            totalFacts: this.getTotalFacts(),
            userCount: this.facts.size,
            byUser: stats,
        }
    }
}

// ============================================
// Singleton
// ============================================

let observer: AutoObserver | null = null

export function getAutoObserver(): AutoObserver {
    if (!observer) {
        observer = new AutoObserver()
    }
    return observer
}

export default { AutoObserver, getAutoObserver }
