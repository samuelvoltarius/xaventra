import { describe, expect, it } from 'vitest'
import { reflect } from './self-reflection.js'
import { superviseResponse } from '../layers/L0-supervisor.js'

describe('legacy observers respect the canonical current-turn result', () => {
    it('does not demand new tools for verified historical recall', () => {
        const result = reflect({ userMessage: 'Was stand in der Datei, die du gelesen hast?',
            assistantResponse: 'In der Datei stand ein bereits bestätigter Text. Ich lese sie dafür nicht erneut.',
            toolsUsed: [], toolResults: [], execution: { requiresTool: false, validated: true } })
        expect(result.issues).not.toContain('Aktion angefragt aber kein Tool verwendet')
        expect(superviseResponse('Ich lese sie nicht erneut. Auf dem Server stand damals die bereits bestätigte Kennung.').fixes).not.toContain('Tool hätte verwendet werden sollen')
    })
    it('still flags an actual current action without a tool', () => {
        expect(reflect({ userMessage: 'Lies die Datei jetzt', assistantResponse: 'Ich werde nachsehen.',
            toolsUsed: [], toolResults: [], execution: { requiresTool: true, validated: false } }).issues).toContain('Aktion angefragt aber kein Tool verwendet')
    })
    it('does not rewrite a validated short/literal response or encourage expanding it', () => {
        for (const content of ['OK', "I'm Pi"]) {
            expect(superviseResponse(content, { preserveValidatedText: true }).content).toBe(content)
            expect(reflect({ userMessage: 'Antworte kurz?', assistantResponse: content,
                toolsUsed: [], toolResults: [], execution: { requiresTool: false, validated: true } }).issues).toEqual([])
        }
    })
})
