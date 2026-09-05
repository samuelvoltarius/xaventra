import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { discoverNodes } from '../mesh/mesh-registry.js'
import { getCapabilityGraph } from '../mesh/capability-graph.js'
import { resolveNodeLifecycle } from '../mesh/mesh-node-lifecycle.js'

export type EnrollmentRole = 'worker' | 'standby'
export type EnrollmentRuntime = 'docker' | 'systemd'

export interface NodeEnrollment {
    id: string
    ownerId: string
    nodeId: string
    displayName: string
    host: string
    sshPort: number
    sshUser: string
    role: EnrollmentRole
    runtime: EnrollmentRuntime
    expectedHostKeyFingerprint: string
    status: 'draft' | 'approved' | 'awaiting-node' | 'verified' | 'failed' | 'cancelled'
    mainEligible: boolean
    channelMode: 'disabled' | 'standby'
    createdAt: string
    updatedAt: string
    steps: Array<{ id: string; label: string; gate: 'automatic' | 'owner' | 'verification'; completed: boolean }>
    lastError?: string
}

function safeId(value: unknown): string {
    const result = String(value || '').trim().toLowerCase()
    if (!/^nova-[a-z0-9][a-z0-9-]{1,47}$/.test(result)) throw new Error('nodeId must start with nova- and contain only letters, digits and hyphens')
    return result
}

function safeHost(value: unknown): string {
    const host = String(value || '').trim()
    if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/.test(host)) throw new Error('Invalid host name or address')
    if (['0.0.0.0', '169.254.169.254'].includes(host)) throw new Error('Forbidden host')
    return host
}

function safeFingerprint(value: unknown): string {
    const fingerprint = String(value || '').trim()
    if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(fingerprint)) throw new Error('A verified SHA256 SSH host-key fingerprint is required')
    return fingerprint
}

export class NodeEnrollmentService {
    private entries = new Map<string, NodeEnrollment>()
    constructor(private readonly file = join(process.cwd(), '.nova-data', 'desktop', 'node-enrollments.json')) { this.load() }

    async inventory(includeHistorical = false): Promise<{ nodes: any[]; enrollments: NodeEnrollment[]; observedAt: string }> {
        const [registry, graph] = await Promise.all([discoverNodes({ includeHistorical }), Promise.resolve(getCapabilityGraph().getSnapshot())])
        const graphById = new Map(graph.nodes.map(node => [node.id, node]))
        const nodes = registry.map(node => {
            const capability = graphById.get(node.node_id)
            return {
                id: node.node_id, name: node.hostname, host: node.ip, version: node.version,
                lifecycle: resolveNodeLifecycle({ lastHeartbeat: node.last_heartbeat, lifecycleState: node.lifecycle_state }),
                status: node.status, lastHeartbeat: node.last_heartbeat, hardware: node.hardware,
                capabilities: node.capabilities, runtimes: capability?.runtimes || [],
                tools: node.tools_count, mainEligible: !['nova-workstation', 'nova-worker-a', 'nova-worker-b', 'nova-pi5'].includes(node.node_id),
            }
        })
        return { nodes, enrollments: [...this.entries.values()].map(item => structuredClone(item)), observedAt: new Date().toISOString() }
    }

    create(ownerId: string, input: { nodeId: string; displayName: string; host: string; sshPort?: number; sshUser: string; role?: EnrollmentRole; runtime?: EnrollmentRuntime; expectedHostKeyFingerprint: string }): NodeEnrollment {
        const now = new Date().toISOString()
        const role: EnrollmentRole = input.role === 'standby' ? 'standby' : 'worker'
        const entry: NodeEnrollment = {
            id: `enroll-${randomUUID()}`, ownerId, nodeId: safeId(input.nodeId), displayName: String(input.displayName || '').trim().slice(0, 80),
            host: safeHost(input.host), sshPort: Math.max(1, Math.min(65_535, Number(input.sshPort || 22))),
            sshUser: String(input.sshUser || '').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64), role,
            runtime: input.runtime === 'systemd' ? 'systemd' : 'docker', expectedHostKeyFingerprint: safeFingerprint(input.expectedHostKeyFingerprint),
            status: 'draft', mainEligible: role === 'standby', channelMode: role === 'standby' ? 'standby' : 'disabled', createdAt: now, updatedAt: now,
            steps: [
                { id: 'host-key', label: 'SSH host key fingerprint verifizieren', gate: 'verification', completed: true },
                { id: 'inventory', label: 'Hardware, OS und AI-Runtimes read-only inventarisieren', gate: 'automatic', completed: false },
                { id: 'identity', label: 'Node-eigenes Ed25519-Mesh-Schluesselpaar lokal erzeugen', gate: 'verification', completed: false },
                { id: 'install', label: `Signiertes Nova-Artefakt als ${entryRuntimeLabel(input.runtime)} installieren`, gate: 'owner', completed: false },
                { id: 'fence', label: role === 'standby' ? 'Standby-Lease und Channel-Fencing pruefen' : 'Main- und Channel-Eignung explizit sperren', gate: 'verification', completed: false },
                { id: 'heartbeat', label: 'Signatur, Runtime-Marker, Heartbeat und Capability Graph pruefen', gate: 'verification', completed: false },
            ],
        }
        if (!entry.displayName || !entry.sshUser) throw new Error('displayName and sshUser are required')
        if ([...this.entries.values()].some(item => item.nodeId === entry.nodeId && item.status !== 'cancelled')) throw new Error('An active enrollment already exists for this nodeId')
        this.entries.set(entry.id, entry); this.save(); return structuredClone(entry)
    }

    approve(id: string, ownerId: string): NodeEnrollment {
        const entry = this.require(id, ownerId)
        if (entry.status !== 'draft') throw new Error('Only draft enrollments can be approved')
        entry.status = 'approved'; entry.updatedAt = new Date().toISOString(); this.save(); return structuredClone(entry)
    }

    markAwaitingNode(id: string, ownerId: string): NodeEnrollment {
        const entry = this.require(id, ownerId)
        if (entry.status !== 'approved') throw new Error('Owner approval is required before installation')
        entry.status = 'awaiting-node'; entry.updatedAt = new Date().toISOString(); this.save(); return structuredClone(entry)
    }

    cancel(id: string, ownerId: string): NodeEnrollment { const entry = this.require(id, ownerId); entry.status = 'cancelled'; entry.updatedAt = new Date().toISOString(); this.save(); return structuredClone(entry) }

    private require(id: string, ownerId: string): NodeEnrollment { const entry = this.entries.get(id); if (!entry || entry.ownerId !== ownerId) throw new Error('Enrollment not found'); return entry }
    private load(): void { if (!existsSync(this.file)) return; try { for (const value of JSON.parse(readFileSync(this.file, 'utf8')) as NodeEnrollment[]) this.entries.set(value.id, value) } catch { /* fail empty */ } }
    private save(): void { mkdirSync(dirname(this.file), { recursive: true }); atomicWriteJsonSync(this.file, [...this.entries.values()]) }
}

function entryRuntimeLabel(runtime?: EnrollmentRuntime): string { return runtime === 'systemd' ? 'systemd service' : 'hardened Docker container' }
let singleton: NodeEnrollmentService | null = null
export function getNodeEnrollmentService(): NodeEnrollmentService { return singleton ||= new NodeEnrollmentService() }

