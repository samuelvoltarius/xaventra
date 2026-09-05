import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getLifecyclePolicy } from '../core/lifecycle-policy.js'

const execFileAsync = promisify(execFile)

export type MissionWorkspaceMode = 'temporary' | 'worktree' | 'container' | 'native'
export type MissionWorkspaceStatus = 'ready' | 'running' | 'awaiting-review' | 'promoted' | 'failed' | 'retired'

export interface MissionWorkspaceRequest {
    missionId?: string
    repository?: string
    mode?: MissionWorkspaceMode
    baseRef?: string
    containerImage?: string
    network?: boolean
    cpuLimit?: number
    memoryMb?: number
    sandboxBackend?: 'bubblewrap' | 'landlock' | 'seatbelt'
}

export interface MissionWorkspaceRecord {
    id: string
    missionId: string
    mode: MissionWorkspaceMode
    root: string
    repository?: string
    baseRef?: string
    branch?: string
    containerImage?: string
    sandboxBackend?: string
    status: MissionWorkspaceStatus
    createdAt: string
    updatedAt: string
    lastError?: string
}

export interface WorkspaceCommandResult {
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
}

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || randomUUID().slice(0, 8)
}

function within(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child))
    return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function validateArgs(args: string[]): void {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid command arguments')
}

export class MissionWorkspaceManager {
    private readonly records = new Map<string, MissionWorkspaceRecord>()
    private readonly indexFile: string

    constructor(private readonly root = join(process.cwd(), '.nova-data', 'mission-workspaces')) {
        this.indexFile = join(root, 'index.json')
        this.load()
    }

    async create(request: MissionWorkspaceRequest = {}): Promise<MissionWorkspaceRecord> {
        const missionId = request.missionId || randomUUID()
        const id = `${slug(missionId)}-${randomUUID().slice(0, 8)}`
        const mode = request.mode || (request.repository ? 'worktree' : 'temporary')
        const workspaceRoot = resolve(this.root, id)
        if (!within(this.root, workspaceRoot)) throw new Error('Workspace escaped managed root')
        mkdirSync(this.root, { recursive: true })

        const record: MissionWorkspaceRecord = {
            id,
            missionId,
            mode,
            root: workspaceRoot,
            repository: request.repository ? resolve(request.repository) : undefined,
            baseRef: request.baseRef || 'HEAD',
            containerImage: request.containerImage,
            sandboxBackend: request.sandboxBackend,
            status: 'ready',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
        try {
            if (mode === 'worktree') await this.createWorktree(record)
            else mkdirSync(workspaceRoot, { recursive: true })
            if (mode === 'container') this.assertContainerImage(request.containerImage)
            this.records.set(id, record)
            this.save()
            return { ...record }
        } catch (error) {
            if (existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true, force: true })
            throw error
        }
    }

    private async createWorktree(record: MissionWorkspaceRecord): Promise<void> {
        if (!record.repository) throw new Error('Worktree mode requires a repository')
        const probe = await execFileAsync('git', ['-C', record.repository, 'rev-parse', '--show-toplevel'], { windowsHide: true })
        const canonical = resolve(probe.stdout.trim())
        if (canonical !== record.repository) record.repository = canonical
        record.branch = `nova/mission/${slug(record.missionId)}-${record.id.slice(-8)}`
        await execFileAsync('git', ['-C', record.repository, 'worktree', 'add', '-b', record.branch, record.root, record.baseRef || 'HEAD'], {
            windowsHide: true,
            timeout: 60_000,
        })
    }

    async run(id: string, command: string, args: string[] = [], options: { timeoutMs?: number; env?: Record<string, string>; network?: boolean; cpuLimit?: number; memoryMb?: number } = {}): Promise<WorkspaceCommandResult> {
        validateArgs(args)
        const record = this.require(id)
        record.status = 'running'
        this.touch(record)
        const startedAt = Date.now()
        try {
            const result = record.mode === 'container'
                ? await this.runContainer(record, command, args, options)
                : record.mode === 'native'
                    ? await this.runNative(record, command, args, options)
                    : await execFileAsync(command, args, {
                    cwd: record.root,
                    timeout: Math.max(100, options.timeoutMs || 120_000),
                    windowsHide: true,
                    env: { ...process.env, ...(options.env || {}), NOVA_MISSION_WORKSPACE: record.id },
                    maxBuffer: 10 * 1024 * 1024,
                })
            record.status = 'awaiting-review'
            this.touch(record)
            return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '', durationMs: Date.now() - startedAt }
        } catch (error: any) {
            record.status = 'failed'
            record.lastError = String(error?.message || error).slice(0, 500)
            this.touch(record)
            return { exitCode: Number(error?.code) || 1, stdout: String(error?.stdout || ''), stderr: String(error?.stderr || record.lastError), durationMs: Date.now() - startedAt }
        }
    }

    private async runNative(record: MissionWorkspaceRecord, command: string, args: string[], options: { timeoutMs?: number; env?: Record<string, string>; network?: boolean }) {
        const { getSandboxRegistry } = await import('./sandbox-provider.js')
        const confined = getSandboxRegistry().confine(command, args, { workspaceRoot: record.root, network: options.network === true }, record.sandboxBackend)
        record.sandboxBackend = confined.backend
        return execFileAsync(confined.command, confined.args, {
            cwd: record.root,
            timeout: Math.max(100, options.timeoutMs || 120_000),
            windowsHide: true,
            env: { ...process.env, ...(options.env || {}), NOVA_MISSION_WORKSPACE: record.id, NOVA_SANDBOX_BACKEND: confined.backend },
            maxBuffer: 10 * 1024 * 1024,
        })
    }

    private async runContainer(record: MissionWorkspaceRecord, command: string, args: string[], options: { timeoutMs?: number; env?: Record<string, string>; network?: boolean; cpuLimit?: number; memoryMb?: number }) {
        this.assertContainerImage(record.containerImage)
        const dockerArgs = [
            'run', '--rm', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--pids-limit=256', '--cpus', String(Math.max(0.1, options.cpuLimit || 2)),
            '--memory', `${Math.max(128, options.memoryMb || 2048)}m`,
            '--network', options.network ? 'bridge' : 'none',
            '--mount', `type=bind,source=${record.root},target=/workspace`, '--workdir', '/workspace',
        ]
        for (const [key, value] of Object.entries(options.env || {})) {
            if (!/^NOVA_[A-Z0-9_]+$/.test(key)) continue
            dockerArgs.push('--env', `${key}=${value}`)
        }
        dockerArgs.push(record.containerImage!, command, ...args)
        return execFileAsync('docker', dockerArgs, { timeout: Math.max(1_000, options.timeoutMs || 120_000), windowsHide: true, maxBuffer: 10 * 1024 * 1024 })
    }

    private assertContainerImage(image?: string): void {
        if (!image) throw new Error('Container mode requires an image')
        const allow = (process.env.NOVA_WORKSPACE_IMAGES || 'node:22-bookworm-slim,python:3.12-slim').split(',').map(item => item.trim())
        if (!allow.includes(image)) throw new Error(`Container image is not allowlisted: ${image}`)
    }

    async diff(id: string): Promise<string> {
        const record = this.require(id)
        if (record.mode !== 'worktree') return ''
        const { stdout } = await execFileAsync('git', ['-C', record.root, 'diff', '--binary', '--no-ext-diff', record.baseRef || 'HEAD'], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
        return stdout
    }

    async promote(id: string, targetRepository: string, approved: boolean): Promise<{ applied: boolean; patchBytes: number }> {
        if (!approved) throw new Error('Workspace promotion requires explicit operator approval')
        const record = this.require(id)
        if (record.mode !== 'worktree') throw new Error('Only worktree changes can be promoted')
        const target = resolve(targetRepository)
        if (record.repository && target !== record.repository) throw new Error('Promotion target differs from workspace repository')
        const patch = await this.diff(id)
        if (!patch) return { applied: false, patchBytes: 0 }
        const patchFile = join(this.root, `${record.id}.patch`)
        writeFileSync(patchFile, patch, 'utf8')
        await execFileAsync('git', ['-C', target, 'apply', '--check', patchFile], { windowsHide: true })
        await execFileAsync('git', ['-C', target, 'apply', patchFile], { windowsHide: true })
        record.status = 'promoted'
        this.touch(record)
        return { applied: true, patchBytes: Buffer.byteLength(patch) }
    }

    async retire(id: string): Promise<void> {
        const record = this.require(id)
        if (record.mode === 'worktree' && record.repository) {
            if (!within(this.root, record.root)) throw new Error('Refusing to remove unmanaged worktree')
            await execFileAsync('git', ['-C', record.repository, 'worktree', 'remove', '--force', record.root], { windowsHide: true, timeout: 60_000 })
        } else if (within(this.root, record.root)) {
            rmSync(record.root, { recursive: true, force: true })
        }
        record.status = 'retired'
        this.touch(record)
    }

    get(id: string): MissionWorkspaceRecord | undefined { const record = this.records.get(id); return record ? { ...record } : undefined }
    list(): MissionWorkspaceRecord[] { return [...this.records.values()].map(record => ({ ...record })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }

    private require(id: string): MissionWorkspaceRecord {
        const record = this.records.get(id)
        if (!record) throw new Error(`Mission workspace not found: ${id}`)
        return record
    }

    private touch(record: MissionWorkspaceRecord): void { record.updatedAt = new Date().toISOString(); this.save() }
    private load(): void {
        if (!existsSync(this.indexFile)) return
        try {
            const records = JSON.parse(readFileSync(this.indexFile, 'utf8')) as MissionWorkspaceRecord[]
            for (const record of records) if (within(this.root, record.root)) this.records.set(record.id, record)
        } catch { /* corrupt indexes do not authorize filesystem actions */ }
    }
    private save(): void {
        if (!existsSync(dirname(this.indexFile))) mkdirSync(dirname(this.indexFile), { recursive: true })
        writeFileSync(this.indexFile, JSON.stringify(this.list(), null, 2))
    }
}

let policyInstalled = false
export function initializeMissionWorkspacePolicy(): void {
    if (policyInstalled) return
    getLifecyclePolicy().register({
        id: 'mission-workspace-boundary', event: 'tool.before', priority: 10, failClosed: true,
        handler: payload => {
            const workspaceId = payload.context.workspaceId
            if (!workspaceId || !payload.toolName) return
            const record = getMissionWorkspaceManager().get(workspaceId)
            if (!record) return { decision: 'deny', reason: 'Mission workspace no longer exists' }
            if (payload.toolName === 'mission_workspace_run') return { updatedInput: { ...(payload.input || {}), workspace_id: workspaceId } }
            if (['run_command', 'system_executor', 'ssh_command'].includes(payload.toolName)) {
                return { decision: 'deny', reason: 'Free shell/SSH is disabled inside isolated missions; use mission_workspace_run with typed command arguments' }
            }
            if (['write_file', 'delete_file', 'read_file'].includes(payload.toolName)) {
                const input = { ...(payload.input || {}) }
                const key = ['path', 'file_path', 'filename'].find(candidate => typeof input[candidate] === 'string')
                if (!key) return { decision: 'deny', reason: 'Workspace file tool requires a path' }
                const requested = String(input[key])
                const target = resolve(record.root, requested)
                if (!within(record.root, target)) return { decision: 'deny', reason: 'File path escaped the mission workspace' }
                input[key] = target
                return { updatedInput: input }
            }
        },
    })
    policyInstalled = true
}

let manager: MissionWorkspaceManager | null = null
export function getMissionWorkspaceManager(): MissionWorkspaceManager { return manager ||= new MissionWorkspaceManager() }
