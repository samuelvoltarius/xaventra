import { describe, expect, it } from 'vitest'
import { applySystemPromptBudget } from './prompt-budget.js'
import { selectContextPolicy } from './context-policy.js'
import { blockTopic, buildTaskPrompt, taskPromptForRequest as forRequest, turnTopics } from './task-prompt.js'
import * as router from '../tools/tool-router.js'

const taskPromptForRequest = (prompt: string, request: string) => forRequest(prompt, request, { router })

/** Headings of the live system prompt (C-Messung 28.10.: these were cut in 25 of 46 Telegram turns). */
const block = (heading: string, size: number) => `\n\n## ${heading}\n${`${heading} `.repeat(Math.ceil(size / (heading.length + 1))).slice(0, size)}`
const LIVE_PROMPT = 'Du bist Xaventra, ein Agent.'.repeat(30)
    + block('Deine Persönlichkeit', 900)
    + block('KRITISCHE REGELN', 700)
    + block('EHRLICHKEIT (KRITISCH!)', 500)
    + block('SOZIALE INTELLIGENZ', 800)
    + block('MULTI-STEP EXECUTION (KRITISCH!)', 900)
    + block('SESSION MANAGEMENT', 700)
    + block('AUTONOME MODEL-AUSWAHL', 800)
    + block('WORKFLOW DISZIPLIN', 700)
    + block('Tools', 500)
    + block('DEINE UMGEBUNG (WICHTIG - lies das!)', 1200)
    + block('SELBST-EVOLUTION (KRITISCH!)', 900)
    + block('MESH NETZWERK', 800)
    + block('NODE UPDATES (WICHTIG!)', 600)
    + block('Ehrlich bei Fähigkeiten', 600)
    + block('Eskalationskette vor „kann ich nicht“', 600)
    + block('USER-KONTEXT', 900)
    + block('ENTSCHEIDUNGEN (kausales Gedächtnis)', 700)
    + block('DEIN SYSTEM-STATUS (LIVE)', 1500)
    + block('DEINE HARDWARE (LIVE vom System erkannt — IMMER diese Werte verwenden!)', 900)
    + block('GELERNTES WISSEN (Hintergrundrecherche)', 1500)
    + block('PROAKTIVE BEOBACHTUNGEN', 900)
    + block('EMOTIONALE WAHRNEHMUNG', 700)
    + block('DEIN ARBEITSVERZEICHNIS & DATEISYSTEM (KRITISCH)', 900)
    + block('HANDELN', 600)
    + block('Vorherige fehlgeschlagene Versuche (NICHT wiederholen!):', 600)
    + block('ERGEBNIS SOFORT PRÜFEN UND BERICHTEN', 500)
    + block('⚠️ AKTUELLE SYSTEMZEIT (KRITISCH — NIEMALS RATEN!)', 400)

const headingsOf = (prompt: string) => prompt.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3).trim())

describe('2.90.0 Aufgaben-Prompt: block topics', () => {
    it.each([
        ['ENTSCHEIDUNGEN (kausales Gedächtnis)', 'kern'],
        ['USER-KONTEXT', 'kern'],
        ['EHRLICHKEIT (KRITISCH!)', 'kern'],
        ['Ehrlich bei Fähigkeiten', 'kern'],
        ['Eskalationskette vor „kann ich nicht“', 'kern'],
        ['Vorherige fehlgeschlagene Versuche (NICHT wiederholen!):', 'kern'],
        ['⚠️ AKTUELLE SYSTEMZEIT (KRITISCH — NIEMALS RATEN!)', 'kern'],
        ['HANDELN', 'aktion'],
        ['Tools', 'aktion'],
        ['ERGEBNIS SOFORT PRÜFEN UND BERICHTEN', 'aktion'],
        ['DEINE UMGEBUNG (WICHTIG - lies das!)', 'umgebung'],
        ['MESH NETZWERK', 'umgebung'],
        ['MESH', 'umgebung'],
        ['DEIN SYSTEM-STATUS (LIVE)', 'umgebung'],
        ['DEIN ARBEITSVERZEICHNIS & DATEISYSTEM (KRITISCH)', 'dateien'],
        ['SELBST-EVOLUTION (KRITISCH!)', 'selbst'],
        ['GELERNTES WISSEN (Hintergrundrecherche)', 'gedaechtnis'],
        ['SOZIALE INTELLIGENZ', 'sozial'],
        ['EMOTIONALE WAHRNEHMUNG', 'sozial'],
    ])('„%s“ → %s', (heading, topic) => {
        expect(blockTopic(heading)).toBe(topic)
    })
    it('an unknown heading has no topic (it is kept, never silently lost)', () => {
        expect(blockTopic('Ganz neuer Block')).toBeNull()
    })
})

describe('2.90.0 Aufgaben-Prompt: topics of a turn', () => {
    it('a device action needs action rules but not the mesh or self-evolution', () => {
        const topics = turnTopics({ toolNames: ['get_current_time', 'hass_turn_on', 'hass_get'], policy: selectContextPolicy('Schalte den Drucker ein'), route: router.toolRoute })
        expect(topics.has('kern')).toBe(true)
        expect(topics.has('aktion')).toBe(true)
        expect(topics.has('umgebung')).toBe(false)
        expect(topics.has('selbst')).toBe(false)
    })
    it('a node task brings the environment', () => {
        const topics = turnTopics({ toolNames: ['mesh_status', 'mesh_nodes'], policy: selectContextPolicy('zeig mir uptime auf ns2'), route: router.toolRoute })
        expect(topics.has('umgebung')).toBe(true)
    })
    it('small talk gets the social blocks, no action rules', () => {
        const topics = turnTopics({ toolNames: ['get_current_time', 'kg_search'], policy: selectContextPolicy('danke'), route: router.toolRoute })
        expect(topics.has('sozial')).toBe(true)
        expect(topics.has('aktion')).toBe(false)
    })
})

describe('2.90.0 Aufgaben-Prompt: building', () => {
    it('the live prompt is over the 12k cap and the cap drops task rules (the problem)', () => {
        expect(LIVE_PROMPT.length).toBeGreaterThan(20_000)
        const capped = applySystemPromptBudget(LIVE_PROMPT, 12_000, 'Schalte den Drucker ein')
        expect(capped.truncated).toBe(true)
        expect(capped.sections.reduced).toEqual(expect.arrayContaining(['## Tools', '## DEINE UMGEBUNG (WICHTIG - lies das!)']))
    })
    it('a device action keeps every core and action rule in full and fits without cutting', () => {
        const result = buildTaskPrompt(LIVE_PROMPT, new Set(['kern', 'aktion']))
        expect(result.prompt.length).toBeLessThan(12_000)
        const kept = headingsOf(result.prompt)
        for (const heading of ['ENTSCHEIDUNGEN (kausales Gedächtnis)', 'USER-KONTEXT', 'HANDELN', 'Tools', 'Ehrlich bei Fähigkeiten',
            'Eskalationskette vor „kann ich nicht“', 'Vorherige fehlgeschlagene Versuche (NICHT wiederholen!):', 'ERGEBNIS SOFORT PRÜFEN UND BERICHTEN',
            '⚠️ AKTUELLE SYSTEMZEIT (KRITISCH — NIEMALS RATEN!)']) expect(kept).toContain(heading)
        expect(kept).not.toContain('MESH NETZWERK')
        expect(kept).not.toContain('SELBST-EVOLUTION (KRITISCH!)')
        expect(kept).not.toContain('SOZIALE INTELLIGENZ')
        expect(result.omitted).toContain('## MESH NETZWERK')
    })
    it('keeps the identity text and the original block order', () => {
        const result = buildTaskPrompt(LIVE_PROMPT, new Set(['kern', 'aktion', 'umgebung']))
        expect(result.prompt.startsWith('Du bist Xaventra')).toBe(true)
        const kept = headingsOf(result.prompt)
        const original = headingsOf(LIVE_PROMPT).filter(heading => kept.includes(heading))
        expect(kept).toEqual(original)
        expect(kept).toContain('DEINE UMGEBUNG (WICHTIG - lies das!)')
    })
    it('keeps blocks without a topic and reports them', () => {
        const result = buildTaskPrompt(`Ich${block('Ganz neuer Block', 100)}${block('MESH NETZWERK', 100)}`, new Set(['kern']))
        expect(headingsOf(result.prompt)).toEqual(['Ganz neuer Block'])
        expect(result.untagged).toEqual(['## Ganz neuer Block'])
    })
})

describe('2.90.0 Aufgaben-Prompt: real tool routes', () => {
    it.each([
        'Schalte den Drucker ein und prüf, ob er hochgefahren ist',
        'Wie heißen meine Hunde?',
    ])('„%s“ stays under the 12k cap without cutting and without mesh blocks', request => {
        const result = taskPromptForRequest(LIVE_PROMPT, request)
        expect(result.prompt.length).toBeLessThan(12_000)
        expect(headingsOf(result.prompt)).not.toContain('MESH NETZWERK')
        expect(headingsOf(result.prompt)).toContain('ENTSCHEIDUNGEN (kausales Gedächtnis)')
    })
    it('a node task keeps the environment blocks and is much smaller than the unit prompt', () => {
        // Whether it fits 12k live is what the shadow measurement (taskPromptWouldCap) shows.
        const result = taskPromptForRequest(LIVE_PROMPT, 'zeig mir uptime und df auf ns2 und welcher Knoten den meisten RAM hat')
        expect(headingsOf(result.prompt)).toEqual(expect.arrayContaining(['DEINE UMGEBUNG (WICHTIG - lies das!)', 'MESH NETZWERK', 'ENTSCHEIDUNGEN (kausales Gedächtnis)']))
        expect(headingsOf(result.prompt)).not.toContain('SOZIALE INTELLIGENZ')
        expect(result.prompt.length).toBeLessThan(LIVE_PROMPT.length * 0.7)
    })
    it('nova_capabilities as a core tool alone does not pull in the self blocks', () => {
        const result = taskPromptForRequest(LIVE_PROMPT, 'Schalte das Licht im Wohnzimmer ein')
        expect(headingsOf(result.prompt)).not.toContain('SELBST-EVOLUTION (KRITISCH!)')
    })
})
