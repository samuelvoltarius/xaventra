/**
 * Integration Phase 1 (2.81.0): planner thoughts and briefings reach Alfred.
 *
 * - The planner's single delivery port is wired to Telegram here (Main only,
 *   live Main + Telegram authority per delivery; otherwise FenceError, so the
 *   planner keeps the message pending).
 * - A thought with permission `fragen` becomes a Knopf-Karte (kind `gedanke`)
 *   only when the thought hub knows an executor for it (2.86 Punkt 5:
 *   `hasThoughtAction`); without one it goes out as plain text;
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
            if (!thought) return { ok: false, message: 'Gedanke nicht mehr vorhanden.' }
            const { dispatchThoughtAnswer } = await import('./thought-hub.js')
            return dispatchThoughtAnswer(card.aktion.ref, 'ja', { userId: ctx.userId })
        },
        async reject(card, ctx) {
            setThoughtStatus(card.aktion.ref, 'verworfen', ctx.decidedBy)
            const { dispatchThoughtAnswer } = await import('./thought-hub.js')
            return dispatchThoughtAnswer(card.aktion.ref, 'nein', { userId: ctx.userId })
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
            // 2.86 Punkt 5: a question only becomes a card when its Ja runs something;
            // otherwise it goes out as plain text below (and stays in /gedanken and the report).
            const answerable = msg.thoughtId && msg.permission === 'fragen'
                ? await import('./thought-hub.js').then(hub => hub.hasThoughtAction(msg.thoughtId!)).catch(() => false)
                : false
            if (msg.thoughtId && answerable) {
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
                    // P8: only an urgent thought asks at once; the rest waits for the next report.
                    wichtigkeit: thought?.importance === 'dringend' || msg.urgency === 'dringend' ? 'hoch' : 'normal',
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
            const { pagedView, sectionedView, rememberLastReport, OWNER_SYSTEM_MAX_PAGES } = await import('../channels/telegram-pages.js')
            const { ownerText } = await import('./owner-text.js')
            // Paket L: a report is one short overview with a button per section (+ main menu);
            // every other owner message is short with „Mehr“ and free of technical ids.
            if (msg.kind === 'briefing' && Array.isArray(msg.sections)) {
                try { rememberLastReport({ titel: msg.title, kopf: msg.kopf || '', sections: msg.sections }) } catch { /* menu „Bericht“ then shows nothing */ }
                const fragen = msg.sections.filter(section => ['Wartet auf dich', 'Fragen gesammelt'].includes(section.titel)).reduce((sum, section) => sum + section.zeilen.length, 0)
                for (const chatId of chats) {
                    const view = sectionedView(chatId, { kopf: msg.kopf || '', titel: msg.title, sections: msg.sections }, { counts: { fragen } })
                    await target.sendApprovalCard(chatId, view.text, view.keyboard)
                }
                return { status: 'zugestellt' } as DeliveryReceipt
            }
            const text = msg.title && !msg.text.startsWith(msg.title) ? `${msg.title}\n\n${msg.text}` : msg.text
            const plain = msg.kind === 'erinnerung' ? text : ownerText(text)
            // 2.86 Paket M: every system message starts with a traffic light + one sentence (reminders are the owner's own words).
            const { systemKopf } = await import('../guided/ampel.js')
            const kopf = msg.kind === 'gedanke' || msg.kind === 'job' ? systemKopf(msg) : undefined
            for (const chatId of chats) {
                const view = pagedView(chatId, plain, { ...(kopf ? { kopf } : {}), maxPages: OWNER_SYSTEM_MAX_PAGES })
                await target.sendApprovalCard(chatId, view.text, view.keyboard)
            }
            return { status: 'zugestellt' } as DeliveryReceipt
        },
    }
}
