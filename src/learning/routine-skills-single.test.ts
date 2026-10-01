import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { RoutineSkillStore, setRoutineSkillStore, type ObserveInput } from './routine-skills.js'

const src = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const OWNER = 'owner-alfred'
const steps: ObserveInput['steps'] = [{ toolName: 'weather_get', params: { location: 'Salzburg' }, success: true }]
const run = (runId: string): ObserveInput => ({ runId, principalId: OWNER, permission: 'owner', request: 'Wie ist das Wetter in Salzburg?', intentKind: 'lookup', steps, success: true })

afterEach(() => setRoutineSkillStore(null))

describe('Ein Workflow-Skill-System (P9 Punkt 3)', () => {
    it('der Personal-Skill-Compiler ist in den Routine-Skills aufgegangen', () => {
        expect(existsSync(src('learning/personal-skill-compiler.ts'))).toBe(false)
        expect(readFileSync(src('learning/learning-coordinator.ts'), 'utf8')).not.toMatch(/personal-skill-compiler|PersonalSkill/)
        expect(readFileSync(src('core/world-model.ts'), 'utf8')).toMatch(/routine-skills/)
    })

    it('ein vom Owner zurückgewiesener Lauf zählt nicht mehr und schwächt den Skill, der auf ihm beruht', () => {
        const dir = mkdtempSync(join(tmpdir(), 'routine-retract-'))
        try {
            let t = Date.parse('2026-10-01T08:00:00.000Z')
            const store = new RoutineSkillStore({ dir, now: () => t += 60_000 })
            store.observe(run('r1')); store.observe(run('r2'))
            const created = (store.observe(run('r3')) as { created?: { id: string } }).created
            expect(created).toBeTruthy()
            expect(store.retractRun('r3')).toBe(true)
            const skill = store.get(created!.id)!
            expect(skill.evidence.map(item => item.runId)).not.toContain('r3')
            expect(skill.failures).toBe(1)
            expect(store.retractRun('r3')).toBe(false)
            expect(store.retractRun('r2')).toBe(true)
            expect(store.get(created!.id)!.enabled).toBe(false)
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })

    it('LearningCoordinator.invalidateValidatedRun zieht den Lauf aus den Routine-Skills zurück', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'routine-retract-'))
        try {
            const store = new RoutineSkillStore({ dir })
            setRoutineSkillStore(store)
            store.observe(run('x1'))
            const { LearningCoordinator } = await import('./learning-coordinator.js')
            const coordinator = new LearningCoordinator(undefined, mkdtempSync(join(tmpdir(), 'coord-')))
            await coordinator.invalidateValidatedRun({ runId: 'x1', userId: OWNER, request: 'Wetter', taskType: 'lookup', reason: 'falsch' })
            const observations = JSON.parse(readFileSync(store.observationFile, 'utf8')).items as Array<{ runId: string }>
            expect(observations.map(item => item.runId)).not.toContain('x1')
        } finally { rmSync(dir, { recursive: true, force: true }) }
    })
})
