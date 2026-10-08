import { describe, expect, it } from 'vitest'
import { findCompoundGaps, runLimitGapNote, compoundGapGate, hasMatchingRegisteredTool } from './capability-learning.js'
import type { CapabilityInventory } from './capability-inventory.js'

const inventory = (tools: string[] = [], learned: CapabilityInventory['learned'] = []): CapabilityInventory => ({ tools, connected: new Set(), learned } as CapabilityInventory)

describe('2.89.3 Teilauftrag ohne Fähigkeit', () => {
    it('Fax im zweiten Teil: der Rest bleibt, der Fax-Teil wird zur Lücke', () => {
        const found = findCompoundGaps('Wie spät ist es und kannst du mir außerdem ein Fax an 01 234567 schicken?', inventory())
        expect(found?.rest).toBe('Wie spät ist es')
        expect(found?.gaps.map(gap => gap.domain.id)).toEqual(['fax'])
    })

    it('Fax im ersten Teil, Zeit im zweiten', () => {
        const found = findCompoundGaps('Schick ein Fax an 01 234567 und sag mir die Uhrzeit', inventory())
        expect(found?.rest).toBe('sag mir die Uhrzeit')
        expect(found?.gaps).toHaveLength(1)
    })

    it('mit vorhandenem Werkzeug keine Lücke', () => {
        expect(findCompoundGaps('Wie spät ist es und schick ein Fax an 01 234567', inventory(['send_fax']))).toBeNull()
    })

    it('Wissensfrage ohne Bitte ist keine Lücke; Einzelauftrag und Lücke ohne Rest gehen den Einzel-Weg', () => {
        expect(findCompoundGaps('Wie spät ist es und was kostet ein Fax im Jahr 1990', inventory())).toBeNull()
        expect(findCompoundGaps('Kannst du ein Fax senden?', inventory())).toBeNull()
        expect(findCompoundGaps('Schick ein Fax an Peter und schick eine SMS an Anna', inventory())).toBeNull()
    })

    it('Gruppe, System und Tests ohne Ports bieten nichts an', async () => {
        expect(await compoundGapGate('Wie spät ist es und kannst du mir ein Fax schicken?', { principalId: 'x', isGroup: true })).toBeNull()
        expect(await compoundGapGate('Wie spät ist es und kannst du mir ein Fax schicken?', { principalId: 'x' })).toBeNull()
        expect(await runLimitGapNote('Luftqualität in Wien', { principalId: 'x' })).toBe('')
    })
})

// 2.89.4: a gap only when the registry / router packs really have no matching tool.
describe('Werkzeuglücke nur ohne registriertes Werkzeug', () => {
    const inventoryTools = (tools: string[]) => inventory(tools)

    it('mesh-wide inventory is covered by the inventory tools', () => {
        const covered = inventoryTools(['environment_inventory', 'mesh_status', 'mesh_strengths'])
        expect(hasMatchingRegisteredTool('Mach eine Inventur, sag mir was wo läuft und was wir wo noch installieren können', covered)).toBe(true)
        expect(hasMatchingRegisteredTool('Mach eine Inventur, sag mir was wo läuft und was wir wo noch installieren können', inventoryTools([]))).toBe(false)
    })

    it('fax is still a real gap without a fax tool', () => {
        expect(hasMatchingRegisteredTool('Schick ein Fax an 01 234567', inventoryTools(['web_search', 'read_file']))).toBe(false)
    })
})
