import { describe, expect, it } from 'vitest'
import { curateFacts } from './memory-curator.js'

const fact = (id: string, content: string, createdAt: number, accessCount = 0) => ({
    id, type: 'preference', content, confidence: .9, createdAt, accessCount, lastAccessed: createdAt,
})

describe('memory curator', () => {
    it('drops logs and operational chatter', () => {
        const result = curateFacts([fact('1', '2026-07-13T00:00 [INFO] Task completed without any relevant personal fact', 1)])
        expect(result).toHaveLength(0)
    })

    it('lets a newer contradiction replace an older preference', () => {
        const result = curateFacts([
            fact('old', 'Preference: Ich verwende immer Cloud Modelle für meine täglichen Aufgaben', 1),
            fact('new', 'Preference: Ich verwende nie Cloud Modelle für meine täglichen Aufgaben', 2),
        ], 3)
        expect(result.map(item => item.id)).toEqual(['new'])
    })
})
