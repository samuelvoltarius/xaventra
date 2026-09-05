import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'

export type DesktopControlAction = 'navigate' | 'open_room' | 'select_model' | 'refresh' | 'focus' | 'notify'
    | 'capture_screen' | 'workspace_operation'
export type DesktopSection = 'chat' | 'bots' | 'nodes' | 'modules' | 'security' | 'trust' | 'memory' | 'settings'

export interface DesktopControlCommand {
    id: string
    ownerId: string
    action: DesktopControlAction
    payload: { section?: DesktopSection; roomId?: string; model?: string; message?: string; workspaceId?: string; operation?: 'list' | 'read' | 'search'; relativePath?: string; query?: string }
    source: string
    status: 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'expired'
    clientId?: string
    targetClientId?: string
    createdAt: string
    expiresAt: string
    deliveredAt?: string
    acknowledgedAt?: string
    error?: string
    result?: DesktopControlResult
}

export interface DesktopCaptureResult {
    kind: 'screen_capture'
    path: string
    mimeType: 'image/png' | 'image/jpeg'
    size: number
    sha256: string
    width?: number
    height?: number
}

export interface DesktopWorkspaceResult {
    kind: 'workspace_result'
    operation: 'list' | 'read' | 'search'
    workspaceId: string
    rootName: string
    relativePath: string
    entries?: Array<{ name: string; type: 'file' | 'directory' | 'other'; relativePath: string }>
    content?: string
    sha256?: string
    query?: string
    matches?: Array<{ relativePath: string; line: number; preview: string }>
}

export type DesktopControlResult = DesktopCaptureResult | DesktopWorkspaceResult

const SECTIONS = new Set<DesktopSection>(['chat', 'bots', 'nodes', 'modules', 'security', 'trust', 'memory', 'settings'])
const ACTIONS = new Set<DesktopControlAction>(['navigate', 'open_room', 'select_model', 'refresh', 'focus', 'notify', 'capture_screen', 'workspace_operation'])

function clean(value: unknown, limit: number): string {
    return String(value || '').trim().slice(0, limit)
}

export class DesktopControlQueue {
    private commands: DesktopControlCommand[] = []

    constructor(private readonly file = join(process.cwd(), '.nova-data', 'desktop', 'control-commands.json')) {
        this.load()
    }

    enqueue(ownerId: string, action: DesktopControlAction, raw: DesktopControlCommand['payload'], source = 'nova-tool', targetClientId?: string): DesktopControlCommand {
        if (!ACTIONS.has(action)) throw new Error('Desktop action is not allowed')
        const payload: DesktopControlCommand['payload'] = {}
        if (raw.section !== undefined) {
            if (!SECTIONS.has(raw.section)) throw new Error('Desktop section is not allowed')
            payload.section = raw.section
        }
        if (raw.roomId !== undefined) payload.roomId = clean(raw.roomId, 200)
        if (raw.model !== undefined) payload.model = clean(raw.model, 200)
        if (raw.message !== undefined) payload.message = clean(raw.message, 500)
        if (raw.workspaceId !== undefined) payload.workspaceId = clean(raw.workspaceId, 120)
        if (raw.operation !== undefined && ['list', 'read', 'search'].includes(raw.operation)) payload.operation = raw.operation
        if (raw.relativePath !== undefined) payload.relativePath = clean(raw.relativePath, 1_000)
        if (raw.query !== undefined) payload.query = clean(raw.query, 200)
        if (action === 'navigate' && !payload.section) throw new Error('navigate requires a section')
        if (action === 'open_room' && !payload.roomId) throw new Error('open_room requires a roomId')
        if (action === 'select_model' && !payload.model) throw new Error('select_model requires a model')
        if (action === 'notify' && !payload.message) throw new Error('notify requires a message')
        if (action === 'workspace_operation' && (!payload.workspaceId || !payload.operation)) throw new Error('workspace_operation requires workspaceId and operation')
        if (action === 'workspace_operation' && !targetClientId) throw new Error('workspace_operation requires an exact desktop client target')

        this.expire()
        const now = Date.now()
        const command: DesktopControlCommand = {
            id: `desktop-${randomUUID()}`,
            ownerId: clean(ownerId, 200), action, payload, source: clean(source, 120), status: 'pending',
            ...(targetClientId ? { targetClientId: clean(targetClientId, 120) } : {}),
            createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(),
        }
        this.commands.push(command)
        this.commands = this.commands.slice(-500)
        this.save()
        return structuredClone(command)
    }

    next(ownerId: string, clientId: string): DesktopControlCommand | null {
        this.expire()
        const safeClientId = clean(clientId, 120)
        const command = this.commands.find(item => item.ownerId === ownerId && item.status === 'pending' && (!item.targetClientId || item.targetClientId === safeClientId))
        if (!command) return null
        command.status = 'delivered'
        command.clientId = safeClientId
        command.deliveredAt = new Date().toISOString()
        this.save()
        return structuredClone(command)
    }

    acknowledge(ownerId: string, id: string, clientId: string, success: boolean, error?: string, result?: DesktopControlResult): DesktopControlCommand {
        const command = this.commands.find(item => item.id === id && item.ownerId === ownerId)
        if (!command || command.status !== 'delivered' || command.clientId !== clean(clientId, 120)) {
            throw new Error('Desktop command delivery does not match this client')
        }
        command.status = success ? 'acknowledged' : 'failed'
        command.acknowledgedAt = new Date().toISOString()
        if (!success) command.error = clean(error, 300) || 'Desktop client rejected the command'
        if (success && result) command.result = structuredClone(result)
        this.save()
        return structuredClone(command)
    }

    get(ownerId: string, id: string): DesktopControlCommand | null {
        this.expire()
        const command = this.commands.find(item => item.id === id && item.ownerId === ownerId)
        return command ? structuredClone(command) : null
    }

    async waitForCompletion(ownerId: string, id: string, timeoutMs = 20_000): Promise<DesktopControlCommand> {
        const deadline = Date.now() + Math.max(100, Math.min(60_000, timeoutMs))
        while (Date.now() < deadline) {
            const command = this.get(ownerId, id)
            if (!command) throw new Error('Desktop command no longer exists')
            if (['acknowledged', 'failed', 'expired'].includes(command.status)) return command
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Desktop client did not complete the command before timeout')
    }

    list(ownerId: string, limit = 50): DesktopControlCommand[] {
        this.expire()
        return this.commands.filter(item => item.ownerId === ownerId).slice(-Math.max(1, Math.min(200, limit))).reverse().map(item => structuredClone(item))
    }

    private expire(): void {
        const now = Date.now()
        let changed = false
        for (const command of this.commands) {
            if (['pending', 'delivered'].includes(command.status) && Date.parse(command.expiresAt) <= now) {
                command.status = 'expired'
                changed = true
            }
        }
        if (changed) this.save()
    }

    private load(): void {
        if (!existsSync(this.file)) return
        try { this.commands = JSON.parse(readFileSync(this.file, 'utf8')) as DesktopControlCommand[] } catch { this.commands = [] }
    }

    private save(): void {
        mkdirSync(dirname(this.file), { recursive: true })
        atomicWriteJsonSync(this.file, this.commands)
    }
}

let singleton: DesktopControlQueue | null = null
export function getDesktopControlQueue(): DesktopControlQueue { return singleton ||= new DesktopControlQueue() }
