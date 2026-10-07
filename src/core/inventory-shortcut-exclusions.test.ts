import { describe, expect, it } from 'vitest'
import { isEnvironmentOverview } from './request-capabilities.js'

// 2.88.1 (live 07.10.2026): "Welche VMs laufen auf meinem Proxmox?" and "Was kann
// welcher Knoten?" were answered by the device-inventory shortcut, so the new
// proxmox_vm and mesh_strengths tools were never used.

describe('device-inventory shortcut leaves VM and node-strength questions to their tools', () => {
    it.each([
        'Welche VMs laufen auf meinem Proxmox?',
        'Welche Container laufen auf Proxmox?',
        'Was kann welcher Knoten?',
        'Welcher Node kann was am besten?',
    ])('%s → not the inventory shortcut', question => {
        expect(isEnvironmentOverview(question)).toBe(false)
    })

    it.each(['Welche smarten Geräte findest du?', 'Was ist in meinem Netzwerk?'])('%s → still the inventory shortcut (Gegenprobe)', question => {
        expect(isEnvironmentOverview(question)).toBe(true)
    })
})
