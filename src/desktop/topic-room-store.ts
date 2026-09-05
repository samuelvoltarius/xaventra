import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export interface TopicRoom {
    id: string
    ownerId: string
    title: string
    topic: string
    botIds: string[]
    preferredNodeIds: string[]
    modelMode: 'auto' | 'pinned'
    pinnedModel?: string
    pinnedRouteId?: string
    /** Opaque client-local workspace handle; never a filesystem path. */
    workspaceId?: string
    /** Explicit governed memory assets equipped for this room. */
    memoryAssetIds: string[]
    archived: boolean
    createdAt: string
    updatedAt: string
}

export interface RoomMessage {
    id: string
    roomId: string
    authorType: 'user' | 'bot' | 'system' | 'tool'
    authorId: string
    content: string
    createdAt: string
    model?: string
    node?: string
    runId?: string
    verifiedEvidence: number
    evidence?: {
        durationMs: number
        tools: Array<{ name: string; success: boolean }>
        action?: { requiresTool: boolean; kind: string; fulfilled: boolean; awaitingApproval: boolean; phase: string }
    }
}

interface RoomData { rooms: TopicRoom[]; messages: RoomMessage[] }
type RoomInput = Pick<TopicRoom, 'title' | 'topic' | 'botIds' | 'preferredNodeIds' | 'modelMode'> & { pinnedModel?: string; pinnedRouteId?: string; workspaceId?: string; memoryAssetIds?: string[] }

function clean(value: unknown, max: number): string { return String(value || '').trim().slice(0, max) }
function unique(values: unknown, max: number): string[] {
    if (!Array.isArray(values)) return []
    return [...new Set(values.map(value => clean(value, 100)).filter(Boolean))].slice(0, max)
}

export class TopicRoomStore {
    private data: RoomData = { rooms: [], messages: [] }

    constructor(private readonly file = join(process.cwd(), '.nova-data', 'desktop', 'rooms.json')) { this.load() }

    listRooms(ownerId: string, includeArchived = false): TopicRoom[] {
        return this.data.rooms.filter(room => room.ownerId === ownerId && (includeArchived || !room.archived))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(room => structuredClone(room))
    }

    getRoom(id: string, ownerId: string): TopicRoom | undefined {
        const room = this.data.rooms.find(item => item.id === id && item.ownerId === ownerId)
        return room ? structuredClone(room) : undefined
    }

    createRoom(ownerId: string, input: RoomInput): TopicRoom {
        const now = new Date().toISOString()
        const room: TopicRoom = {
            id: `room-${randomUUID()}`, ownerId, title: clean(input.title, 120) || 'Neues Thema', topic: clean(input.topic, 500),
            botIds: unique(input.botIds || ['nova'], 16), preferredNodeIds: unique(input.preferredNodeIds || [], 16),
            modelMode: input.modelMode === 'pinned' ? 'pinned' : 'auto', pinnedModel: clean(input.pinnedModel, 200) || undefined,
            pinnedRouteId: clean(input.pinnedRouteId, 500) || undefined,
            workspaceId: clean(input.workspaceId, 120) || undefined,
            memoryAssetIds: unique(input.memoryAssetIds || [], 100),
            archived: false, createdAt: now, updatedAt: now,
        }
        if (room.botIds.length === 0) room.botIds = ['nova']
        if (room.modelMode === 'pinned' && !room.pinnedModel) throw new Error('Pinned rooms require a model')
        this.data.rooms.push(room)
        this.save()
        return structuredClone(room)
    }

    updateRoom(id: string, ownerId: string, updates: Partial<RoomInput & { archived: boolean }>): TopicRoom {
        const room = this.data.rooms.find(item => item.id === id && item.ownerId === ownerId)
        if (!room) throw new Error('Room not found')
        if (updates.title !== undefined) room.title = clean(updates.title, 120) || room.title
        if (updates.topic !== undefined) room.topic = clean(updates.topic, 500)
        if (updates.botIds) room.botIds = unique(updates.botIds, 16)
        if (updates.preferredNodeIds) room.preferredNodeIds = unique(updates.preferredNodeIds, 16)
        if (updates.modelMode) room.modelMode = updates.modelMode === 'pinned' ? 'pinned' : 'auto'
        if (updates.pinnedModel !== undefined) room.pinnedModel = clean(updates.pinnedModel, 200) || undefined
        if (updates.pinnedRouteId !== undefined) room.pinnedRouteId = clean(updates.pinnedRouteId, 500) || undefined
        if (updates.workspaceId !== undefined) room.workspaceId = clean(updates.workspaceId, 120) || undefined
        if (updates.memoryAssetIds !== undefined) room.memoryAssetIds = unique(updates.memoryAssetIds, 100)
        if (updates.archived !== undefined) room.archived = Boolean(updates.archived)
        if (room.botIds.length === 0) room.botIds = ['nova']
        if (room.modelMode === 'pinned' && !room.pinnedModel) throw new Error('Pinned rooms require a model')
        room.updatedAt = new Date().toISOString()
        this.save()
        return structuredClone(room)
    }

    addMessage(ownerId: string, roomId: string, input: Omit<RoomMessage, 'id' | 'roomId' | 'createdAt'>): RoomMessage {
        const room = this.data.rooms.find(item => item.id === roomId && item.ownerId === ownerId)
        if (!room) throw new Error('Room not found')
        const message: RoomMessage = { ...input, id: `msg-${randomUUID()}`, roomId, content: clean(input.content, 100_000), createdAt: new Date().toISOString(), verifiedEvidence: Math.max(0, Number(input.verifiedEvidence || 0)) }
        this.data.messages.push(message)
        const roomMessages = this.data.messages.filter(item => item.roomId === roomId)
        if (roomMessages.length > 1_000) {
            const remove = new Set(roomMessages.slice(0, roomMessages.length - 1_000).map(item => item.id))
            this.data.messages = this.data.messages.filter(item => !remove.has(item.id))
        }
        room.updatedAt = message.createdAt
        this.save()
        return structuredClone(message)
    }

    listMessages(ownerId: string, roomId: string, limit = 200): RoomMessage[] {
        if (!this.data.rooms.some(room => room.id === roomId && room.ownerId === ownerId)) throw new Error('Room not found')
        return this.data.messages.filter(item => item.roomId === roomId).slice(-Math.max(1, Math.min(1_000, limit))).map(item => structuredClone(item))
    }

    private load(): void {
        if (!existsSync(this.file)) return
        try { const value = JSON.parse(readFileSync(this.file, 'utf8')); if (Array.isArray(value.rooms) && Array.isArray(value.messages)) { this.data = value; this.data.rooms = this.data.rooms.map(room => ({ ...room, memoryAssetIds: Array.isArray(room.memoryAssetIds) ? room.memoryAssetIds : [] })) } }
        catch { /* corrupted projection starts empty */ }
    }

    private save(): void { mkdirSync(dirname(this.file), { recursive: true }); atomicWriteJsonSync(this.file, this.data) }
}

let singleton: TopicRoomStore | null = null
export function getTopicRoomStore(): TopicRoomStore { return singleton ||= new TopicRoomStore() }
