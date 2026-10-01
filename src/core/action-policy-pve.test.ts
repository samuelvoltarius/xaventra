import { describe, expect, it } from 'vitest'
import { evaluateAction, isNieAktionsart } from './action-policy.js'

// Alfred 01.10.2026: Xaventra may remove ONLY VMs it created itself (tag
// xaventra-created), by card. That is one exact, named exception — not a
// loophole for anything else that sounds like "entfernen"/"löschen".
describe('Aktions-Policy: Proxmox-Arten', () => {
    it('pve-entfernen ist eine bekannte L2-Art mit Karte, nicht Nie-Liste', () => {
        expect(isNieAktionsart('pve-entfernen')).toBe(false)
        expect(isNieAktionsart('pve-entfernen pve-entfernen')).toBe(false)
        const verdict = evaluateAction({ kind: 'pve-entfernen', effects: ['infra:vm-destroy'], origin: 'owner' })
        expect(verdict).toMatchObject({ level: 'L2', decision: 'ask', known: true })
    })

    it.each(['vm-entfernen', 'entfernen', 'pve-entfernen-alle', 'pve-loeschen', 'daten-entfernen pve-entfernen', 'pve-entfernenx'])(
        '„%s“ bleibt Nie-Liste', kind => {
            expect(isNieAktionsart(kind)).toBe(true)
        })

    it('pve-entfernen wird nie automatisch, auch nicht von Missionen oder dem Modell', () => {
        for (const origin of ['mission', 'verantwortung', 'model', 'selbstheilung'])
            expect(evaluateAction({ kind: 'pve-entfernen', origin, level: 'L0', decision: 'auto' }).decision).toBe('ask')
    })

    it.each(['pve-start', 'pve-herunterfahren', 'pve-snapshot', 'pve-rollback', 'pve-anlegen', 'pve-anpassen'])('%s ist bekannt und fragt', kind => {
        expect(evaluateAction({ kind, origin: 'owner' })).toMatchObject({ level: 'L2', decision: 'ask', known: true })
    })
})
