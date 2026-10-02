/**
 * Live 2.82.0 (Spark): "systemPrompt too large ... capping to 12000". The old
 * budget kept the first 25 %, the next 20 % and the last 55 % of the cap and
 * cut everything in between, blind to content. The ENTSCHEIDUNGEN block sits
 * in the middle of the prompt and was the first thing to go.
 */
import { describe, expect, it } from 'vitest'
import { applySystemPromptBudget, blockPriority } from './prompt-budget.js'

const filler = (label: string, chars: number) => `${label} ${'x'.repeat(chars)}`

function bigPrompt(): string {
    return [
        `Du bist Xaventra. ${filler('Identität', 2_500)}`,
        `## KRITISCHE REGELN\n${filler('Regeln', 800)}`,
        `## ⚠️ AKTUELLE SYSTEMZEIT (KRITISCH — NIEMALS RATEN!)\nHeute ist 2026-10-02.`,
        `## DEIN SYSTEM-STATUS (LIVE)\n${filler('Status', 3_200)}`,
        `## GELERNTES WISSEN (Hintergrundrecherche)\n${filler('Wissen', 4_000)}`,
        `## ENTSCHEIDUNGEN (kausales Gedächtnis)\n- Backups laufen nachts um 3 Uhr, nie tagsüber. ENTSCHEIDUNG-MARKER`,
        `## DEINE HARDWARE (LIVE vom System erkannt — IMMER diese Werte verwenden!)\n${filler('Hardware', 2_000)}`,
        `## 🌐 MESH ROUTING (automatisch erkannt)\n${filler('Mesh', 2_000)}`,
        `## 📓 JOURNAL (letzte Tage)\n${filler('Journal', 2_500)}`,
        `## DEIN ARBEITSVERZEICHNIS & DATEISYSTEM (KRITISCH)\n${filler('Pfade', 600)}`,
        `## Gespeicherter Skill: Wochenbericht (v2, gelernt)\n1. read_file {} — SKILL-MARKER`,
        `## HANDELN\nWenn eine Aufgabe ein Tool braucht → sofort aufrufen.`,
        `## USER-KONTEXT\n⚠️ Dieser User ist ein GAST. SICHERHEIT-MARKER`,
    ].join('\n\n')
}

describe('system prompt budget by priority', () => {
    it('keeps the ENTSCHEIDUNGEN block, the routine skill hint and the security rules of a large prompt', () => {
        const input = bigPrompt()
        expect(input.length).toBeGreaterThan(18_000)
        const result = applySystemPromptBudget(input, 12_000)
        expect(result.truncated).toBe(true)
        expect(result.prompt.length).toBeLessThanOrEqual(12_000)
        expect(result.prompt).toContain('## ENTSCHEIDUNGEN (kausales Gedächtnis)')
        expect(result.prompt).toContain('ENTSCHEIDUNG-MARKER')
        expect(result.prompt).toContain('SKILL-MARKER')
        expect(result.prompt).toContain('SICHERHEIT-MARKER')
        expect(result.prompt).toContain('Heute ist 2026-10-02.')
        expect(result.prompt).toContain('## HANDELN')
        expect(result.prompt.startsWith('Du bist Xaventra.')).toBe(true)
    })

    it('cuts low-value context first and keeps the original order', () => {
        const result = applySystemPromptBudget(bigPrompt(), 12_000)
        const order = ['## KRITISCHE REGELN', '## ENTSCHEIDUNGEN', '## Gespeicherter Skill', '## HANDELN', '## USER-KONTEXT']
            .map(heading => result.prompt.indexOf(heading))
        expect(order.every(index => index >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
        // Background knowledge, hardware and mesh are trimmed or dropped before anything important.
        expect(result.sections.reduced).toEqual(expect.arrayContaining(['## GELERNTES WISSEN (Hintergrundrecherche)']))
        expect(result.sections.reduced.some(heading => /ENTSCHEIDUNGEN|Gespeicherter Skill|USER-KONTEXT|HANDELN/.test(heading))).toBe(false)
    })

    it('classifies blocks: decisions/skills/security protected, background low', () => {
        expect(blockPriority('## ENTSCHEIDUNGEN (kausales Gedächtnis)')).toBe(0)
        expect(blockPriority('## Gespeicherter Skill: X (v1, gelernt)')).toBe(0)
        expect(blockPriority('## USER-KONTEXT')).toBe(0)
        expect(blockPriority('## ⚠️ STRICT IMPLEMENTATION MODE — AKTIV')).toBe(0)
        expect(blockPriority('## 🧠 Bekannte Lösung für ähnliche Aufgabe:')).toBe(0)
        expect(blockPriority('## GELERNTES WISSEN (Hintergrundrecherche)')).toBe(3)
        expect(blockPriority('## 🌐 MESH ROUTING (automatisch erkannt)')).toBe(3)
    })

    it('leaves a prompt within the budget untouched', () => {
        const input = bigPrompt()
        expect(applySystemPromptBudget(input, input.length)).toMatchObject({ prompt: input, truncated: false })
    })
})
