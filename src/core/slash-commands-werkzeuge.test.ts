import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluateAction, isTrustEligible } from './action-policy.js'

// P9 Werkzeug-Schmiede: /werkzeuge (Owner), Aktionsarten und der Bedarfs-Hook.
const { handleCommand } = await import('./slash-commands.js')
const state: any = { running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null, memory: null, learning: null, tools: null, resilience: null, startTime: Date.now(), config: {} }
const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }
const user = { channel: 'cli', rawUserId: 'user-1', principalId: 'user-1', permission: 'user' as const }

describe('/werkzeuge', () => {
    it('zeigt dem Owner die Werkzeug-Schmiede', async () => {
        expect(await handleCommand('werkzeuge', '', 'owner-1', state, [], owner)).toContain('Werkzeug-Schmiede')
    })
    it('ist für Nicht-Owner gesperrt', async () => {
        expect(await handleCommand('werkzeuge', '', 'user-1', state, [], user)).not.toContain('Werkzeug-Schmiede')
    })
    it('/learn baut ohne lokales Lern-Modell nichts (kein Cloud-Ersatz)', async () => {
        const text = String(await handleCommand('learn', 'Wechselkurs holen', 'owner-1', state, [], owner))
        expect(text).toMatch(/Lern-Modell|Node/)
    })
})

describe('Aktionsarten der Werkzeug-Aktivierung', () => {
    it('schreibend ist L2 intern und darf die Vertrauensleiter hoch, extern/physisch nie', () => {
        expect(evaluateAction({ kind: 'werkzeug-schreibend', origin: 'code' })).toMatchObject({ level: 'L2', impact: 'intern', known: true })
        expect(isTrustEligible('werkzeug-schreibend')).toBe(true)
        expect(evaluateAction({ kind: 'werkzeug-extern', origin: 'code' }).impact).toBe('extern')
        expect(evaluateAction({ kind: 'werkzeug-physisch', origin: 'code' }).impact).toBe('physisch')
        expect(isTrustEligible('werkzeug-extern')).toBe(false)
        expect(isTrustEligible('werkzeug-physisch')).toBe(false)
    })
})

describe('Bedarfs-Hook in der Pipeline', () => {
    it('steht direkt hinter finishRoutineSkillRun und bekommt den neuen Routine-Skill', () => {
        const source = readFileSync(new URL('./message-pipeline.ts', import.meta.url), 'utf8')
        const routine = source.indexOf('finishRoutineSkillRun(getRoutineSkillStore()')
        const hook = source.indexOf('noteForgeNeed({')
        expect(routine).toBeGreaterThan(0)
        expect(hook).toBeGreaterThan(routine)
        expect(source.slice(hook, hook + 600)).toContain('routineSkillCreated')
    })
})
