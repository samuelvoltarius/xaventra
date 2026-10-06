import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ampelKopf, menuKeyboard, ownerText, paginate, pagedView, pressNav, NAV_PREFIX, registerMenuProvider } from './telegram-pages.js'

// Paket L 4: short Telegram messages, details behind „Mehr“, lists paged with
// inline buttons; navigation tokens are owner-only and bound to the chat.

let dir: string
const owner = { userId: '111', ownerIds: ['111'], chatId: '111' }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-pages-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const wall = Array.from({ length: 40 }, (_, i) => `Zeile ${i + 1}: ${'x'.repeat(60)}`).join('\n')

describe('paginate', () => {
    it('keeps every page at ≤ 600 characters and loses nothing', () => {
        const pages = paginate(wall)
        expect(pages.length).toBeGreaterThan(3)
        for (const page of pages) expect(page.length).toBeLessThanOrEqual(600)
        expect(pages.join('\n').replace(/\n+/g, '\n')).toBe(wall)
        expect(paginate('kurz')).toEqual(['kurz'])
        // a single over-long line is still cut into pages
        expect(paginate('y'.repeat(1500)).every(p => p.length <= 600)).toBe(true)
    })
})

describe('Mehr / Seiten-Knöpfe', () => {
    it('first page + „Mehr“; pressing walks the pages in place', () => {
        const view = pagedView('111', wall, { dataDir: dir })
        expect(view.text.length).toBeLessThanOrEqual(700)
        const flat = view.keyboard.flat()
        const more = flat.find(b => /Mehr/.test(b.text))!
        expect(more.callback_data).toMatch(new RegExp(`^${NAV_PREFIX}[a-f0-9]{16}$`))
        expect(Buffer.byteLength(more.callback_data)).toBeLessThanOrEqual(64)
        const next = pressNav(more.callback_data, owner, { dataDir: dir })
        expect(next.ok).toBe(true)
        expect(next.edit!.text).toContain('Zeile')
        expect(next.edit!.text).not.toBe(view.text)
        // pressing again works (navigation is not single-use)
        expect(pressNav(more.callback_data, owner, { dataDir: dir }).ok).toBe(true)
    })

    it('refuses other users, other chats and unknown tokens', () => {
        const view = pagedView('111', wall, { dataDir: dir })
        const token = view.keyboard.flat().find(b => /Mehr/.test(b.text))!.callback_data
        expect(pressNav(token, { userId: '222', ownerIds: ['111'], chatId: '111' }, { dataDir: dir }).ok).toBe(false)
        expect(pressNav(token, { userId: '111', ownerIds: ['111'], chatId: '-100' }, { dataDir: dir }).ok).toBe(false)
        expect(pressNav(`${NAV_PREFIX}0123456789abcdef`, owner, { dataDir: dir }).ok).toBe(false)
        expect(pressNav('nv:../../etc', owner, { dataDir: dir }).ok).toBe(false)
    })

    it('a short text gets no buttons', () => {
        expect(pagedView('111', 'Alles gut.', { dataDir: dir }).keyboard).toEqual([])
    })
})

describe('Kopf mit Ampel und Owner-Texte ohne Kennungen', () => {
    it('one traffic-light sentence', () => {
        expect(ampelKopf({ kritisch: 0, fragen: 0 })).toBe('🟢 Alles läuft — keine Frage offen')
        expect(ampelKopf({ kritisch: 0, fragen: 2 })).toBe('🟡 Alles läuft — 2 Fragen warten')
        expect(ampelKopf({ kritisch: 1, fragen: 1 })).toBe('🔴 1 Problem braucht dich — 1 Frage wartet')
    })

    it('removes ids, hashes, layer numbers and paths', () => {
        const text = ownerText('Gerät dev-0123456789 (Fall th-0123456789ab) in L05 laut /opt/xaventra/data/sensing/devices.json und C:\\Users\\x\\a.json, sha256:abcdef0123456789abcdef, Karte k0123456789ab.')
        expect(text).not.toMatch(/dev-|th-|L05|\/opt|C:\\|sha256|k0123456789ab/)
        expect(text).toMatch(/^Gerät/)
        expect(ownerText('Bitte anmelden: http://ha.example.com/auth/authorize?x=1')).toBe('Bitte anmelden: http://ha.example.com/auth/authorize?x=1')
    })
})

describe('Hauptmenü', () => {
    it('has the five fixed entries with the open-question count and runs the provider in place', async () => {
        registerMenuProvider('fragen', async () => ({ titel: 'Braucht dich', text: 'Hue Bridge koppeln?' }))
        const keyboard = menuKeyboard('111', { fragen: 2 }, { dataDir: dir })
        expect(keyboard.flat().map(b => b.text)).toEqual(['Status', 'Braucht mich (2)', 'Geräte', 'Bericht', 'Mehr'])
        const result = pressNav(keyboard.flat()[1].callback_data, owner, { dataDir: dir })
        expect(result.ok).toBe(true)
        expect(result.menu).toBe('fragen')
    })
})
