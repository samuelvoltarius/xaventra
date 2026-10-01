import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

describe('P9 Aufräumen: toter Skill-/Lern-Code ist weg (Gruppe 3)', () => {
    it.each([
        'synthesis/generator.ts', 'synthesis/pipeline.ts', 'synthesis/index.ts',
        'mesh/skill-distributor.ts', 'infra/plugins.ts', 'learning/teaching.ts',
    ])('%s existiert nicht mehr', path => {
        expect(existsSync(src(path))).toBe(false)
    })

    it('L7 hat keinen zweiten Schreiber auf .nova-learning/skills.json (SkillSynthesizer weg)', async () => {
        const l7 = await import('../layers/L7-learning.js') as Record<string, unknown>
        expect(l7.SkillSynthesizer).toBeUndefined()
        expect(l7.getSkillSynthesizer).toBeUndefined()
        expect(readFileSync(src('layers/L7-learning.ts'), 'utf8')).not.toMatch(/skills\.json/)
    })

    it('das kaputte Werkzeug learn_workflow_skill ist nicht mehr registriert', async () => {
        const { getToolRegistry } = await import('../tools/complete-registry.js')
        expect(getToolRegistry().get('learn_workflow_skill')).toBeUndefined()
    })

    it('der Daemon bietet kein ungenutztes findSkill mehr an', () => {
        expect(readFileSync(src('daemon.ts'), 'utf8')).not.toMatch(/findSkill|getSkillSynthesizer/)
    })
})
