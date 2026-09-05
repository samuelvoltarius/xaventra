import { describe, expect, it } from 'vitest'
import { buildToolTaskContext } from './tool-task-context.js'

describe('tool task context', () => {
    it('retains the originating request for a short follow-up', () => {
        const result = buildToolTaskContext([
            { role: 'user', content: 'Kannst du ein Bild generieren?' },
            { role: 'assistant', content: 'Was für eins soll es sein?' },
        ], 'die Stadt Salzburg bitte')
        expect(result).toContain('Bild generieren')
        expect(result).toContain('Stadt Salzburg')
    })

    it('drops tool intents before a completed action', () => {
        const result = buildToolTaskContext([
            { role: 'user', content: 'Mach einen Screenshot' },
            { role: 'assistant', content: 'Screenshot wurde erfolgreich gesendet.' },
            { role: 'user', content: 'Erkläre mir Photosynthese' },
        ], 'warum ist sie wichtig?')
        expect(result).not.toContain('Screenshot')
        expect(result).toContain('Photosynthese')
    })

    it('does not inherit an old setup pack into a short new conversational turn', () => {
        const result = buildToolTaskContext([
            { role: 'user', content: 'Installiere das fehlende lokale LLM und prüfe Embeddings.' },
            { role: 'assistant', content: 'Der Setup-Plan wartet auf Freigabe.' },
            { role: 'assistant', content: 'Was machst du gerade?' },
        ], 'dich noch besser udn schlauer machen')
        expect(result).toBe('dich noch besser udn schlauer machen')
        expect(result).not.toContain('Installiere')
        expect(result).not.toContain('Embedding')
    })
})
