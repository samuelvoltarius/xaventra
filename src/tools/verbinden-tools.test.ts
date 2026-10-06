import { afterEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ role: 'owner' }))
vi.mock('../core/lifecycle-policy.js', () => ({ getExecutionPolicyContext: () => ({ authUserId: 'owner', channel: 'Desktop' }) }))
vi.mock('../users/multi-user-middleware.js', () => ({ getUserPermission: () => auth.role }))
import { speichereEintrag } from '../secrets/credential-broker.js'
import { forgetSecretValues } from '../security/secret-redaction.js'
import { anmeldenMitZugangTool, dienstFindenTool, proxmoxVmTool, verbindenTools, zugaengeListeTool } from './verbinden-tools.js'
import { ALL_TOOLS } from './complete-registry.js'

afterEach(() => { auth.role = 'owner'; forgetSecretValues() })
// Fixture value, assembled so secret scanners do not mistake it for a credential.
const VALUE = ['Garten', 'Zaun', 'Tor', '5'].join('-')

describe('Verbinden-Werkzeuge (2.88)', () => {
    it('are owner only', async () => {
        auth.role = 'user'
        for (const tool of verbindenTools) await expect(tool.handler({ wunsch: 'x', credential_id: 'x', aktion: 'status' })).rejects.toThrow('Owner')
    })

    it('dienst_finden answers from the checked catalog without network', async () => {
        const result: any = await dienstFindenTool.handler({ wunsch: 'github' })
        expect(result.treffer[0]).toMatchObject({ dienst: 'github', stufe: 'geprueft', verbindbar: true })
    })

    it('zugaenge_liste shows ids and services only; password change is refused; no browser page = clear error', async () => {
        speichereEintrag({ id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: 'github.com', geheim: VALUE })
        const list: any = await zugaengeListeTool.handler({})
        expect(list.zugaenge).toEqual([{ credential_id: 'github-main', name: 'GitHub', dienste: ['github.com'] }])
        expect(JSON.stringify(list)).not.toContain(VALUE)
        expect(((await anmeldenMitZugangTool.handler({ credential_id: 'github-main', requestText: 'Bitte Passwort ändern bei GitHub' })) as any).error).toMatch(/ändere ich nie/)
        const noPage: any = await anmeldenMitZugangTool.handler({ credential_id: 'github-main' })
        expect(noPage.success).toBe(false)
        expect(JSON.stringify(noPage)).not.toContain(VALUE)
    })

    it('proxmox_vm without setup gives the one hint; all tools are registered', async () => {
        expect(((await proxmoxVmTool.handler({ aktion: 'status' })) as any).error).toMatch(/Verbindungen → Proxmox/)
        const names = ALL_TOOLS.map(tool => tool.name)
        for (const tool of verbindenTools) expect(names).toContain(tool.name)
    })
})
