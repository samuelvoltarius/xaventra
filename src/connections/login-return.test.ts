import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const flow = vi.hoisted(() => ({ beginLogin: vi.fn(async () => ({ ok: true, url: 'https://auth.example.com/authorize?state=x', message: 'Bitte anmelden' })), connectFromApproval: vi.fn(async () => ({ ok: true, message: 'Home Assistant eingerichtet.' })) }))
vi.mock('./connect-flow.js', async importOriginal => ({ ...(await importOriginal<typeof import('./connect-flow.js')>()), ...flow }))

import { handleLoginReturn, returnPage } from './login-return.js'
import { createConnectionThought, dispatchThoughtAnswer } from '../core/thought-hub.js'
import { listThoughts } from '../planner/index.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('login return page and connection thoughts (2.85 Paket A, Punkt 4)', () => {
    it('an unknown return is refused with a plain page that echoes nothing', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'xv-ret-'))
        dirs.push(dir)
        const page = await handleLoginReturn({ state: 'f'.repeat(48), code: '<script>alert(1)</script>' }, { dataDir: dir, redirectBase: 'http://127.0.0.1:3011' })
        expect(page.status).toBe(400)
        expect(page.html).not.toContain('<script>alert')
        expect(page.html).toMatch(/Nicht verbunden/)
        expect(returnPage(true, '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;')
    })

    it('expired login: one thought with a button; Ja opens the login (link, no token)', async () => {
        createConnectionThought({ kind: 'login', connectionId: 'c-home-assistant', title: 'Home Assistant: Anmeldung abgelaufen', text: 'gilt nicht mehr', proposal: 'Neu anmelden?', dedupeKey: 'verbindung:login:c-home-assistant' })
        const thought = listThoughts().find(item => item.title === 'Home Assistant: Anmeldung abgelaufen')!
        expect(thought).toMatchObject({ permission: 'fragen', source: 'verbindungen', kind: 'vorschlag' })
        const answer = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1' })
        expect(flow.beginLogin).toHaveBeenCalledWith('c-home-assistant')
        expect(answer.message).toContain('https://auth.example.com/authorize')
    })

    it('a need thought: Ja connects directly (that Ja is the approval), invalid ids remember nothing', async () => {
        createConnectionThought({ kind: 'connect', connectorId: 'home-assistant', title: 'Home Assistant verbinden?', text: 'Licht aus scheiterte', proposal: 'Verbinden?', dedupeKey: 'verbindung:bedarf:home-assistant' })
        const thought = listThoughts().find(item => item.title === 'Home Assistant verbinden?')!
        const answer = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1' })
        expect(flow.connectFromApproval).toHaveBeenCalledWith('home-assistant', 'telegram:1')
        expect(answer.ok).toBe(true)
        createConnectionThought({ kind: 'login', connectionId: '../etc', title: 'kaputt', text: 'x', proposal: 'x', dedupeKey: 'k' })
        expect(listThoughts().some(item => item.title === 'kaputt')).toBe(false)
    })
})
