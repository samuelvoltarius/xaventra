/**
 * Durable, user-scoped conversation continuity.
 *
 * This is deliberately not a second long-term fact authority. It retains only
 * compact session state (goals, critical instructions and verified outcomes).
 * Canonical personal facts continue to belong to MemoryGovernanceCoordinator.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { sideEffectsDisabled } from '../core/side-effects.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { classifyMemoryQuery, memoryRelevance } from './memory-quality.js'
import { pullSharedMemory, pushSharedMemory, readNodeId } from './shared-memory.js'

export interface SessionSummary {
    projectContext: string
    criticalInstructions: string[]
    recentActions: string[]
    doNotTouch: string[]
    techStack: Record<string, string>
    openGoals: string[]
    verifiedOutcomes: string[]
    verifiedOutcomeRefs?: Record<string, string>
    decisions: string[]
    preferences: string[]
    uncertainties: string[]
    pendingClarification?: PendingClarification
    lastUserIntent: string
    lastChannel?: string
    lastUpdated: number
}

export interface PendingClarification {
    id: string
    originalRequest: string
    question: string
    missingFields: string[]
    createdAt: number
}

export interface VerifiedOutcomeToolEvidence {
    toolName: string
    result?: unknown
}

export interface ConversationTurn {
    role: 'user' | 'assistant'
    content: string
    timestamp: number
}

interface ContinuityStore {
    version: 1
    updatedAt: number
    sessions: Record<string, SessionSummary>
}

export interface AddTurnOptions {
    channel?: string
}

const MAX_RECENT_ACTIONS = 5
const MAX_OPEN_GOALS = 10
const MAX_CRITICAL_INSTRUCTIONS = 12
const MAX_DO_NOT_TOUCH = 12
const MAX_DECISIONS = 12
const MAX_PREFERENCES = 12
const MAX_UNCERTAINTIES = 8
const SHARED_SCOPE = 'session-continuity'

const CRITICAL_PATTERNS = [
    /(?:ändere|berühre|fass)\s+(?:niemals?|nicht)\s+(.+)/gi,
    /(?:lass|lasse)\s+(.+?)\s+(?:in ruhe|unverändert)/gi,
    /(?:wichtig|kritisch|achtung):\s*(.+)/gi,
    /(?:immer|stets)\s+(.+)/gi,
    /(?:nie|niemals)\s+(.+)/gi,
    /(?:never|don't|do not)\s+(?:touch|change|modify)\s+(.+)/gi,
    /(?:always|important|critical|warning):?\s*(.+)/gi,
]

const TECH_PATTERNS: Record<string, RegExp> = {
    'next.js': /next\.?js\s*(\d+(?:\.\d+)?)/i,
    nestjs: /nest\.?js\s*(\d+(?:\.\d+)?)/i,
    react: /react\s*(\d+(?:\.\d+)?)/i,
    typescript: /typescript\s*(\d+(?:\.\d+)?)/i,
    prisma: /prisma\s*(\d+(?:\.\d+)?)/i,
    node: /node\.?js?\s*(\d+(?:\.\d+)?)/i,
}

const GOAL_PATTERNS = [
    /(?:das\s+)?ziel\s+ist(?:,|:)?\s*(.{8,200})/i,
    /(?:wir|ich)\s+(?:müssen|muessen|möchte|moechte|will)\s+(.{8,200})/i,
    /^(?:bitte\s+)?(?:mach|mache|baue|implementiere|verbessere|repariere|fixe|prüfe)\s+(.{8,200})/i,
    /^(?:please\s+)?(?:build|implement|improve|fix|check)\s+(.{8,200})/i,
]

function emptySummary(): SessionSummary {
    return {
        projectContext: '',
        criticalInstructions: [],
        recentActions: [],
        doNotTouch: [],
        techStack: {},
        openGoals: [],
        verifiedOutcomes: [],
        decisions: [],
        preferences: [],
        uncertainties: [],
        lastUserIntent: '',
        lastUpdated: Date.now(),
    }
}

function cleanText(value: string, maxLength = 240): string {
    const cleaned = redactSecrets(String(value || ''))
        .replace(/\s+/g, ' ')
        .replace(/^[\s:;,.-]+|[\s]+$/g, '')
        .trim()
    if (!cleaned || cleaned.includes('[REDACTED')) return ''
    return cleaned.slice(0, maxLength)
}

function uniqueRecent(values: string[], additions: string[], limit: number): string[] {
    const next: string[] = []
    for (const value of [...values, ...additions]) {
        const cleaned = cleanText(value)
        if (!cleaned) continue
        const duplicate = next.findIndex(item =>
            item.toLowerCase() === cleaned.toLowerCase() || memoryRelevance(item, cleaned) >= 0.85)
        if (duplicate >= 0) next.splice(duplicate, 1)
        next.push(cleaned)
    }
    return next.slice(-limit)
}

function extractMatches(text: string, patterns: RegExp[]): string[] {
    const values: string[] = []
    for (const pattern of patterns) {
        pattern.lastIndex = 0
        for (const match of text.matchAll(pattern)) {
            const value = cleanText(match[1] || match[0], 200)
            if (value.length >= 6) values.push(value)
        }
    }
    return values
}

function extractDoNotTouch(text: string): string[] {
    return extractMatches(text, [
        /(?:ändere|berühre|fass)\s+(?:niemals?|nicht)\s+([^\s,]+(?:\.[a-z0-9]+)?)/gi,
        /(?:don't|do not|never)\s+(?:touch|change|modify)\s+([^\s,]+(?:\.[a-z0-9]+)?)/gi,
        /leave\s+([^\s,]+(?:\.[a-z0-9]+)?)\s+(?:alone|unchanged)/gi,
    ])
}

function extractGoal(text: string): string {
    if (text.trim().endsWith('?')) return ''
    for (const pattern of GOAL_PATTERNS) {
        const match = text.match(pattern)
        const goal = cleanText(match?.[1] || '', 220)
        if (goal.length >= 8) return goal
    }
    return ''
}

function extractProjectContext(text: string): string {
    const match = text.match(
        /(?:ich\s+(?:arbeite|baue|entwickle)\s+(?:an|auf)|unser(?:e|er)?\s+(?:projekt|system)|our project)\s+(.{8,220})/i,
    )
    return cleanText(match?.[1] || '', 240)
}

export class SessionContinuityStore {
    private readonly path: string
    private readonly sessions = new Map<string, SessionSummary>()
    private readonly turnHistory = new Map<string, ConversationTurn[]>()
    private readonly backfilled = new Set<string>()

    constructor(path = getNovaDataDir('memory', 'session-continuity.json')) {
        this.path = path
        this.load()
    }

    private load(): void {
        try {
            if (!existsSync(this.path)) return
            const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ContinuityStore
            for (const [id, value] of Object.entries(parsed.sessions || {})) {
                this.sessions.set(id, { ...emptySummary(), ...value })
            }
        } catch {
            // A damaged optional continuity cache must not block canonical memory.
            this.sessions.clear()
        }
    }

    private persist(): void {
        const sessions = Object.fromEntries(this.sessions)
        atomicWriteJsonSync(this.path, { version: 1, updatedAt: Date.now(), sessions } satisfies ContinuityStore)
    }

    addTurn(sessionId: string, role: 'user' | 'assistant', content: string, options: AddTurnOptions = {}): void {
        const safeId = cleanText(sessionId, 160)
        const safeContent = cleanText(content, 500)
        if (!safeId || !safeContent) return

        const history = this.turnHistory.get(safeId) || []
        history.push({ role, content: safeContent, timestamp: Date.now() })
        this.turnHistory.set(safeId, history.slice(-20))
        if (role !== 'user') return

        const summary = this.getOrCreate(safeId)
        this.applyUserContent(summary, safeContent, options.channel)
        this.sessions.set(safeId, summary)
        this.persist()
        void this.publishShared(safeId, summary)
    }

    private applyUserContent(summary: SessionSummary, safeContent: string, channel?: string): void {
        summary.criticalInstructions = uniqueRecent(
            summary.criticalInstructions,
            extractMatches(safeContent, CRITICAL_PATTERNS),
            MAX_CRITICAL_INSTRUCTIONS,
        )
        summary.doNotTouch = uniqueRecent(
            summary.doNotTouch,
            extractDoNotTouch(safeContent),
            MAX_DO_NOT_TOUCH,
        )
        for (const [technology, pattern] of Object.entries(TECH_PATTERNS)) {
            const match = safeContent.match(pattern)
            if (match?.[1]) summary.techStack[technology] = match[1]
        }
        const project = extractProjectContext(safeContent)
        if (project) summary.projectContext = project
        const goal = extractGoal(safeContent)
        if (goal) summary.openGoals = uniqueRecent(summary.openGoals, [goal], MAX_OPEN_GOALS)
        const decision = cleanText(safeContent.match(/(?:wir\s+(?:machen|nehmen|nutzen)|entschieden(?:,|:)?|entscheidung(?:,|:)?|we(?:'ll| will)\s+(?:use|take))\s+(.{5,220})/i)?.[1] || '')
        if (decision) summary.decisions = uniqueRecent(summary.decisions, [decision], MAX_DECISIONS)
        const preference = cleanText(safeContent.match(/(?:ich\s+(?:bevorzuge|mag|will)|bitte\s+immer|prefer(?:ence)?(?:,|:)?|i prefer)\s+(.{5,220})/i)?.[1] || '')
        if (preference) summary.preferences = uniqueRecent(summary.preferences, [preference], MAX_PREFERENCES)
        summary.lastUserIntent = safeContent.slice(0, 240)
        summary.lastChannel = cleanText(channel || '', 40) || summary.lastChannel
        summary.lastUpdated = Date.now()
    }

    backfillFromSessionLogs(principalId: string, legacyNames: string[]): number {
        const safeId = cleanText(principalId, 160)
        if (!safeId || this.backfilled.has(safeId)) return 0
        this.backfilled.add(safeId)
        const summary = this.getOrCreate(safeId)
        const sessionDir = getNovaDataDir('sessions')
        let imported = 0

        for (const name of [...new Set(legacyNames.map(value =>
            String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_')).filter(Boolean))]) {
            const path = join(sessionDir, `${name}.jsonl`)
            if (!existsSync(path)) continue
            try {
                const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-200)
                for (const line of lines) {
                    const entry = JSON.parse(line) as { role?: string; content?: string; channel?: string }
                    if (entry.role !== 'user' || !entry.content) continue
                    const safeContent = cleanText(entry.content, 500)
                    if (!safeContent) continue
                    this.applyUserContent(summary, safeContent, entry.channel)
                    imported++
                }
            } catch { /* a malformed legacy line must not block newer state */ }
        }
        if (imported > 0) {
            this.sessions.set(safeId, summary)
            this.persist()
            void this.publishShared(safeId, summary)
        }
        return imported
    }

    recordVerifiedOutcome(
        sessionId: string,
        request: string,
        tools: VerifiedOutcomeToolEvidence[],
        runId?: string,
    ): void {
        const safeId = cleanText(sessionId, 160)
        if (!safeId || tools.length === 0) return
        const summary = this.getOrCreate(safeId)
        const requestText = cleanText(request, 180)
        const toolText = [...new Set(tools.map(tool => cleanText(tool.toolName, 50)).filter(Boolean))].slice(0, 6).join(', ')
        const evidenceText = tools.flatMap(tool => {
            if (tool.result === undefined || tool.result === null) return []
            let rendered = ''
            if (typeof tool.result === 'string') rendered = tool.result
            else {
                try { rendered = JSON.stringify(tool.result) }
                catch { rendered = String(tool.result) }
            }
            const safe = cleanText(redactSecrets(rendered), 120)
            return safe ? [`${cleanText(tool.toolName, 40)}=${safe}`] : []
        }).slice(0, 3).join('; ')
        const outcome = cleanText(`${requestText} → verifiziert mit ${toolText}${evidenceText ? `: ${evidenceText}` : ''}`, 320)
        if (!outcome) return

        summary.verifiedOutcomes = uniqueRecent(summary.verifiedOutcomes, [outcome], MAX_RECENT_ACTIONS)
        summary.recentActions = uniqueRecent(summary.recentActions, [outcome], MAX_RECENT_ACTIONS)
        if (runId) summary.verifiedOutcomeRefs = { ...(summary.verifiedOutcomeRefs || {}), [runId]: outcome }
        summary.openGoals = summary.openGoals.filter(goal =>
            memoryRelevance(goal, requestText) < 0.45 && memoryRelevance(goal, evidenceText) < 0.45)
        summary.lastUpdated = Date.now()
        this.sessions.set(safeId, summary)
        this.persist()
        void this.publishShared(safeId, summary)
    }

    retractVerifiedOutcome(sessionId: string, runId: string, request = ''): boolean {
        const summary = this.sessions.get(sessionId)
        if (!summary) return false
        const referenced = summary.verifiedOutcomeRefs?.[runId]
        const normalizedRequest = cleanText(request, 180)
        const matches = (value: string) => value === referenced
            || (normalizedRequest.length >= 6 && value.startsWith(`${normalizedRequest} →`))
        const previous = summary.verifiedOutcomes.length + summary.recentActions.length
        summary.verifiedOutcomes = summary.verifiedOutcomes.filter(value => !matches(value))
        summary.recentActions = summary.recentActions.filter(value => !matches(value))
        if (summary.verifiedOutcomeRefs) delete summary.verifiedOutcomeRefs[runId]
        if (previous === summary.verifiedOutcomes.length + summary.recentActions.length) return false
        summary.lastUpdated = Date.now()
        this.persist()
        void this.publishShared(sessionId, summary)
        return true
    }

    getSessionPrompt(sessionId: string, query = ''): string {
        const summary = this.sessions.get(sessionId)
        if (!summary) return ''
        const intent = classifyMemoryQuery(query)
        const continuityRequested = intent === 'continuity' || intent === 'overview'
        const parts: string[] = []

        if (summary.projectContext
            && (continuityRequested || memoryRelevance(query, summary.projectContext) > 0)) {
            parts.push(`Projektkontext: ${summary.projectContext}`)
        }
        if (summary.criticalInstructions.length > 0) {
            parts.push(`Kritische Anweisungen:\n${summary.criticalInstructions.map(item => `- ${item}`).join('\n')}`)
        }
        if (summary.doNotTouch.length > 0) {
            parts.push(`Nicht ändern:\n${summary.doNotTouch.map(item => `- ${item}`).join('\n')}`)
        }
        if (Object.keys(summary.techStack).length > 0
            && (continuityRequested || /code|stack|version|projekt|project/i.test(query))) {
            parts.push(`Tech-Stack: ${Object.entries(summary.techStack).map(([key, value]) => `${key} ${value}`).join(', ')}`)
        }
        const goals = summary.openGoals.filter(goal =>
            continuityRequested || memoryRelevance(query, goal) > 0)
        if (goals.length > 0) parts.push(`Offene Vorhaben:\n${goals.slice(-5).map(goal => `- ${goal}`).join('\n')}`)
        if (continuityRequested && summary.verifiedOutcomes.length > 0) {
            parts.push(`Zuletzt verifizierte Ergebnisse:\n${summary.verifiedOutcomes.slice(-3).map(item => `- ${item}`).join('\n')}`)
        }
        if (summary.decisions.length > 0 && (continuityRequested || /entscheidung|warum|weiter|fortsetzen/i.test(query))) {
            parts.push(`Getroffene Entscheidungen:\n${summary.decisions.slice(-5).map(item => `- ${item}`).join('\n')}`)
        }
        if (summary.preferences.length > 0) {
            parts.push(`Nutzerpräferenzen:\n${summary.preferences.slice(-5).map(item => `- ${item}`).join('\n')}`)
        }
        if (parts.length === 0) return ''
        return ['## Persistente Gesprächskontinuität', ...parts].join('\n').slice(0, 2600)
    }

    getSummary(sessionId: string): SessionSummary | undefined {
        const value = this.sessions.get(sessionId)
        return value ? JSON.parse(JSON.stringify(value)) : undefined
    }

    setPendingClarification(sessionId: string, clarification: PendingClarification): void {
        const summary = this.getOrCreate(sessionId)
        summary.pendingClarification = {
            ...clarification,
            originalRequest: cleanText(clarification.originalRequest, 500),
            question: cleanText(clarification.question, 300),
            missingFields: clarification.missingFields.map(value => cleanText(value, 80)).filter(Boolean).slice(0, 5),
        }
        summary.uncertainties = uniqueRecent(summary.uncertainties, clarification.missingFields, MAX_UNCERTAINTIES)
        summary.lastUpdated = Date.now()
        this.sessions.set(sessionId, summary)
        this.persist()
        void this.publishShared(sessionId, summary)
    }

    consumePendingClarification(sessionId: string): PendingClarification | undefined {
        const summary = this.sessions.get(sessionId)
        if (!summary?.pendingClarification) return undefined
        const pending = { ...summary.pendingClarification }
        delete summary.pendingClarification
        summary.uncertainties = summary.uncertainties.filter(value => !pending.missingFields.includes(value))
        summary.lastUpdated = Date.now()
        this.sessions.set(sessionId, summary)
        this.persist()
        void this.publishShared(sessionId, summary)
        return pending
    }

    clearPendingClarification(sessionId: string): boolean {
        const summary = this.sessions.get(sessionId)
        if (!summary?.pendingClarification) return false
        delete summary.pendingClarification
        summary.lastUpdated = Date.now()
        this.persist()
        void this.publishShared(sessionId, summary)
        return true
    }

    forget(sessionId: string, query: string, all = false): number {
        const summary = this.sessions.get(sessionId)
        if (!summary) return 0
        const next = all ? emptySummary() : { ...summary }
        let removed = 0
        const matches = (value: string) =>
            value.toLowerCase().includes(query.toLowerCase())
            || memoryRelevance(query, value) > 0
        const filter = (items: string[]) => items.filter(item => {
            if (!matches(item)) return true
            removed++
            return false
        })

        if (all) {
            removed = summary.criticalInstructions.length + summary.recentActions.length
                + summary.doNotTouch.length + summary.openGoals.length + summary.verifiedOutcomes.length
                + summary.decisions.length + summary.preferences.length + summary.uncertainties.length
                + Object.keys(summary.techStack).length + (summary.projectContext ? 1 : 0)
        } else {
            next.criticalInstructions = filter(summary.criticalInstructions)
            next.recentActions = filter(summary.recentActions)
            next.doNotTouch = filter(summary.doNotTouch)
            next.openGoals = filter(summary.openGoals)
            next.verifiedOutcomes = filter(summary.verifiedOutcomes)
            next.decisions = filter(summary.decisions)
            next.preferences = filter(summary.preferences)
            next.uncertainties = filter(summary.uncertainties)
            if (summary.projectContext && matches(summary.projectContext)) {
                next.projectContext = ''
                removed++
            }
            next.techStack = Object.fromEntries(Object.entries(summary.techStack).filter(([key, value]) => {
                if (!matches(`${key} ${value}`)) return true
                removed++
                return false
            }))
        }
        if (removed === 0 && !all) return 0
        next.lastUserIntent = ''
        next.lastUpdated = Date.now()
        this.sessions.set(sessionId, next)
        this.persist()
        void this.publishShared(sessionId, next)
        return removed
    }

    setProjectContext(sessionId: string, context: string): void {
        const safe = cleanText(context, 500)
        if (!safe) return
        const summary = this.getOrCreate(sessionId)
        summary.projectContext = safe
        summary.lastUpdated = Date.now()
        this.sessions.set(sessionId, summary)
        this.persist()
    }

    addDoNotTouch(sessionId: string, path: string): void {
        const summary = this.getOrCreate(sessionId)
        summary.doNotTouch = uniqueRecent(summary.doNotTouch, [path], MAX_DO_NOT_TOUCH)
        summary.lastUpdated = Date.now()
        this.sessions.set(sessionId, summary)
        this.persist()
    }

    getStats(): { sessions: number; openGoals: number; verifiedOutcomes: number; path: string } {
        const values = [...this.sessions.values()]
        return {
            sessions: values.length,
            openGoals: values.reduce((sum, value) => sum + value.openGoals.length, 0),
            verifiedOutcomes: values.reduce((sum, value) => sum + value.verifiedOutcomes.length, 0),
            path: dirname(this.path),
        }
    }

    async hydrateShared(): Promise<number> {
        if (sideEffectsDisabled()) return 0
        const entries = await pullSharedMemory({ scope: SHARED_SCOPE, limit: 500 })
        let merged = 0
        for (const entry of entries) {
            if (entry.metadata?.format !== 'nova-session-continuity-v1') continue
            const hash = createHash('sha256').update(entry.content).digest('hex').slice(0, 24)
            if (entry.metadata?.hash !== hash) continue
            try {
                const payload = JSON.parse(entry.content) as {
                    version: number
                    principalId: string
                    summary: SessionSummary
                }
                if (payload.version !== 1 || !payload.principalId || !payload.summary) continue
                if (payload.principalId !== entry.userId) continue
                const local = this.sessions.get(payload.principalId)
                if (local && local.lastUpdated >= payload.summary.lastUpdated) continue
                this.sessions.set(payload.principalId, { ...emptySummary(), ...payload.summary })
                merged++
            } catch { /* malformed remote continuity is ignored */ }
        }
        if (merged > 0) this.persist()
        return merged
    }

    private async publishShared(principalId: string, summary: SessionSummary): Promise<void> {
        if (sideEffectsDisabled()) return
        const content = JSON.stringify({ version: 1, principalId, summary })
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 24)
        await pushSharedMemory({
            id: `session_continuity_${createHash('sha256').update(principalId).digest('hex').slice(0, 24)}`,
            userId: principalId,
            role: 'system',
            content,
            timestamp: summary.lastUpdated,
            sourceNode: readNodeId(),
            scope: SHARED_SCOPE,
            keywords: ['session-continuity', 'goals', 'verified-outcomes'],
            metadata: { format: 'nova-session-continuity-v1', hash },
        })
    }

    private getOrCreate(sessionId: string): SessionSummary {
        return this.sessions.get(sessionId) || emptySummary()
    }
}

let continuityStore: SessionContinuityStore | null = null

export function getSessionContinuityStore(): SessionContinuityStore {
    if (!continuityStore) continuityStore = new SessionContinuityStore()
    return continuityStore
}

export function setSessionContinuityStore(store: SessionContinuityStore): void {
    continuityStore = store
}

export function addTurn(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    options: AddTurnOptions = {},
): void {
    getSessionContinuityStore().addTurn(sessionId, role, content, options)
}

export function recordVerifiedOutcome(
    sessionId: string,
    request: string,
    tools: VerifiedOutcomeToolEvidence[],
    runId?: string,
): void {
    getSessionContinuityStore().recordVerifiedOutcome(sessionId, request, tools, runId)
}

export function setProjectContext(sessionId: string, context: string): void {
    getSessionContinuityStore().setProjectContext(sessionId, context)
}

export function getSessionPrompt(sessionId: string, query = ''): string {
    return getSessionContinuityStore().getSessionPrompt(sessionId, query)
}

export function getSummary(sessionId: string): SessionSummary | undefined {
    return getSessionContinuityStore().getSummary(sessionId)
}

export function addDoNotTouch(sessionId: string, path: string): void {
    getSessionContinuityStore().addDoNotTouch(sessionId, path)
}

export default {
    addTurn,
    recordVerifiedOutcome,
    setProjectContext,
    getSessionPrompt,
    getSummary,
    addDoNotTouch,
    getSessionContinuityStore,
}
