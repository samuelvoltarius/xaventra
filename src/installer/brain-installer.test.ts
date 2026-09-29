import { describe, expect, it } from 'vitest'
import { generatePassword } from './brain-installer.js'

// MI-24: the Neo4j password came from Math.random and was short.

describe('MI-24 brain installer password', () => {
    it('is long, random and shell-safe', () => {
        const a = generatePassword()
        const b = generatePassword()
        expect(a).not.toBe(b)
        expect(a.length).toBeGreaterThanOrEqual(30)
        expect(a).toMatch(/^[A-Za-z0-9-]+$/)
    })
})
