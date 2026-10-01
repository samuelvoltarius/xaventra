import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOME_ASSISTANT_SKILL_ID, RoutineSkillStore, setRoutineSkillStore } from '../learning/routine-skills.js'

// P8: /skills zeigt die Routine-Skills (gelernt + eingebaut) und schaltet sie
// für den Owner an/aus. Ein Befehl ist nie nötig, nur Übersicht.
const { handleCommand } = await import('./slash-commands.js')

let dir: string
let store: RoutineSkillStore
const state: any = {
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null, memory: null,
    learning: null, tools: null, resilience: null, startTime: Date.now(), config: {}, metaLearning: { getLearnedSkills: () => [] },
}
const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }
const user = { channel: 'cli', rawUserId: 'user-1', principalId: 'user-1', permission: 'user' as const }

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-cmd-'))
    store = new RoutineSkillStore({ dir })
    setRoutineSkillStore(store)
})
afterEach(() => {
    setRoutineSkillStore(null)
    rmSync(dir, { recursive: true, force: true })
})

describe('/skills mit Routine-Skills', () => {
    it('zeigt dem Owner den eingebauten Home-Assistant-Skill', async () => {
        const text = await handleCommand('skills', '', 'owner-1', state, [], owner)
        expect(text).toContain('Routine-Skills')
        expect(text).toContain('Home Assistant ansehen')
        expect(text).toContain(HOME_ASSISTANT_SKILL_ID)
    })

    it('der Owner kann einen Skill ab- und wieder anschalten', async () => {
        expect(await handleCommand('skills', `aus ${HOME_ASSISTANT_SKILL_ID}`, 'owner-1', state, [], owner)).toContain('aus')
        expect(store.get(HOME_ASSISTANT_SKILL_ID)?.enabled).toBe(false)
        expect(await handleCommand('skills', `an ${HOME_ASSISTANT_SKILL_ID}`, 'owner-1', state, [], owner)).toContain('an')
        expect(store.get(HOME_ASSISTANT_SKILL_ID)?.enabled).toBe(true)
    })

    it('ein Nicht-Owner sieht keine Routine-Skills und kann nichts schalten', async () => {
        const text = await handleCommand('skills', `aus ${HOME_ASSISTANT_SKILL_ID}`, 'user-1', state, [], user)
        expect(text).not.toContain('Routine-Skills')
        expect(store.get(HOME_ASSISTANT_SKILL_ID)?.enabled).toBe(true)
    })
})
