import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, listApprovalCards } from '../core/approval-cards.js'
import { listeEintraege, speichereEintrag } from './credential-broker.js'
import { FREIGABE_KIND, freigabeAnfragen } from './tresor-cards.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-tresor-card-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const OWNER = { userId: '42', ownerIds: ['42'] }

describe('Tresor: Freigabe pro Eintrag und Dienst nur per Owner-Ja (2.88)', () => {
    it('a model can only ask; the Ja releases exactly this entry for exactly this service', async () => {
        const dir = tmp()
        speichereEintrag({ id: 'github-main', label: 'GitHub', quelle: 'datei', dienste: 'github.com', geheim: ['x', 'y', 'z', 'wert'].join('-') }, { dataDir: dir })
        const deps = { dataDir: dir, cardOpts: { dataDir: dir, ledger: null } }
        expect((await freigabeAnfragen('github-main', 'https://github.com/login', deps)).message).toMatch(/schon freigegeben/)
        expect((await freigabeAnfragen('unbekannt', 'https://example.com', deps)).ok).toBe(false)
        const asked = await freigabeAnfragen('github-main', 'https://gitlab.example.com/users/sign_in', deps)
        expect(asked.ok).toBe(true)
        const card = listApprovalCards({ dataDir: dir, ledger: null }).find(item => item.aktion.kind === FREIGABE_KIND)!
        expect(card).toMatchObject({ wirkung: 'extern', aktion: { ref: 'github-main@gitlab.example.com' } })
        expect(card.beleg).not.toMatch(/wert/)
        expect(card.buttons.map(button => button.answer)).not.toContain('immer')
        expect(listeEintraege({ dataDir: dir })[0].dienste).toEqual(['github.com'])
        const token = card.buttons.find(button => button.answer === 'ja')!.token
        const result = await answerApprovalCard(`ac:${token}`, OWNER, { dataDir: dir, ledger: null })
        expect(result.ok).toBe(true)
        expect(listeEintraege({ dataDir: dir })[0].dienste).toEqual(['github.com', 'gitlab.example.com'])
    })
})
