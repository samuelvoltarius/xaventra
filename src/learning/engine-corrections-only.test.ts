import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from './engine.js'

const ctx = { channel: 'telegram', userId: 'owner' }

describe('LearningEngine lernt nur noch Korrekturen (P9 Punkt 2)', () => {
    it('erzeugt aus Wiederholungen keine Müll-Skills oder Muster mehr', () => {
        const engine = new LearningEngine({ persistInterval: 0, dataDir: mkdtempSync(join(tmpdir(), 'engine-')) })
        for (let i = 0; i < 6; i++) expect(engine.processUserMessage('ja bitte', ctx)).toBeNull()
        const stats = engine.getStats() as unknown as Record<string, unknown>
        expect(stats.skills).toBeUndefined()
        expect(stats.patterns).toBeUndefined()
        expect((engine as unknown as Record<string, unknown>).getAllSkills).toBeUndefined()
        expect((engine as unknown as Record<string, unknown>).getAllPatterns).toBeUndefined()
    })

    it('schreibt nur feedback.json und legt alte skills.json/patterns.json still', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'engine-'))
        writeFileSync(join(dir, 'skills.json'), JSON.stringify({ skills: [['s1', { name: 'Skill: ja bitte' }]] }))
        writeFileSync(join(dir, 'patterns.json'), '{}')
        const engine = new LearningEngine({ persistInterval: 0, dataDir: dir })
        await engine.start()
        engine.processUserMessage('Wann ist das Meeting morgen?', ctx)
        await engine.stop()
        const files = readdirSync(dir).sort()
        expect(files).toContain('feedback.json')
        expect(files).not.toContain('skills.json')
        expect(files).not.toContain('patterns.json')
        expect(files).toContain('skills.json.stillgelegt')
        expect(files).toContain('patterns.json.stillgelegt')
    })
})

describe('PatternStore hat einen Ort in .nova-data (P9 Punkt 2)', () => {
    it('speichert unter dem Runtime-Datenverzeichnis, nicht relativ zum Arbeitsverzeichnis', async () => {
        const root = mkdtempSync(join(tmpdir(), 'patterns-'))
        mkdirSync(join(root, '.nova-data'), { recursive: true })
        const previous = process.env.NOVA_RUNTIME_ROOT
        process.env.NOVA_RUNTIME_ROOT = root
        try {
            const { PatternStore } = await import('./pattern-store.js')
            const store = new PatternStore()
            store.recordAction('owner', 'telegram', 'zeig mir die news um 09:00')
            store.recordAction('owner', 'telegram', 'zeig mir die news um 09:00')
            expect(existsSync(join(root, '.nova-data', 'patterns.json'))).toBe(true)
        } finally {
            process.env.NOVA_RUNTIME_ROOT = previous
        }
    })
})
