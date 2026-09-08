import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { stopLocalDaemon } from '../process/daemon-control.js'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { repairHash, verifyRepairValue, type PreparedRepair, type RepairBinding, type RepairDeploymentDriver, type RepairTicket, type SignedRepairValue } from './repair-activation.js'

export interface ManagedRepairRelease {
    id: string; binding: RepairBinding; previousReleaseId: string
    /** Canonical source snapshot hash attested by the independent release builder. */
    sourceHash: string
    files: Array<{ path: string; sha256: string }>
}
export interface ManagedRepairOptions {
    targetId: string; releasesRoot: string; runtimeRoot: string; stateFile: string
    releasePublicKey: string; initialReleaseId: string
    runtimeUid: number; runtimeGid: number; runtimeEnv: Record<string, string>
    nodeExecutable?: string
    hasAuthority(ticket: RepairTicket): Promise<boolean>
}

/** Optional single-host Linux process adapter. The operator runs the controller
 * as root, and the application as a different, unprivileged UID. Release trees
 * are signed/prebuilt and root-owned. No source compilation, shell, Git, arbitrary
 * command or secret copying. Containers / service managers need their own fenced
 * adapter; do not run this alongside a supervisor that auto-restarts the daemon. */
export class ManagedRepairDriver implements RepairDeploymentDriver {
    private current: string
    private child?: ChildProcess
    constructor(private readonly options: ManagedRepairOptions) {
        if (process.platform !== 'linux' || process.getuid?.() !== 0
            || !Number.isInteger(options.runtimeUid) || options.runtimeUid <= 0
            || !Number.isInteger(options.runtimeGid) || options.runtimeGid <= 0) throw new Error('Managed repair requires Linux root controller and separate non-root runtime identity')
        this.current = existsSync(options.stateFile) ? JSON.parse(readFileSync(options.stateFile, 'utf8')).releaseId : options.initialReleaseId
        this.protect(dirname(options.stateFile))
        this.protect(options.releasesRoot)
        this.protect(options.nodeExecutable || process.execPath)
        if (Object.keys(options.runtimeEnv).some(k => /RECEIPT_PRIVATE_KEY|RELEASE_PRIVATE_KEY|AUTHORITY_PRIVATE_KEY|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH/.test(k))) throw new Error('Controller signing credentials/loaders cannot enter candidate environment')
    }
    hasAuthority(ticket: RepairTicket): Promise<boolean> { return this.options.hasAuthority(ticket) }
    private protect(path: string): void {
        const absolute = resolve(path)
        if (realpathSync(absolute) !== absolute) throw new Error('Linked controller/release path')
        let cursor = absolute
        while (true) {
            const stat = lstatSync(cursor)
            if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new Error('Controller/release paths must be root-owned and not writable by runtime')
            const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
        }
    }
    private release(id: string): ManagedRepairRelease {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error('Invalid immutable release ID')
        const root = join(this.options.releasesRoot, id); this.protect(root)
        const envelope: SignedRepairValue<ManagedRepairRelease> = JSON.parse(readFileSync(join(root, 'repair-release.json'), 'utf8'))
        const manifest = verifyRepairValue(envelope, this.options.releasePublicKey)
        if (manifest.id !== id || !Array.isArray(manifest.files) || manifest.files.length > 100_000) throw new Error('Invalid signed release manifest')
        const paths = new Set<string>()
        for (const file of manifest.files) {
            if (!/^[a-zA-Z0-9_@./+\[\]-]+$/.test(file.path) || file.path.startsWith('/')
                || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path)) throw new Error('Invalid signed file path')
            paths.add(file.path)
            const full = join(root, file.path); this.protect(full)
            const stat = lstatSync(full)
            if (!stat.isFile() || stat.nlink !== 1 || createHash('sha256').update(readFileSync(full)).digest('hex') !== file.sha256) throw new Error('Immutable release file mismatch')
        }
        // No unmanifested executable/dependency can be resolved at runtime.
        const visit = (path: string, prefix = '') => {
            for (const entry of readdirSync(path, { withFileTypes: true })) {
                const rel = prefix + entry.name, full = join(path, entry.name); this.protect(full)
                if (entry.isDirectory()) visit(full, `${rel}/`)
                else if (!entry.isFile() || (rel !== 'repair-release.json' && !paths.has(rel))) throw new Error('Unmanifested or linked release input')
            }
        }
        visit(root)
        if (!paths.has('dist/daemon.js')) throw new Error('Release daemon entrypoint missing')
        return manifest
    }
    async prepare(ticket: RepairTicket): Promise<PreparedRepair> {
        if (!await this.hasAuthority(ticket) || ticket.targetId !== this.options.targetId) throw new Error('Invalid target or leadership')
        // IDs are operator catalog names, not model-generated filesystem paths.
        this.protect(join(this.options.releasesRoot, 'catalog.json'))
        const catalog: Record<string, string> = JSON.parse(readFileSync(join(this.options.releasesRoot, 'catalog.json'), 'utf8'))
        const release = this.release(catalog[ticket.candidateHash])
        const previous = this.release(release.previousReleaseId)
        if (previous.sourceHash !== ticket.baselineHash || release.sourceHash !== ticket.candidateHash) {
            throw new Error('Approved baseline does not match active release source; refresh the repair source mirror')
        }
        return { releaseId: release.id, previousReleaseId: release.previousReleaseId, binding: release.binding }
    }
    async currentRelease(targetId: string): Promise<string> {
        if (targetId !== this.options.targetId) throw new Error('Wrong target')
        return this.current
    }
    private async stop(): Promise<void> {
        const child = this.child
        if (child && child.exitCode === null && child.signalCode === null) {
            // This exact ChildProcess was started by this controller; never kill
            // a name, port owner or reconstructed PID from another process.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { child.off('exit', done); reject(new Error('Owned runtime exit unconfirmed')) }, 20_000)
                const done = () => { clearTimeout(timer); resolve() }
                child.once('exit', done)
                child.kill('SIGTERM')
            })
        } else if (!child) await stopLocalDaemon(this.options.runtimeRoot)
        this.child = undefined
    }
    private async switchRelease(expected: string, next: string, ticket: RepairTicket): Promise<void> {
        if (!await this.hasAuthority(ticket) || this.current !== expected) throw new Error('Fenced release compare-and-swap failed')
        const release = this.release(next)
        if (!release.binding || release.binding.targetId !== ticket.targetId) throw new Error('Release target mismatch')
        await this.stop()
        if (!await this.hasAuthority(ticket) || this.current !== expected) throw new Error('Authority changed during shutdown')
        // Record possible transition before spawn, so even a spawn error after
        // old-runtime shutdown has a well-defined CAS rollback target.
        this.current = next
        atomicWriteJsonSync(this.options.stateFile, { releaseId: next, phase: 'starting', attemptId: ticket.attemptId })
        const child = spawn(this.options.nodeExecutable || process.execPath, [join(this.options.releasesRoot, next, 'dist', 'daemon.js')], {
            cwd: this.options.runtimeRoot, uid: this.options.runtimeUid, gid: this.options.runtimeGid,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: this.options.runtimeRoot, ...this.options.runtimeEnv },
            stdio: ['ignore', 'ignore', 'ignore'], shell: false,
        })
        this.child = child
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', error => { this.child = undefined; reject(error) }) })
        this.current = next
        atomicWriteJsonSync(this.options.stateFile, { releaseId: next, pid: child.pid, attemptId: ticket.attemptId })
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Candidate exited during startup')
            try {
                const marker = JSON.parse(readFileSync(join(this.options.runtimeRoot, '.nova-data', 'daemon-control.json'), 'utf8'))
                if (marker.pid === child.pid && marker.root === realpathSync(this.options.runtimeRoot)) return
            } catch { /* no readiness acknowledgement yet */ }
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Candidate startup not confirmed')
        // The separate controller/witness verifies actual original behaviour,
        // not merely this spawn acknowledgement or application-controlled marker.
    }
    async activate(prepared: PreparedRepair, ticket: RepairTicket): Promise<void> {
        const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
        if (repairHash(binding) !== repairHash(prepared.binding)) throw new Error('Activation binding mismatch')
        await this.switchRelease(prepared.previousReleaseId, prepared.releaseId, ticket)
    }
    async rollback(prepared: PreparedRepair, ticket: RepairTicket): Promise<void> {
        // Even a failed spawn after stopping the old process needs restoration.
        await this.switchRelease(prepared.releaseId, prepared.previousReleaseId, ticket)
    }
}
