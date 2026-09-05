import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'

export type IdempotencyStatus = 'running' | 'completed' | 'failed' | 'compensated'
export interface IdempotencyRecord {
    key: string; runId: string; operation: string; status: IdempotencyStatus
    result?: unknown; error?: string; startedAt: string; updatedAt: string; compensatedAt?: string
    compensationPlan?: CompensationPlan
}

export type CompensationPlan =
    | { kind: 'restore-file'; path: string; existed: boolean; contentBase64?: string }
    | { kind: 'mesh-deployment'; host: string; user: string; port: number; installPath: string; previousRevision?: string; createdNewInstallation: boolean }
    | { kind: 'telegram-delete'; chatId: string; messageId: number }

export type CompensationHandler = (() => Promise<unknown>) & { plan?: CompensationPlan }

export function makeIdempotencyKey(runId: string, operation: string, input: unknown): string {
    const stable = JSON.stringify(input, Object.keys((input && typeof input === 'object' ? input : {}) as object).sort())
    return createHash('sha256').update(`${runId}\0${operation}\0${stable}`).digest('hex')
}

export function executionScopeForContent(content: string, fallbackRunId: string): string {
    const missionKey = content.match(/\[NOVA_MISSION_KEY:([^\]]+)\]/)?.[1]?.trim()
    return missionKey && /^[A-Za-z0-9._:-]{1,200}$/.test(missionKey) ? missionKey : fallbackRunId
}

export interface MissionExecutionFence { missionId: string; epoch: number; token: string }

export function missionFenceForContent(content: string): MissionExecutionFence | undefined {
    const match = content.match(/\[NOVA_MISSION_FENCE:([A-Za-z0-9._-]+):(\d+):([A-Za-z0-9._-]+)\]/)
    if (!match) return undefined
    const epoch = Number(match[2])
    if (!Number.isSafeInteger(epoch) || epoch < 1) return undefined
    return { missionId: match[1], epoch, token: match[3] }
}

export async function assertMissionFenceForContent(content: string): Promise<void> {
    const expected = missionFenceForContent(content)
    if (!expected) return
    const { getServiceFencingToken } = await import('../mesh/leader-election.js')
    const current = getServiceFencingToken(`mission:${expected.missionId}`)
    if (!current || current.epoch !== expected.epoch || current.token !== expected.token) {
        throw new Error(`Mission ${expected.missionId} lost its fencing authority before tool execution`)
    }
}

/** Capture a concrete rollback before a reversible tool executes. Irreversible
 * tools deliberately return undefined and can never advertise fake rollback. */
export function prepareToolCompensation(operation: string, input: Record<string, unknown>): CompensationHandler | undefined {
    const requestedPath = operation === 'config_update'
        ? join(process.cwd(), 'nova.config.json')
        : typeof input.path === 'string' ? input.path : ''
    if (!['write_file', 'delete_file', 'config_update'].includes(operation) || !requestedPath) return undefined
    const path = resolve(requestedPath)
    const existed = existsSync(path)
    if (existed && (!statSync(path).isFile() || statSync(path).size > 10 * 1024 * 1024)) return undefined
    const before = existed ? readFileSync(path) : null
    const plan: CompensationPlan = { kind: 'restore-file', path, existed, contentBase64: before?.toString('base64') }
    const handler = (async () => {
        if (before) writeFileSync(path, before)
        else if (existsSync(path)) unlinkSync(path)
        return { success: true, operation, path, restoredPreviousFile: existed }
    }) as CompensationHandler
    handler.plan = plan
    return handler
}

async function executeCompensationPlan(plan: CompensationPlan, operation: string): Promise<unknown> {
    if (plan.kind === 'restore-file') {
        if (plan.existed) writeFileSync(plan.path, Buffer.from(plan.contentBase64 || '', 'base64'))
        else if (existsSync(plan.path)) unlinkSync(plan.path)
        return { success: true, operation, path: plan.path, restoredPreviousFile: plan.existed, reconstructed: true }
    }
    if (plan.kind === 'mesh-deployment') {
        if (!/^[A-Za-z0-9._:-]+$/.test(plan.host) || !/^[A-Za-z0-9._-]+$/.test(plan.user)
            || !/^\/[A-Za-z0-9._/-]+$/.test(plan.installPath) || !Number.isInteger(plan.port)) {
            throw new Error('Persisted deployment compensation contains unsafe target fields')
        }
        const target = `${plan.user}@${plan.host}`
        let remoteCommand: string
        if (plan.previousRevision && /^[0-9a-f]{7,64}$/i.test(plan.previousRevision)) {
            remoteCommand = `cd ${plan.installPath} && git checkout --detach ${plan.previousRevision} && npm install && npm run build && npx pm2 restart nova`
        } else if (plan.createdNewInstallation) {
            const quarantine = `${plan.installPath}.rolled-back-${Date.now()}`
            remoteCommand = `npx pm2 delete nova || true; test ! -d ${plan.installPath} || mv ${plan.installPath} ${quarantine}`
        } else {
            throw new Error('Deployment has no verified previous revision to restore')
        }
        const output = execFileSync('ssh', ['-p', String(plan.port), target, remoteCommand], { encoding: 'utf8', timeout: 180_000 })
        return { success: true, operation, target, previousRevision: plan.previousRevision, quarantined: plan.createdNewInstallation, output: output.slice(-2000) }
    }
    if (plan.kind === 'telegram-delete') {
        const { getTelegramAdapter } = await import('../channels/telegram.js')
        const adapter = getTelegramAdapter() as any
        if (!adapter?.bot?.deleteMessage) throw new Error('Telegram adapter is not connected; message compensation cannot be verified')
        await adapter.bot.deleteMessage(plan.chatId, plan.messageId)
        return { success: true, operation, chatId: plan.chatId, messageId: plan.messageId, deleted: true }
    }
    throw new Error('Unsupported persisted compensation plan')
}

function handlerForPlan(plan: CompensationPlan, operation: string): CompensationHandler {
    const handler = (() => executeCompensationPlan(plan, operation)) as CompensationHandler
    handler.plan = plan
    return handler
}

/** Build a durable operation-specific rollback from the verified tool receipt.
 * Secrets are never persisted in the plan. Unknown external actions stay
 * explicitly irreversible instead of advertising a fictional rollback. */
export function deriveToolCompensation(operation: string, input: Record<string, unknown>, result: unknown): CompensationHandler | undefined {
    const value = result && typeof result === 'object' ? result as any : null
    if (operation === 'mesh_deploy' && value?.compensationReceipt?.kind === 'mesh-deployment') {
        const receipt = value.compensationReceipt
        const plan: CompensationPlan = {
            kind: 'mesh-deployment',
            host: String(receipt.host || input.host || ''), user: String(receipt.user || input.user || 'root'),
            port: Number(receipt.port || input.port || 22), installPath: String(receipt.installPath || '/opt/nova-core'),
            previousRevision: receipt.previousRevision ? String(receipt.previousRevision) : undefined,
            createdNewInstallation: receipt.createdNewInstallation === true,
        }
        return handlerForPlan(plan, operation)
    }
    if (operation === 'send_telegram_message' && value?.success === true && value?.messageId && value?.sentTo) {
        return handlerForPlan({ kind: 'telegram-delete', chatId: String(value.sentTo), messageId: Number(value.messageId) }, operation)
    }
    return undefined
}

export function describeCompensation(operation: string, input: Record<string, unknown>): { reversible: boolean; reason: string } {
    const handler = prepareToolCompensation(operation, input)
    if (handler) return { reversible: true, reason: 'file snapshot captured before execution' }
    if (/^(?:send_|run_command|system_executor|ssh_|mesh_deploy|deploy|service_)/i.test(operation)) {
        return { reversible: false, reason: 'external side effect requires an operation-specific compensation workflow' }
    }
    return { reversible: false, reason: 'no verified compensation handler is registered' }
}

export class IdempotencyStore {
    private records: Record<string, IdempotencyRecord> = {}
    private compensations = new Map<string, () => Promise<unknown>>()
    constructor(private readonly file = join(process.cwd(), '.nova-data', 'idempotency.json')) { this.load() }
    private load(): void { try { if (existsSync(this.file)) this.records = JSON.parse(readFileSync(this.file, 'utf8')) } catch { this.records = {} } }
    private save(): void { atomicWriteJsonSync(this.file, this.records) }
    get(key: string): IdempotencyRecord | undefined { return this.records[key] }

    async executeOnce<T>(options: {
        key: string; runId: string; operation: string; execute: () => Promise<T>
        compensate?: CompensationHandler
        deriveCompensation?: (result: T) => CompensationHandler | undefined
    }): Promise<{ result: T; replayed: boolean }> {
        const existing = this.records[options.key]
        if (existing?.status === 'completed') return { result: existing.result as T, replayed: true }
        if (existing?.status === 'running') throw new Error(`Operation ${options.operation} is already running (${options.key})`)
        const now = new Date().toISOString()
        this.records[options.key] = { key: options.key, runId: options.runId, operation: options.operation, status: 'running', startedAt: now, updatedAt: now, compensationPlan: options.compensate?.plan }
        if (options.compensate) this.compensations.set(options.key, options.compensate)
        this.save()
        try {
            const result = await options.execute()
            const derived = options.deriveCompensation?.(result)
            if (derived) this.compensations.set(options.key, derived)
            this.records[options.key] = {
                ...this.records[options.key], status: 'completed', result,
                compensationPlan: derived?.plan || this.records[options.key].compensationPlan,
                updatedAt: new Date().toISOString(),
            }
            this.save()
            return { result, replayed: false }
        } catch (error) {
            this.records[options.key] = { ...this.records[options.key], status: 'failed', error: String(error), updatedAt: new Date().toISOString() }
            this.save()
            throw error
        }
    }

    async compensate(key: string): Promise<unknown> {
        const record = this.records[key]
        if (!record) throw new Error('Idempotency record not found')
        if (record.status === 'compensated') return record.result
        const handler = this.compensations.get(key)
        if (!handler && !record.compensationPlan) throw new Error('No verified compensation handler registered for this operation')
        const result = handler ? await handler() : await executeCompensationPlan(record.compensationPlan!, record.operation)
        this.records[key] = { ...record, status: 'compensated', compensatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        this.save()
        return result
    }
}

export interface PendingExecution {
    runId: string; actions: string[]; registeredAt: string
    approve: () => Promise<unknown>; reject: (reason?: string) => Promise<unknown>; resume: () => Promise<unknown>
}
export class PendingExecutionRegistry {
    private readonly pending = new Map<string, PendingExecution>()
    register(execution: PendingExecution): void { this.pending.set(execution.runId, execution) }
    get(runId: string): Omit<PendingExecution, 'approve' | 'reject' | 'resume'> | null {
        const item = this.pending.get(runId); return item ? { runId: item.runId, actions: item.actions, registeredAt: item.registeredAt } : null
    }
    async act(runId: string, action: 'approve' | 'reject' | 'resume', reason?: string): Promise<unknown> {
        const item = this.pending.get(runId)
        if (!item) throw new Error('Run is not live in this process; use its persisted checkpoint after reconstruction')
        const result = action === 'reject' ? await item.reject(reason) : await item[action]()
        if (action !== 'resume') this.pending.delete(runId)
        return result
    }
}

let idempotencySingleton: IdempotencyStore | null = null
let pendingSingleton: PendingExecutionRegistry | null = null
export function getIdempotencyStore(): IdempotencyStore { idempotencySingleton ||= new IdempotencyStore(); return idempotencySingleton }
export function getPendingExecutionRegistry(): PendingExecutionRegistry { pendingSingleton ||= new PendingExecutionRegistry(); return pendingSingleton }
