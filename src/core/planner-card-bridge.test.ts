import { describe, expect, it, vi } from 'vitest'
import { addThought, getThought, listThoughts } from '../planner/index.js'
import { answerApprovalCard, listApprovalCards } from './approval-cards.js'
import { createPlannerTelegramPort, registerThoughtCardExecutor } from './planner-card-bridge.js'
import { rememberAutoReminderAction } from './thought-hub.js'
import { collectGedanken } from './now-view.js'

function fakeTelegram(authority = true) {
    return {
        hasCardAuthority: vi.fn(async () => authority),
        getOwnerChatIds: vi.fn(() => ['1413797900']),
        sendApprovalCard: vi.fn(async () => 42),
    }
}

const base = { createdAt: new Date().toISOString(), urgency: 'normal' as const }

describe('planner → Telegram/Knopf-Karten (Integration Phase 1)', () => {
    it('a thought with permission "fragen" becomes a Knopf-Karte and waits for the button', async () => {
        const { thought } = addThought({ source: 'test', title: 'Druck gleich fertig', severity: 'warning', proposal: 'Nächsten Druck vorbereiten', permission: 'fragen', signature: 'bridge-fragen' })
        // 2.86 Punkt 5: only a question with an executor becomes a card.
        rememberAutoReminderAction(thought.id, 'ar-00000000000a')
        const tg = fakeTelegram()
        const receipt = await createPlannerTelegramPort(tg).deliver({ id: 'out-000000000001', kind: 'gedanke', title: thought.title, text: 'Beleg', permission: 'fragen', thoughtId: thought.id, ...base })
        expect(receipt?.status).toBe('zugestellt')
        const card = listApprovalCards({ status: 'offen' }).find(item => item.aktion.ref === thought.id)
        expect(card?.aktion.kind).toBe('gedanke')
        expect(getThought(thought.id)?.status).toBe('wartet-auf-knopf')
        // the card loop sends the card itself, the port does not send a second copy
        expect(tg.sendApprovalCard).not.toHaveBeenCalled()
    })

    it('a briefing goes as plain text to every numeric owner chat, without buttons', async () => {
        const tg = fakeTelegram()
        const receipt = await createPlannerTelegramPort(tg).deliver({ id: 'out-000000000002', kind: 'briefing', title: 'Morgenbericht', text: 'Alles ruhig.', ...base })
        expect(receipt?.status).toBe('zugestellt')
        expect(tg.sendApprovalCard).toHaveBeenCalledWith('1413797900', expect.stringContaining('Morgenbericht'), [])
    })

    it('without live Main/Telegram authority the delivery is fenced (stays pending, nothing sent)', async () => {
        const tg = fakeTelegram(false)
        await expect(createPlannerTelegramPort(tg).deliver({ id: 'out-000000000003', kind: 'briefing', title: 'x', text: 'y', ...base })).rejects.toMatchObject({ code: 'FENCED' })
        expect(tg.sendApprovalCard).not.toHaveBeenCalled()
    })

    it('a "nie" thought never gets a card', async () => {
        const { thought } = addThought({ source: 'test', title: 'NAS neu starten', severity: 'warning', proposal: 'Neustart', permission: 'nie', signature: 'bridge-nie' })
        const tg = fakeTelegram()
        await createPlannerTelegramPort(tg).deliver({ id: 'out-000000000004', kind: 'gedanke', title: thought.title, text: 'Beleg', permission: 'nie', thoughtId: thought.id, ...base })
        expect(listApprovalCards().some(card => card.aktion.ref === thought.id)).toBe(false)
    })

    it('Ja closes the thought as erledigt, Nein as verworfen — only the owner can press', async () => {
        registerThoughtCardExecutor()
        const owner = { userId: '1413797900', ownerIds: ['1413797900'] }
        for (const [answerIndex, expected] of [[0, 'erledigt'], [1, 'verworfen']] as const) {
            const { thought } = addThought({ source: 'test', title: `Idee ${expected}`, severity: 'warning', proposal: 'p', permission: 'fragen', signature: `bridge-press-${expected}` })
            rememberAutoReminderAction(thought.id, `ar-00000000000${answerIndex}`)
            await createPlannerTelegramPort(fakeTelegram()).deliver({ id: `out-00000000001${answerIndex}`, kind: 'gedanke', title: thought.title, text: 'b', permission: 'fragen', thoughtId: thought.id, ...base })
            const card = listApprovalCards({ status: 'offen' }).find(item => item.aktion.ref === thought.id)!
            const stranger = await answerApprovalCard(`ac:${card.buttons[answerIndex].token}`, { userId: '999', ownerIds: ['1413797900'] })
            expect(stranger.ok).toBe(false)
            expect(getThought(thought.id)?.status).toBe('wartet-auf-knopf')
            const pressed = await answerApprovalCard(`ac:${card.buttons[answerIndex].token}`, owner)
            expect(pressed.ok).toBe(true)
            expect(getThought(thought.id)?.status).toBe(expected)
        }
    })

    it('/gedanken also lists the planner thoughts', async () => {
        addThought({ source: 'nachtwache', title: 'Platte Spark 91 %', severity: 'warning', signature: 'bridge-gedanken' })
        const items = await collectGedanken()
        expect(items.some(item => item.text.includes('Platte Spark 91 %'))).toBe(true)
        expect(listThoughts().length).toBeGreaterThan(0)
    })
})
