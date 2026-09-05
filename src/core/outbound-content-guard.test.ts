import { describe, expect, it } from 'vitest'
import { isInternalOutboundArtifact, sanitizeInternalOutboundArtifacts } from './outbound-content-guard.js'

describe('outbound content guard', () => {
    it('blocks raw tool plans', () => {
        expect(isInternalOutboundArtifact('{"tool":"generateimage","arguments":{"prompt":"Salzburg"}}')).toBe(true)
    })

    it('blocks internal reasoning and permits normal replies', () => {
        expect(isInternalOutboundArtifact('Ich bin ein hilfreicher Assistent. Der User hat eine Abfrage gemacht.')).toBe(true)
        expect(isInternalOutboundArtifact('Alles klar, Sample!')).toBe(false)
    })

    it('removes embedded tool JSON without deleting the actual reply', () => {
        const value = 'Danke! 😊\n\n{"tool":"novaintrospect","arguments":{"type":"state"}}'
        expect(sanitizeInternalOutboundArtifacts(value)).toBe('Danke! 😊')
    })

    it('blocks leaked chain-of-thought prose and orphaned closing tags', () => {
        const leaked = `🧠 LLM-Reflexion: Here's a thinking process:\n1. Analyze User Input\n</think>\nInterne Notiz`
        expect(isInternalOutboundArtifact(leaked)).toBe(true)
        expect(sanitizeInternalOutboundArtifacts('private reasoning</think>\nSichere Antwort')).toBe('Sichere Antwort')
        expect(sanitizeInternalOutboundArtifacts('<think>noch nicht abgeschlossen')).toBe('')
    })

    it('suppresses destructive cleanup commands until diagnosis and approval', () => {
        expect(sanitizeInternalOutboundArtifacts('Bitte ausführen:\nrm -rf ~/.nova-data/cache/*'))
            .not.toContain('rm -rf')
        expect(sanitizeInternalOutboundArtifacts('Remove-Item .nova-data -Recurse -Force'))
            .toContain('Freigabe')
    })
})
