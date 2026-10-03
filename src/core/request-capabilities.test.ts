import { describe, expect, it } from 'vitest'
import { isEnvironmentOverview } from './request-capabilities.js'

describe('environment overview stays separate from action requests', () => {
    it('recognizes the observed owner questions', () => {
        for (const text of ['welche geräte findest du im netzwerk? die du verwalten und steuern könntest?', 'und im local netzwerk was findest du?', 'was können deine nodes?']) expect(isEnvironmentOverview(text)).toBe(true)
    })
    it('does not replace file transfers, screenshots or mixed operations with an inventory', () => {
        for (const text of ['welche nodes gibt es? schick mir einen Screenshot von jedem', 'was können die nodes? kopiere bericht.md an den nas', 'welche geräte siehst du? führe danach einen Auftrag aus', 'was können die nodes? mach danach ein Backup', 'welche nodes sind online? sende daten an ns1']) expect(isEnvironmentOverview(text)).toBe(false)
    })
})
