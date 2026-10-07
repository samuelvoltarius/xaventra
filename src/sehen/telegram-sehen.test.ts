import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sammleAktivitaet, type AktivitaetQuellen } from './aktivitaet.js'
import { _resetAkTokens, aktivitaetKnoepfe, drueckeAktivitaet } from './telegram-sehen.js'

let dir = ''
let stopped: string[] = []
const q = (): AktivitaetQuellen => ({
    dataDir: dir, aufgaben: async () => [], aktuelleAufgabe: async () => null, auftrag: async () => null, delegationen: async () => [], jobs: async () => [],
    arbeit: async () => ({ missions: [], responsibilities: [] }),
    subagenten: async () => [{ id: 'sub_1', task: 'Preise vergleichen für den neuen Router', status: 'running', durationMs: 1000 }],
    subagentStopp: async id => { stopped.push(id); return true },
})
const OWNER = { userId: '111', ownerIds: ['111'], chatId: '111', privateChat: true }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-sehen-')); stopped = []; _resetAkTokens() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Telegram: Was ich gerade tue – Stopp per Knopf', () => {
    it('Knopf trägt nur ein Token und stoppt genau einmal über denselben Weg wie die App', async () => {
        const keyboard = aktivitaetKnoepfe(await sammleAktivitaet(q()), '111')
        expect(keyboard).toHaveLength(1)
        const [button] = keyboard[0]
        expect(button.text).toBe('⏹ Preise vergleichen fü…')
        expect(button.callback_data).toMatch(/^ak:[a-f0-9]{12}$/)
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
        expect(await drueckeAktivitaet(button.callback_data, OWNER, q())).toMatchObject({ ok: true })
        expect(stopped).toEqual(['sub_1'])
        expect((await drueckeAktivitaet(button.callback_data, OWNER, q())).ok).toBe(false)
        expect(stopped).toEqual(['sub_1'])
    })

    it('fremde Nutzer, Gruppen und fremde Chats bekommen nichts', async () => {
        const [[button]] = aktivitaetKnoepfe(await sammleAktivitaet(q()), '111')
        expect((await drueckeAktivitaet(button.callback_data, { ...OWNER, userId: '222', chatId: '222' }, q())).ok).toBe(false)
        expect((await drueckeAktivitaet(button.callback_data, { ...OWNER, privateChat: false }, q())).ok).toBe(false)
        expect((await drueckeAktivitaet('ak:zz', OWNER, q())).ok).toBe(false)
        expect(stopped).toEqual([])
    })
})
