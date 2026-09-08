import { request } from 'node:http'
import { repairHash, type PreparedRepair, type RepairBinding, type RepairDeploymentDriver, type RepairTicket } from './repair-activation.js'

export interface DockerRepairRelease {
    id: string; previousReleaseId: string; sourceHash: string; imageId: string; binding: RepairBinding
}
export interface DockerRepairEngine { call(method: string, path: string, body?: unknown): Promise<any> }
/** Local Engine only. No shell, context selection, remote Docker URL or image pulls. */
export function localDockerRepairEngine(socketPath = '/var/run/docker.sock'): DockerRepairEngine {
    if (!socketPath.startsWith('/') || socketPath.includes('\0')) throw new Error('Absolute operator Docker socket required')
    return { call: (method, path, body) => new Promise((resolve, reject) => {
        const req = request({ socketPath, path: `/v1.45${path}`, method, headers: { 'content-type': 'application/json' } }, res => {
            const chunks: Buffer[] = []; let size = 0
            res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Docker response exceeds budget')); else chunks.push(chunk) })
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Docker ${method} failed (${res.statusCode})`))
                const raw = Buffer.concat(chunks).toString('utf8')
                try { resolve(raw ? JSON.parse(raw) : undefined) } catch { reject(new Error('Invalid Docker response')) }
            })
            res.on('error', reject)
        })
        const timer = setTimeout(() => req.destroy(new Error('Docker operation timed out; reconcile identity before retry')), 35_000)
        req.on('error', reject); req.on('close', () => clearTimeout(timer))
        req.end(body === undefined ? undefined : JSON.stringify(body))
    }) }
}

export interface DockerRepairOptions {
    targetId: string; initialReleaseId: string
    /** Operator-prepared containers, not model-supplied names. Exact IDs only. */
    releases: Record<string, { release: DockerRepairRelease; containerId: string; configHash: string }>
    catalog: Record<string, string>
    hasAuthority(ticket: RepairTicket): Promise<boolean>
    /** Independent deployment-specific state quiescence/snapshot attestation.
     * Must fail without current proof for ANY writable persistent mount. */
    stateReady?(oldContainerId: string, candidateContainerId: string, ticket: RepairTicket): Promise<boolean>
    loadState(): { releaseId: string; phase?: string } | undefined
    saveState(state: { releaseId: string; phase: string; attemptId: string }): void
}
const idPattern = /^[a-f0-9]{64}$/
const imagePattern = /^sha256:[a-f0-9]{64}$/
/** Hash only immutable inspect fields. State/health/IP change legitimately. */
export function dockerRepairConfigHash(info: any): string {
    // Engine 29 changes unsupported cgroup-v2 OomKillDisable false to null on
    // first start. Both mean "not disabled"; true remains distinct and denied.
    return repairHash({ Id: info.Id, Image: info.Image, Config: info.Config,
        HostConfig: { ...info.HostConfig, OomKillDisable: info.HostConfig?.OomKillDisable === true },
        Mounts: info.Mounts, networks: Object.keys(info.NetworkSettings?.Networks || {}).sort() })
}
/** Activation adapter for operator-prepared immutable containers. Retains the
 * old stopped container and its data, never rebuilds/pulls/removes infrastructure.
 * Stateful deployments require an independent stateReady adapter; no boolean
 * configuration flag may pretend shared-memory/volume rollback is proven. */
export class DockerRepairDriver implements RepairDeploymentDriver {
    private current: string
    private readonly options: DockerRepairOptions
    constructor(options: DockerRepairOptions, private readonly engine: DockerRepairEngine) {
        this.options = { ...options, releases: structuredClone(options.releases), catalog: structuredClone(options.catalog) }
        this.current = options.loadState()?.releaseId || options.initialReleaseId
        if (!this.options.releases[this.current]) throw new Error('Unknown persisted Docker release; reconcile before activation')
        const ids = Object.values(this.options.releases).map(r => r.containerId)
        if (ids.some(id => !idPattern.test(id)) || new Set(ids).size !== ids.length) throw new Error('Unique full Docker container IDs required')
    }
    hasAuthority(ticket: RepairTicket): Promise<boolean> { return this.options.hasAuthority(ticket) }
    private async inspect(releaseId: string): Promise<any> {
        const registered = this.options.releases[releaseId]
        if (!registered || registered.release.id !== releaseId || !imagePattern.test(registered.release.imageId)) throw new Error('Invalid signed Docker release')
        const info = await this.engine.call('GET', `/containers/${registered.containerId}/json`)
        const host = info.HostConfig
        if (info.Id !== registered.containerId || info.Image !== registered.release.imageId || dockerRepairConfigHash(info) !== registered.configHash) throw new Error('Docker identity or immutable configuration changed')
        if (!host || host.Privileged || host.OomKillDisable === true || host.ReadonlyRootfs !== true || host.AutoRemove || host.RestartPolicy?.Name !== 'no'
            || !/^[1-9][0-9]*(?::[1-9][0-9]*)?$/.test(info.Config?.User || '')
            || !host.CapDrop?.includes('ALL') || host.CapAdd?.length || !host.SecurityOpt?.some((s: string) => /^no-new-privileges(?::true)?$/.test(s))
            || host.SecurityOpt.some((s: string) => !/^no-new-privileges(?::true)?$/.test(s))
            || host.Devices?.length || host.DeviceRequests?.length || host.VolumesFrom?.length
            || host.NetworkMode === 'host' || host.NetworkMode?.startsWith('container:')
            || host.PidMode || host.IpcMode === 'host' || host.UsernsMode === 'host'
            || !Number.isFinite(host.Memory) || host.Memory <= 0 || !Number.isFinite(host.PidsLimit) || host.PidsLimit <= 0
            || !((host.NanoCpus > 0) || (host.CpuQuota > 0 && host.CpuPeriod > 0))
            || !host.LogConfig?.Config?.['max-size']) throw new Error('Docker runtime confinement or exclusive restart ownership missing')
        if ((info.Mounts || []).some((m: any) => /docker\.sock|containerd\.sock/.test(m.Source || '')
            || !['volume', 'bind', 'tmpfs'].includes(m.Type) || (m.Type === 'bind' && (m.RW || m.Source === '/')))) throw new Error('Unapproved Docker mount kind or socket')
        return info
    }
    async prepare(ticket: RepairTicket): Promise<PreparedRepair> {
        if (ticket.targetId !== this.options.targetId || !await this.hasAuthority(ticket)) throw new Error('Docker target or authority mismatch')
        const releaseId = this.options.catalog[ticket.candidateHash]
        const candidate = this.options.releases[releaseId]?.release
        const previous = candidate && this.options.releases[candidate.previousReleaseId]?.release
        const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
        if (!candidate || !previous || candidate.sourceHash !== ticket.candidateHash || previous.sourceHash !== ticket.baselineHash
            || repairHash(candidate.binding) !== repairHash(binding) || previous.id !== this.current) throw new Error('Docker source continuity or approval binding mismatch')
        const old = await this.inspect(previous.id), next = await this.inspect(candidate.id)
        if (!old.State?.Running || old.State?.Paused || next.State?.Running || next.State?.Paused || next.State?.Restarting) throw new Error('Prepared Docker state is not exclusive')
        // A rollback cannot undo writes to the original volume. Never share it.
        const writable = (info: any) => (info.Mounts || []).filter((m: any) => m.RW && m.Type !== 'tmpfs')
        const before = writable(old), after = writable(next)
        if ([...before, ...after].length && !this.options.stateReady) throw new Error('Stateful Docker activation requires independent quiescence and snapshot proof')
        if (before.some((a: any) => after.some((b: any) => a.Source === b.Source || (a.Name && a.Name === b.Name)))) throw new Error('Candidate and rollback cannot share writable storage')
        return { releaseId: candidate.id, previousReleaseId: previous.id, binding: candidate.binding }
    }
    async currentRelease(targetId: string): Promise<string> {
        if (targetId !== this.options.targetId) throw new Error('Wrong Docker target')
        const info = await this.inspect(this.current)
        if (!info.State?.Running || info.State?.Paused || info.State?.Restarting || info.State?.Dead) throw new Error('Expected Docker runtime is not running')
        return this.current
    }
    private async switchRelease(expected: string, next: string, ticket: RepairTicket, rollback: boolean): Promise<void> {
        if (this.current !== expected || !await this.hasAuthority(ticket)) throw new Error('Docker release fenced compare-and-swap failed')
        const old = await this.inspect(expected), candidate = await this.inspect(next)
        if (candidate.State?.Running || candidate.State?.Paused) throw new Error('Candidate already running outside controller')
        // Before any side effect, durably name the potential candidate. A failed
        // stop/start must remain recoverable without guessing from container names.
        this.options.saveState({ releaseId: next, phase: 'switching', attemptId: ticket.attemptId })
        this.current = next
        if (old.State?.Running) await this.engine.call('POST', `/containers/${old.Id}/stop?t=20`)
        const stopped = await this.inspect(expected)
        if (stopped.State?.Running || stopped.State?.Paused || stopped.State?.Restarting) throw new Error('Old Docker runtime exit unconfirmed')
        if (!await this.hasAuthority(ticket)) throw new Error('Docker authority lost after stop')
        if (!rollback && [...(old.Mounts || []), ...(candidate.Mounts || [])].some((m: any) => m.RW && m.Type !== 'tmpfs')) {
            if (!await this.options.stateReady?.(old.Id, candidate.Id, ticket)) throw new Error('State snapshot or distributed quiescence not proven')
        }
        // Re-read the full immutable configuration immediately before start.
        await this.inspect(next)
        if (!await this.hasAuthority(ticket)) throw new Error('Docker authority lost before candidate start')
        await this.engine.call('POST', `/containers/${candidate.Id}/start`)
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
            const observed = await this.inspect(next)
            if (!observed.State?.Running || observed.State?.Dead) throw new Error('Docker candidate exited during startup')
            if (observed.State.Health?.Status === 'healthy') {
                this.options.saveState({ releaseId: next, phase: 'running', attemptId: ticket.attemptId }); return
            }
            if (observed.State.Health?.Status === 'unhealthy' || !observed.Config?.Healthcheck) throw new Error('Docker readiness check failed or missing')
            await new Promise(resolve => setTimeout(resolve, 200))
        }
        throw new Error('Docker startup readiness timed out')
    }
    async activate(prepared: PreparedRepair, ticket: RepairTicket): Promise<void> {
        const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
        if (repairHash(binding) !== repairHash(prepared.binding)) throw new Error('Docker activation binding mismatch')
        await this.switchRelease(prepared.previousReleaseId, prepared.releaseId, ticket, false)
    }
    async rollback(prepared: PreparedRepair, ticket: RepairTicket): Promise<void> {
        // If an unsuccessful stop left the original running, do not start it twice.
        const previous = await this.inspect(prepared.previousReleaseId), next = await this.inspect(prepared.releaseId)
        if (this.current !== prepared.releaseId || !await this.hasAuthority(ticket)) throw new Error('Docker rollback authority or CAS lost')
        if (previous.State?.Running && !next.State?.Running) {
            this.current = prepared.previousReleaseId
            this.options.saveState({ releaseId: this.current, phase: 'running', attemptId: ticket.attemptId }); return
        }
        await this.switchRelease(prepared.releaseId, prepared.previousReleaseId, ticket, true)
    }
}
