import { describe, expect, it } from 'vitest'
import { capabilityGateApplies } from './message-pipeline.js'

// 2.88.1 (live 07.10.2026): "Kannst du ein Fax senden?" in the app got a plain "Nein"
// without "Soll ich es lernen?" — the gate was skipped for every app message.
describe('capability gate also runs for app messages', () => {
    it('app message with only its cancellation deadline → gate runs', () => {
        expect(capabilityGateApplies({ isSystemAuthored: false, image: false, execution: true, desktopCancellationOnly: true })).toBe(true)
    })
    it('mesh agent request with a real execution contract → gate stays off (Gegenprobe)', () => {
        expect(capabilityGateApplies({ isSystemAuthored: false, image: false, execution: true, desktopCancellationOnly: false })).toBe(false)
    })
    it('system messages and images never', () => {
        expect(capabilityGateApplies({ isSystemAuthored: true, image: false, execution: false, desktopCancellationOnly: false })).toBe(false)
        expect(capabilityGateApplies({ isSystemAuthored: false, image: true, execution: false, desktopCancellationOnly: false })).toBe(false)
    })
})
