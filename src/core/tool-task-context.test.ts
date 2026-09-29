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

describe('numeric option choice (R2 NZ-38)', () => {
    it('keeps the recent tool context when the user answers with an option number', () => {
        const history = [
            { role: 'user', content: 'Prüfe die Docker-Container auf dem Spark' },
            { role: 'assistant', content: 'Welche Aktion? 1) Logs anzeigen 2) Neustart vorschlagen' },
        ]
        const context = buildToolTaskContext(history, '2')
        expect(context).toContain('Docker-Container')
        expect(context.endsWith('2')).toBe(true)
    })
})
