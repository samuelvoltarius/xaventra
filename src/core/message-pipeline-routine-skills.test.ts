import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// P8 Routine-Skills: die Pipeline lädt einen passenden Skill VOR dem Lauf in
// den Prompt und zählt NACH dem Lauf Ergebnis und Wiederholung — beides nur mit
// der aufgelösten Rolle, dem Gruppen-Flag und dem System-Flag dieser Nachricht.
const pipelineSource = readFileSync(fileURLToPath(new URL('./message-pipeline.ts', import.meta.url)), 'utf8')

describe('Pipeline-Anbindung der Routine-Skills', () => {
    it('merkt sich, ob die Nachricht aus einer Gruppe kommt', () => {
        expect(pipelineSource).toMatch(/if \(mu\.isGroupChat\(chatId, from\)\) \{\s*requestIsGroup = true/)
    })

    it('lädt den Skill vor dem Lauf mit Rolle, Gruppe und System-Flag', () => {
        const hint = pipelineSource.indexOf('routineSkillHint(getRoutineSkillStore(), {')
        const agent = pipelineSource.indexOf('runNovaAgent({')
        expect(hint).toBeGreaterThan(0)
        expect(hint).toBeLessThan(agent)
        const call = pipelineSource.slice(hint, hint + 300)
        expect(call).toContain('permission: principalContext.permission')
        expect(call).toContain('isGroup: requestIsGroup')
        expect(call).toContain('systemAuthored: isSystemAuthored')
    })

    it('zählt nach dem Lauf mit Validierung, Werkzeugfolge und angewendetem Skill', () => {
        const finish = pipelineSource.indexOf('finishRoutineSkillRun(getRoutineSkillStore(), {')
        expect(finish).toBeGreaterThan(pipelineSource.indexOf('runNovaAgent({'))
        const call = pipelineSource.slice(finish, finish + 700)
        expect(call).toContain('appliedSkillId: routineSkillApplied')
        expect(call).toContain('success: (result as any).validation?.success === true')
        expect(call).toContain('steps: (result as any).toolExecutions || []')
        expect(call).toContain('permission: principalContext.permission')
        expect(call).toContain('isGroup: requestIsGroup')
    })
})
