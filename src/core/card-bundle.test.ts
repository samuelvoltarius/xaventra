import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { answerApprovalCard, createApprovalCard, maintainApprovalCards, registerCardExecutor, unregisterCardExecutor } from './approval-cards.js'
import { deliverBundles, renderBundle } from './card-bundle.js'

// Paket L 3: ONE bundled Telegram message with inline buttons per device; it
// is edited when something changes instead of sending new messages.

let dir: string
let t: number
const HOUR = 60 * 60_000
const opts = () => ({ dataDir: dir, now: () => t, ledger: null })
const add = (ref: string, kurz: string, extra: Record<string, unknown> = {}) => createApprovalCard({
    art: 'geraet-verbinden', titel: `${kurz} verbinden?`, beleg: 'Fund im Heimnetz', vorschlag: 'Ja = verbinden', aktion: { kind: 'geraet-verbinden', ref },
    buendel: 'geraete', kurz, ablaufMs: 72 * HOUR, ...extra,
} as any, opts())
function fakeTelegram() {
    const log: Array<{ op: 'send' | 'edit'; chatId: string; messageId?: number; text: string; keyboard: any[][] }> = []
    let id = 100
    return {
        log,
        canSend: async () => true, ownerChatIds: () => ['111'],
        send: async (chatId: string, text: string, keyboard: any[][]) => { log.push({ op: 'send', chatId, text, keyboard }); return ++id },
        edit: async (chatId: string, messageId: number, text: string, keyboard: any[][]) => { log.push({ op: 'edit', chatId, messageId, text, keyboard }) },
    }
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'card-bundle-l-'))
    t = Date.parse('2026-10-06T10:00:00.000Z')
    registerCardExecutor({ kind: 'geraet-verbinden', impact: 'intern', async execute() { return { ok: true, message: 'verbunden' } }, async reject() { return { ok: true, message: 'nein' } } })
})
afterEach(() => { unregisterCardExecutor('geraet-verbinden'); rmSync(dir, { recursive: true, force: true }) })

describe('gebündelte Geräte-Nachricht', () => {
    it('one message, ≤ 600 characters, one Ja/Nein pair per device bound to that device card', async () => {
        add('dev-0000000001', 'Home Assistant'); add('dev-0000000002', 'Hue Bridge')
        add('dev-0000000003:local', 'Tuya-Gerät', { gruppe: 'g-tuya', knopf: 'Lokal' }); add('dev-0000000003:cloud', 'Tuya-Gerät', { gruppe: 'g-tuya', knopf: 'Cloud' })
        const tg = fakeTelegram()
        expect(await deliverBundles(tg, opts())).toBe(1)
        expect(tg.log).toHaveLength(1)
        const message = tg.log[0]
        expect(message.text.length).toBeLessThanOrEqual(600)
        expect(message.text).toMatch(/^🟡 3 Geräte gefunden/)
        expect(message.text).not.toMatch(/dev-\d/)
        const labels = message.keyboard.flat().map(b => b.text)
        expect(labels.filter(l => /^✅/.test(l))).toHaveLength(2)
        expect(labels).toEqual(expect.arrayContaining(['🏠 Lokal', '☁️ Cloud']))
        for (const button of message.keyboard.flat()) expect(button.callback_data).toMatch(/^(ac|nv):[a-f0-9]{16}$/)
        // no change → no new message, no edit
        expect(await deliverBundles(tg, opts())).toBe(0)
        expect(tg.log).toHaveLength(1)
    })

    it('a press answers only that device and the bundle is edited, not resent', async () => {
        add('dev-0000000001', 'Home Assistant'); add('dev-0000000002', 'Hue Bridge')
        const tg = fakeTelegram()
        await deliverBundles(tg, opts())
        const ja = tg.log[0].keyboard.flat().find(b => /Hue/.test(b.text))!
        const result = await answerApprovalCard(ja.callback_data, { userId: '111', ownerIds: ['111'] }, opts())
        expect(result.ok).toBe(true)
        expect(result.card?.aktion.ref).toBe('dev-0000000002')
        // the other device's buttons still work
        expect(await deliverBundles(tg, opts())).toBe(1)
        expect(tg.log.at(-1)!.op).toBe('edit')
        expect(tg.log.at(-1)!.text).not.toMatch(/Hue/)
        expect(tg.log.at(-1)!.text).toMatch(/Home Assistant/)
        // a stranger cannot press
        const other = tg.log.at(-1)!.keyboard.flat().find(b => /Home/.test(b.text))!
        expect((await answerApprovalCard(other.callback_data, { userId: '222', ownerIds: ['111'] }, opts())).code).toBe('kein-owner')
    })

    it('reminds once as a new message, then the expired devices go to the report', async () => {
        add('dev-0000000001', 'Home Assistant')
        const tg = fakeTelegram()
        await deliverBundles(tg, opts())
        t += 60 * HOUR // 12 h left of 72 h
        expect(maintainApprovalCards(opts()).reminded).toHaveLength(1)
        expect(await deliverBundles(tg, opts())).toBe(1)
        expect(tg.log.at(-1)!.op).toBe('send')
        expect(tg.log.at(-1)!.text).toMatch(/Erinnerung/)
        t += HOUR
        expect(await deliverBundles(tg, opts())).toBe(0)
        t += 12 * HOUR
        expect(maintainApprovalCards(opts()).expired).toHaveLength(1)
        await deliverBundles(tg, opts())
        expect(tg.log.at(-1)!.op).toBe('edit')
        expect(tg.log.at(-1)!.text).toMatch(/Bericht/)
        expect(tg.log.at(-1)!.keyboard).toEqual([])
    })

    it('pages long lists with navigation buttons', () => {
        for (let i = 1; i <= 8; i++) add(`dev-000000000${i}`, `Gerät ${i}`)
        const view = renderBundle('geraete', '111', opts())!
        expect(view.text.length).toBeLessThanOrEqual(600)
        expect(view.keyboard.flat().filter(b => /^✅/.test(b.text))).toHaveLength(5)
        expect(view.keyboard.flat().some(b => /▶/.test(b.text))).toBe(true)
    })
})
