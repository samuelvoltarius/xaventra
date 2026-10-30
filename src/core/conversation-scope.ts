/**
 * Ein Weg: the one answer to „which history does this turn belong to?“.
 *
 * The owner has one history across Telegram, HUD, CLI and every Desktop room
 * explicitly marked `ownerHistory` (TopicRoom, e.g. the Zentrale). A room
 * without the mark keeps its own history — acceptance and probe rooms stay
 * isolated — and a non-owner is never moved into the owner history, whatever
 * the room says. The mark is explicit data, never derived from a title.
 */
import type { SessionScope } from '../agents/session-checkpoints.js'

export interface ConversationRoom { roomId: string; botId: string; ownerHistory?: boolean }

export function conversationScope(room: ConversationRoom | undefined, actor: { owner: boolean }): SessionScope {
    if (!room) return {}
    return room.ownerHistory === true && actor.owner
        ? { botId: room.botId }
        : { conversationId: room.roomId, botId: room.botId }
}
