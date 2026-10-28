import { describe, expect, it } from 'vitest'
import { fitsNodePackages, nodePackageFamily } from './autonomy-engine.js'

// B6 (28.10.2026, VM 130 = Ubuntu): "[Autonomy] 🎯 New self-goal: "Erstellung einer Baseline der installierten
// Paketversionen und Abhängigkeiten" (Erfassung des aktuellen Software-Stacks (via dpkg -l oder rpm -qa) …"
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n'
const FEDORA = 'NAME="Fedora Linux"\nID=fedora\n'

describe('self-goals fit the node (B6)', () => {
    it('knows the package family of the node', () => {
        expect(nodePackageFamily('linux', UBUNTU)).toBe('apt')
        expect(nodePackageFamily('linux', FEDORA)).toBe('rpm')
        expect(nodePackageFamily('darwin', '')).toBe('brew')
        expect(nodePackageFamily('linux', '')).toBeNull()
    })

    it('rejects the live goal with rpm on Ubuntu; apt/dpkg goals pass', () => {
        const goal = 'Erstellung einer Baseline der installierten Paketversionen und Abhängigkeiten'
        const reason = 'Erfassung des aktuellen Software-Stacks (via dpkg -l oder rpm -qa), um zukünftige Änderungen zu tracken'
        expect(fitsNodePackages(`${goal}\n${reason}`, 'apt')).toMatchObject({ fits: false, foreign: 'rpm' })
        expect(fitsNodePackages(`${goal}\nvia dpkg -l und apt list --installed`, 'apt')).toEqual({ fits: true })
        expect(fitsNodePackages('rpm -qa --last auswerten', 'rpm')).toEqual({ fits: true })
        expect(fitsNodePackages('Speicherplatz prüfen', null)).toEqual({ fits: true })
    })
})
