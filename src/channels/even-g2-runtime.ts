/**
 * Even G2 wiring for the daemon (Phase 5a): connects the endpoint in
 * even-g2.ts to the real message pipeline, the /jetzt data, the Knopf-Karten
 * and Telegram. Main only — the daemon does not call this on a worker and
 * startEvenG2Channel refuses there as well.
 */
import { EVEN_G2_CHANNEL, EVEN_G2_PRINCIPAL, answerCardFromG2, buildHudSnapshot, formatForG2, startEvenG2Channel, type EvenG2Deps, type EvenG2Server } from './even-g2.js'
import type { ApprovalCard } from '../core/approval-cards.js'

export type EvenG2MessageHandler = (
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    image?: { data: string; mimeType: string },
    execution?: { abortSignal?: AbortSignal },
    messageContext?: { chatId?: string },
) => Promise<unknown>

export interface EvenG2RuntimeHooks {
    handleMessage: EvenG2MessageHandler
    /** Numeric Telegram owner ids (allowFrom). */
    ownerIds(): string[]
    sendTelegram(chatId: string, text: string): Promise<void>
    /** Update the Telegram copies of a card answered on the glasses. */
    syncCard?(card: ApprovalCard): Promise<void>
}

const short = (value: unknown, max = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

export function numericOwnerIds(config: any): string[] {
    const allowFrom = config?.channels?.telegram?.allowFrom
    return Array.isArray(allowFrom) ? allowFrom.map((item: unknown) => String(item).trim()).filter((item: string) => /^\d{1,20}$/.test(item)) : []
}

export function createEvenG2RuntimeDeps(token: string, hooks: EvenG2RuntimeHooks): EvenG2Deps {
    return {
        token,
        async ask(question, signal) {
            // The token is the owner's credential (like the desktop token):
            // the even-g2 principal is bound to this channel and granted owner.
            const users = await import('../users/multi-user-middleware.js')
            users.initMultiUser()
            users.getOrCreateUser(EVEN_G2_PRINCIPAL, EVEN_G2_CHANNEL, 'Even G2')
            users.setUserPermission(EVEN_G2_PRINCIPAL, 'owner')
            let reply = ''
            await hooks.handleMessage(EVEN_G2_CHANNEL, EVEN_G2_PRINCIPAL, question, async message => { reply = String(message ?? '') }, undefined, { abortSignal: signal }, { chatId: EVEN_G2_PRINCIPAL })
            return reply
        },
        async overflow(question, answer) {
            const owner = hooks.ownerIds()[0]
            if (!owner) {
                console.warn('[EvenG2] Antwort zu spät für die Brille, aber kein Telegram-Owner konfiguriert — nur im Protokoll.')
                return
            }
            await hooks.sendTelegram(owner, `Even G2 — Antwort auf „${short(question)}“:\n\n${String(answer || 'Keine Antwort.').slice(0, 3_500)}`)
        },
        async fence(effect) {
            const { assertFenced } = await import('../mesh/fence.js')
            await assertFenced('nova-main', { live: true, effect })
        },
        async hudSnapshot() {
            const { collectJetzt } = await import('../core/now-view.js')
            const snapshot = await collectJetzt()
            const task = snapshot.tasks[0]
            const more = snapshot.tasks.length > 1 ? ` (+${snapshot.tasks.length - 1})` : ''
            const status = task ? `${task.label}${more}` : snapshot.queue.length ? `Wartet: ${snapshot.queue[0]}` : 'Bereit — keine laufende Aufgabe'
            return buildHudSnapshot({ status: formatForG2(status, 120), openCards: snapshot.openCards })
        },
        async answerCard(cardId, answer) {
            const { ensureBuiltinCardExecutors } = await import('../core/approval-card-sources.js')
            await ensureBuiltinCardExecutors()
            const result = await answerCardFromG2(cardId, answer, { ownerIds: hooks.ownerIds() })
            if (result.status === 200 && hooks.syncCard) {
                try {
                    const { listApprovalCards } = await import('../core/approval-cards.js')
                    const card = listApprovalCards().find(item => item.id === cardId)
                    if (card) await hooks.syncCard(card)
                } catch { /* the decision is stored; the Telegram copy is cosmetic */ }
            }
            return result
        },
    }
}

export async function startEvenG2FromDaemon(config: any, handleMessage: EvenG2MessageHandler, env: NodeJS.ProcessEnv = process.env): Promise<EvenG2Server | null> {
    const telegram = async () => (await import('./telegram.js')).getTelegramAdapter()
    let ownerCache = numericOwnerIds(config)
    try { const tg = await telegram(); if (tg) ownerCache = tg.getOwnerChatIds() } catch { /* config fallback */ }
    return startEvenG2Channel(config, env, token => createEvenG2RuntimeDeps(token, {
        handleMessage,
        ownerIds: () => ownerCache,
        async sendTelegram(chatId, text) {
            const tg = await telegram()
            if (!tg) throw new Error('Telegram nicht verbunden')
            await tg.send({ channel: 'telegram', to: chatId, content: text })
        },
        async syncCard(card) {
            const tg = await telegram()
            const { formatCardText } = await import('../core/approval-cards.js')
            await tg?.syncApprovalCardMessages(card, formatCardText(card))
        },
    }))
}
