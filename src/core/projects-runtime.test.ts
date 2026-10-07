import { describe, expect, it } from 'vitest'
import { findExistingWork } from './projects-runtime.js'

describe('projects reuse existing work', () => {
    it('links a running or queued Auftrag instead of working twice', () => {
        expect(findExistingWork('den Umzug nach Linz', 'owner', { active: { id: 'm_1', goal: 'Plane den Umzug nach Linz', status: 'active' } }))
            .toMatchObject({ art: 'auftrag', ref: 'm_1', aktiv: true })
        expect(findExistingWork('die Steuererklärung', 'owner', { queue: [{ goal: 'Steuererklärung vorbereiten', userId: 'owner' }] }))
            .toMatchObject({ art: 'auftrag', aktiv: true })
    })

    it('an open goal is only context; unrelated or finished work is ignored', () => {
        expect(findExistingWork('Angebot für die Küche', 'owner', { goals: [{ id: 'g1', title: 'Angebot Küche einholen', status: 'active' }] }))
            .toMatchObject({ art: 'ziel', aktiv: false })
        expect(findExistingWork('Angebot für die Küche', 'owner', {
            active: { id: 'm_2', goal: 'Gartenfest planen', status: 'active' },
            goals: [{ id: 'g2', title: 'Angebot Küche einholen', status: 'completed' }],
        })).toBeNull()
    })
})