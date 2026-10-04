import { describe, expect, it } from 'vitest'
import { isEnvironmentOverview } from './request-capabilities.js'
import { detectActionIntent } from './action-intent.js'

describe('environment overview stays separate from action requests', () => {
    it('recognizes the observed owner questions', () => {
        for (const text of ['welche geräte findest du im netzwerk? die du verwalten und steuern könntest?', 'und im local netzwerk was findest du?', 'was können deine nodes?']) expect(isEnvironmentOverview(text)).toBe(true)
    })
    it('does not replace file transfers, screenshots or mixed operations with an inventory', () => {
        for (const text of ['welche nodes gibt es? schick mir einen Screenshot von jedem', 'was können die nodes? kopiere bericht.md an den nas', 'welche geräte siehst du? führe danach einen Auftrag aus', 'was können die nodes? mach danach ein Backup', 'welche nodes sind online? sende daten an ns1']) expect(isEnvironmentOverview(text)).toBe(false)
    })
    it('recognizes the exact failed Telegram request and bounded reporting variants', () => {
        for (const text of ['send mir was du im netzwerk findest und wo mit du dich verbinden kannst mesh netzwerk und local',
            'sende mir welche Geräte du im LAN findest', 'bitte zeige mir welche Nodes online sind']) {
            expect(isEnvironmentOverview(text)).toBe(true)
            expect(detectActionIntent(text)).toEqual({ requiresTool: true, kind: 'system-state' })
        }
    })
    it('never consumes an additional action or target URL as a reporting prefix', () => {
        for (const text of ['sende mir welche nodes online sind und sende daten an ns1',
            'send mir was du im LAN findest und verbinde dich mit dem NAS',
            'zeige mir welche nodes es gibt und starte ns2', 'sende mir welche Geräte es gibt und konfiguriere sie',
            'send mir was im Netzwerk ist und screenshots von jedem', 'welche nodes gibt es? prüfe https://example.org']) expect(isEnvironmentOverview(text)).toBe(false)
    })
})
