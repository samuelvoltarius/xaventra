/**
 * Xaventra - Learning Engine (nur Korrekturen)
 *
 * Erkennt Feedback in Owner-Nachrichten und merkt sich Korrekturen für die
 * Frage, die sie korrigieren. Mehr nicht: Skills entstehen nur noch in
 * learning/routine-skills.ts, Werkzeuge nur in tools/skill-builder.ts,
 * Prozeduren nur in learning/procedure-store.ts.
 *
 * P9 (01.10.2026): die frühere Muster-/Skill-Erzeugung (PatternDetector,
 * SkillGenerator) erzeugte Müll-Skills wie „Skill: ja bitte“ und teilte sich
 * `.nova-learning/skills.json` mit L7 in einem anderen Format. Beides ist
 * weg; vorhandene `skills.json`/`patterns.json` werden beim Start einmal als
 * `*.stillgelegt` umbenannt (nicht gelöscht).
 */

import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises'
import { join } from 'node:path'

import { FeedbackCollector, type Feedback, type FeedbackType } from './feedback.js'

export interface LearningConfig {
    dataDir: string
    persistInterval: number            // Auto-save interval in ms (0 = disabled)
}

export interface LearningStats {
    feedback: {
        total: number
        corrections: number
        positive: number
        negative: number
    }
}

export interface LearnedResponse {
    response: string
    source: 'correction'
    confidence: number
}

/** Frühere Dateien der Muster-/Skill-Erzeugung (nicht mehr geschrieben). */
const RETIRED_FILES = ['skills.json', 'patterns.json']

export class LearningEngine {
    private feedback: FeedbackCollector
    private config: LearningConfig
    private persistTimer?: NodeJS.Timeout
    private lastBotResponses = new Map<string, string>()
    private lastUserMessages = new Map<string, string>()

    constructor(config: Partial<LearningConfig> = {}) {
        this.config = {
            dataDir: '.nova-learning',
            persistInterval: 60000,
            ...config,
        }
        this.feedback = new FeedbackCollector()
    }

    async start(): Promise<void> {
        await this.retireLegacyFiles()
        await this.load()
        if (this.config.persistInterval > 0) {
            this.persistTimer = setInterval(() => {
                this.persist().catch(console.error)
            }, this.config.persistInterval)
            this.persistTimer.unref?.()
        }
        const stats = this.getStats()
        console.log(`[Learning] Korrektur-Lernen aktiv: ${stats.feedback.total} Feedback, ${stats.feedback.corrections} Korrekturen`)
    }

    async stop(): Promise<void> {
        if (this.persistTimer) clearInterval(this.persistTimer)
        await this.persist()
    }

    /**
     * Owner-Nachricht verarbeiten: Feedback erkennen und, falls für genau
     * diese Frage eine Korrektur gespeichert ist, die Korrektur liefern.
     */
    processUserMessage(message: string, context?: { channel?: string; userId?: string }): LearnedResponse | null {
        const scope = context?.userId || 'global'
        const previousUserMessage = this.lastUserMessages.get(scope)
        this.lastUserMessages.set(scope, message)

        const feedbackType = this.feedback.detectFeedbackType(message)
        if (feedbackType) this.handleFeedback(feedbackType, message, context, previousUserMessage)

        // A correction message is new input for the LLM, never answered from
        // the store in the same call.
        if (feedbackType === 'correction') return null
        const correctionResponse = this.feedback.getLearnedResponse(message, context?.userId)
        return correctionResponse ? { response: correctionResponse, source: 'correction', confidence: 0.9 } : null
    }

    recordBotResponse(response: string, context?: { channel?: string; userId?: string }): void {
        this.lastBotResponses.set(context?.userId || 'global', response)
    }

    private handleFeedback(type: FeedbackType, message: string, context?: { channel?: string; userId?: string }, previousUserMessage?: string): void {
        let correction: string | undefined
        if (type === 'correction') {
            const patterns = [
                /eigentlich\s*(?:ist|war|sollte)?\s*(.+)/i,
                /richtig\s*(?:ist|wäre)?\s*[:.]?\s*(.+)/i,
                /korrektur\s*[:.]?\s*(.+)/i,
                /nein,?\s*(.+)/i,
            ]
            for (const pattern of patterns) {
                const match = message.match(pattern)
                if (match?.[1]) {
                    correction = match[1].trim()
                    break
                }
            }
        }
        // A correction belongs to the question it corrects (the previous user
        // message), not to the correction text itself — otherwise the next
        // lookup echoes the correction back instead of acting on it.
        if (type === 'correction' && !previousUserMessage) correction = undefined

        this.feedback.collectFeedback({
            type,
            userMessage: type === 'correction' && previousUserMessage ? previousUserMessage : message,
            botResponse: this.lastBotResponses.get(context?.userId || 'global') || '',
            correction,
            ...context,
        })
    }

    getStats(): LearningStats {
        const feedbackStats = this.feedback.getStats()
        return {
            feedback: {
                total: feedbackStats.total,
                corrections: feedbackStats.corrections,
                positive: feedbackStats.positive,
                negative: feedbackStats.negative,
            },
        }
    }

    getAllFeedback(): Feedback[] {
        return this.feedback.getAllFeedback()
    }

    async persist(): Promise<void> {
        try {
            await mkdir(this.config.dataDir, { recursive: true })
            await writeFile(join(this.config.dataDir, 'feedback.json'), this.feedback.exportToJSON())
        } catch (err) {
            console.error('[Learning] Speichern fehlgeschlagen:', err)
        }
    }

    async load(): Promise<void> {
        const feedbackData = await readFile(join(this.config.dataDir, 'feedback.json'), 'utf-8').catch(() => null)
        if (feedbackData) {
            try { this.feedback.importFromJSON(feedbackData) } catch { /* fresh start */ }
        }
    }

    private async retireLegacyFiles(): Promise<void> {
        for (const name of RETIRED_FILES) {
            const path = join(this.config.dataDir, name)
            try {
                await access(path)
                await rename(path, `${path}.stillgelegt`)
                console.log(`[Learning] ${name} stillgelegt (Muster-/Skill-Erzeugung entfernt)`)
            } catch { /* nothing to retire */ }
        }
    }
}

export function createLearningEngine(config?: Partial<LearningConfig>): LearningEngine {
    return new LearningEngine(config)
}

export { FeedbackCollector }
export type { Feedback, FeedbackType }

export default { LearningEngine, createLearningEngine, FeedbackCollector }
