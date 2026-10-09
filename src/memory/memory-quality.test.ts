import { describe, expect, it } from 'vitest'
import { decideMemoryTurn, isDurableMemoryCandidate, memoryRelevance } from './memory-quality.js'

describe('memory quality gate', () => {
    it.each(['Mein Hund heißt Bello.', 'Meine Katze heisst Minka.', 'Mein Hund Bello ist braun.'])('observes a natural personal statement: %s', message => {
        expect(decideMemoryTurn(message)).toMatchObject({ observe: true, reason: 'personal-fact' })
    })
    it('recognizes do-not-forget and does not observe a recall question', () => {
        expect(decideMemoryTurn('Vergiss nicht: Mein Hund heißt Bello.')).toMatchObject({ observe: true, reason: 'explicit-memory' })
        expect(decideMemoryTurn('Wie heißt mein Hund?').observe).toBe(false)
    })
    it('rejects transient output', () => {
        expect(isDurableMemoryCandidate('2026-07-11T23:19:31 [INFO] Task completed')).toBe(false)
        expect(isDurableMemoryCandidate('Ich konnte die Aktion nicht zuverlässig ausführen.')).toBe(false)
        expect(isDurableMemoryCandidate('Warum ging das gestern eigentlich nicht?')).toBe(false)
    })
    it('accepts durable facts', () => expect(isDurableMemoryCandidate('Sample bevorzugt für Nova lokale Modelle auf seinem eigenen Server.')).toBe(true))
    it('requires meaningful relevance', () => {
        expect(memoryRelevance('warum geht das nicht', 'Sample bevorzugt lokale Modelle auf seinem Server')).toBe(0)
        expect(memoryRelevance('welche lokalen Modelle nutzt Sample', 'Sample bevorzugt lokale Modelle auf seinem Server')).toBeGreaterThan(0.3)
    })
})
