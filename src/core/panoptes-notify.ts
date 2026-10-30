/** Telegram delivery for the Panoptes still: the owner's own chats only. Sensing never knows a channel. */
export async function telegramPanoptesNotify(path: string | null, text: string): Promise<boolean> {
    const { getTelegramAdapter } = await import('../channels/telegram.js')
    const telegram = getTelegramAdapter() as any
    const chats: string[] = telegram?.getOwnerChatIds?.() || []
    let delivered = false
    for (const chat of chats) {
        try {
            if (path) await telegram.sendPhoto(chat, path, text.slice(0, 1000))
            else await telegram.sendMessage(chat, text)
            delivered = true
        } catch { /* honest in the result, no retry */ }
    }
    return delivered
}
