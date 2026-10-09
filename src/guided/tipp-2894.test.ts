/**
 * 2.89.4 Fix 5 — unsolicited tips: never a promise, only capabilities that are
 * really available (capability-inventory), at most one per day, switchable off.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tippAlleAblehnen, tippHeute, TIPP_VERSPRECHEN, TIPPS, tippKann, tippsAus } from './daily-tip.js'
import { runGuidedAction, runGuidedTelegramTick } from './guided-runtime.js'
import { pressGuided } from './telegram-guided.js'
import { noteConnected } from './example-prompts.js'

let dir: string
let t: number
const opts = () => ({ dataDir: dir, now: () => t })
const printer = { id: 'geraet:moonraker:192.0.2.20:7125', title: 'Drucker (Klipper)', connectorId: 'moonraker' }
const fakePrinter = { id: 'x', title: 'Drucker im Titel ohne Protokoll' }
const ha = { id: 'geraet:homeassistant:192.0.2.10:8123', title: 'Home Assistant', connectorId: 'home-assistant' }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tipp-')); t = Date.parse('2026-10-09T08:00:00.000Z') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('2.89.4 tips never promise the future', () => {
    it('no tip text contains a monitoring promise', () => {
        for (const tipp of TIPPS) {
            expect(tipp.text).not.toMatch(TIPP_VERSPRECHEN)
            expect(tipp.text).not.toContain('sobald')
        }
    })
    it('the printer tip only offers what you can ask', () => {
        const drucker = TIPPS.find(item => item.id === 'drucker-fertig')!
        expect(drucker.text).toContain('Du kannst fragen')
        expect(drucker.text).not.toMatch(/sag dir Bescheid/)
    })
})

describe('2.89.4 capability-inventory gate', () => {
    it('a printer tip needs a real printer protocol, not a title match', () => {
        expect(tippKann('drucker', { typen: ['drucker'], eintraege: [fakePrinter] })).toBe(false)
        expect(tippKann('drucker', { typen: ['drucker'] })).toBe(false)
        expect(tippKann('drucker', { typen: ['drucker'], eintraege: [] })).toBe(false)
        expect(tippKann('drucker', { typen: ['drucker'], eintraege: [printer] })).toBe(true)
    })
    it('ki and suche only when the tools are there', () => {
        expect(tippKann('ki', { typen: ['ki'], inventory: null as any })).toBe(true)
        expect(tippKann('ki', { typen: ['ki'], inventory: { tools: [], connected: new Set(), learned: [], runtime: { provider: 'none', kind: 'none', reachable: false } } })).toBe(false)
        expect(tippKann('suche', { typen: ['suche'], inventory: { tools: ['web_search'], connected: new Set(), learned: [] } })).toBe(true)
        expect(tippKann('suche', { typen: ['suche'], inventory: { tools: ['read_file'], connected: new Set(), learned: [] } })).toBe(false)
    })
    it('tippHeute skips a printer without a printer connection', async () => {
        const picked = await tippHeute({
            ...opts(), typen: ['drucker'], eintraege: [fakePrinter],
            ruhezeit: () => false, abgelehnt: () => false, inventory: null,
        })
        expect(picked).toBeNull()
        const real = await tippHeute({
            ...opts(), typen: ['drucker'], eintraege: [printer],
            ruhezeit: () => false, abgelehnt: () => false, inventory: null,
        })
        expect(real).toMatchObject({ neu: true, tipp: { id: 'drucker-fertig' } })
        expect(await tippHeute({
            ...opts(), typen: [], eintraege: [],
            ruhezeit: () => false, abgelehnt: () => false, inventory: null,
        })).toBeNull()
    })
})

describe('2.89.4 global off switch', () => {
    it('„Tipps aus“ stops all tips; it is on the tip itself', async () => {
        expect(await tippHeute({ ...opts(), typen: ['homeassistant'], eintraege: [ha], ruhezeit: () => false, abgelehnt: () => false, inventory: null })).toMatchObject({ tipp: { id: 'ha-abends-aus' } })
        await tippAlleAblehnen('111', opts())
        expect(tippsAus(opts())).toBe(true)
        expect(await tippHeute({ ...opts(), typen: ['homeassistant'], eintraege: [ha], ruhezeit: () => false, abgelehnt: () => false, inventory: null })).toBeNull()
    })

    it('Telegram: the tip offers „Tipps aus“ and it takes effect', async () => {
        const log: Array<{ op: string; text: string; keyboard: any[][] }> = []
        const tg = {
            canSend: async () => true, ownerChatIds: () => ['111'],
            send: async (_c: string, text: string, keyboard: any[][]) => { log.push({ op: 'send', text, keyboard }); return 1 },
            edit: async () => {},
        }
        noteConnected([ha], opts())
        const deps = {
            ...opts(), verbunden: async () => [ha], ruhezeit: () => false, kritisch: () => 0,
            inventory: null,
            fragen: async () => ({ frage: null, wartend: 0 }),
            checklist: { overview: async () => ({ gefunden: [], verbunden: [] }), telegramGekoppelt: () => true },
            isMain: () => true,
        }
        await runGuidedTelegramTick(tg as any, deps)
        const tip = log.find(item => item.text.startsWith('💡'))!
        expect(tip).toBeTruthy()
        expect(tip.text).not.toMatch(/sobald|sag dir Bescheid/)
        const flat = tip.keyboard.flat().map(b => b.text)
        expect(flat).toContain('Tipps aus')
        const off = tip.keyboard.flat().find(b => b.text === 'Tipps aus')!
        const pressed = pressGuided(off.callback_data, { userId: '111', ownerIds: ['111'], chatId: '111' }, opts())
        expect(pressed.aktion).toMatchObject({ art: 'tipp-alle-aus' })
        await runGuidedAction(pressed.aktion!, { chatId: '111', by: 'telegram:111' }, deps)
        await runGuidedTelegramTick(tg as any, { ...deps, now: () => t + 24 * 60 * 60_000 })
        expect(log.filter(item => item.text.startsWith('💡') && !/keine Tipps/.test(item.text)).length).toBeLessThanOrEqual(1)
        expect(tippsAus(opts())).toBe(true)
    })
})
