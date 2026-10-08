import { describe, expect, it } from 'vitest'
import { applySystemPromptBudget } from './prompt-budget.js'

describe('system prompt budget', () => {
    it('preserves beginning and critical tail within the hard maximum', () => {
        const input = `IDENTITY-${'a'.repeat(8_000)}-CRITICAL-RULE`
        const result = applySystemPromptBudget(input, 1_000)
        expect(result.truncated).toBe(true)
        expect(result.prompt.length).toBeLessThanOrEqual(1_000)
        expect(result.prompt.startsWith('IDENTITY-')).toBe(true)
        expect(result.prompt.endsWith('-CRITICAL-RULE')).toBe(true)
    })
})

describe('2.89.3 incoming picture block under the budget', () => {
    it('keeps the stored file path exact even when the prompt is cut hard', () => {
        const path = '/var/lib/xaventra-native-2.89.2/runtime/.nova-data/inbox-media/2026-10-08-9b96758e5046.jpg'
        const filler = (name: string, n: number) => `

## ${name}
${'x'.repeat(n)}`
        const prompt = 'Identität'.repeat(20)
            + filler('Persönlichkeit', 3000) + filler('Tools', 4000) + filler('Umgebung', 4000) + filler('Mesh Netzwerk', 3000)
            + `

## Eingehendes Bild
Das Bild dieser Nachricht liegt als Datei unter ${path}. Werkzeuge, die einen Dateipfad brauchen, nutzen genau diesen Pfad.`
        expect(prompt.length).toBeGreaterThan(14000)
        const result = applySystemPromptBudget(prompt, 12000, 'was siehst du da?')
        expect(result.truncated).toBe(true)
        expect(result.prompt.length).toBeLessThanOrEqual(12000)
        expect(result.prompt).toContain(path)
        expect(result.sections.reduced).not.toContain('## Eingehendes Bild')
    })
})
