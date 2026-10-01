/**
 * Integration Phase 1 (2.81.0): planner thoughts and briefings reach Alfred.
 *
 * - The planner's single delivery port is wired to Telegram here (Main only,
 *   live Main + Telegram authority per delivery; otherwise FenceError, so the
 *   planner keeps the message pending).
 * - A thought with permission `fragen` becomes a Knopf-Karte (kind `gedanke`);
 *   the card loop sends it, the card store decides on the press (owner only,
 *   one-time code tokens). Ja closes the thought as `erledigt`, Nein as
 *   `verworfen`. A `nie` thought never gets a card.
 * - Everything else (briefings, plain thoughts, job results) goes as plain
 *   text to the numeric owner chats.
 */
import { FenceError } from '../mesh/fence.js'
import type { DeliveryPort, DeliveryReceipt, PlannerOutgoing } from '../planner/index.js'
import { getThought, isOpenThought, setThoughtStatus } from '../planner/index.js'
import { createApprovalCard, registerCardExecutor } from './approval-cards.js'

export interface PlannerTelegramTarget {
    hasCardAuthority(): Promise<boolean>
    getOwnerChatIds(): string[]
    sendApprovalCard(chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<number | null>
}

let executorRegistered = false
export function registerThoughtCardExecutor(): void {
    if (executorRegistered) return
    executorRegistered = true
    registerCardExecutor({
        kind: 'gedanke',
        impact: 'intern',
        async execute(card, _answer, ctx) {
            const thought = setThoughtStatus(card.aktion.ref, 'erledigt', ctx.decidedBy)
            return thought ? { ok: true, message: 'Angenommen.' } : { ok: false, message: 'Gedanke nicht mehr vorhanden.' }
        },
        async reject(card, ctx) {
            setThoughtStatus(card.aktion.ref, 'verworfen', ctx.decidedBy)
            return { ok: true, message: 'Verworfen.' }
        },
        isStillOpen(card) {
            const thought = getThought(card.aktion.ref)
            return Boolean(thought && (thought.status === 'wartet-auf-knopf' || isOpenThought(thought)))
        },
    })
}

export function createPlannerTelegramPort(target: PlannerTelegramTarget): DeliveryPort {
    return {
        name: 'telegram-karten',
        async deliver(msg: PlannerOutgoing): Promise<DeliveryReceipt> {
            if (!(await target.hasCardAuthority())) throw new FenceError('telegram', 'no live Main/Telegram authority', 'planner-delivery')
            if (msg.thoughtId && msg.permission === 'fragen') {
                registerThoughtCardExecutor()
                const thought = getThought(msg.thoughtId)
                const created = createApprovalCard({
                    art: 'gedanke',
                    titel: msg.title,
                    beleg: msg.text,
                    vorschlag: thought?.proposal || msg.title,
                    aktion: { kind: 'gedanke', ref: msg.thoughtId },
                    dedupeKey: `gedanke:${msg.thoughtId}`,
                    quelle: thought?.source || 'planer',
                })
                if (created.ok === false) return { status: 'fehler', detail: 'reason' in created ? created.reason : '' } as DeliveryReceipt
                setThoughtStatus(msg.thoughtId, 'wartet-auf-knopf', 'karte')
                return { status: 'zugestellt' } as DeliveryReceipt
            }
            if (msg.thoughtId && msg.permission === 'nie') {
                // Never a button; the thought stays visible in /gedanken.
                return { status: 'zugestellt' } as DeliveryReceipt
            }
            const chats = target.getOwnerChatIds()
            if (!chats.length) return { status: 'kein-port' } as DeliveryReceipt
            const text = msg.title && !msg.text.startsWith(msg.title) ? `${msg.title}\n\n${msg.text}` : msg.text
            for (const chatId of chats) await target.sendApprovalCard(chatId, text, [])
            return { status: 'zugestellt' } as DeliveryReceipt
        },
    }
}
