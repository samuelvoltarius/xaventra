import { describe, expect, it } from 'vitest'
import { missionIdFromCheckpoint } from './mesh-registry.js'

describe('native mission handoff fencing', () => {
    it('extracts only a bounded typed mission id', () => {
        expect(missionIdFromCheckpoint(JSON.stringify({ id: 'm_123-safe' }))).toBe('m_123-safe')
        expect(missionIdFromCheckpoint(JSON.stringify({ id: '' }))).toBeNull()
        expect(missionIdFromCheckpoint(JSON.stringify({ id: 'mission id with spaces' }))).toBeNull()
        expect(missionIdFromCheckpoint('{broken')).toBeNull()
    })
})
