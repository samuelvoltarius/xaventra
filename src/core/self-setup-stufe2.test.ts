import { generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Stufe 2 (S2.4/S2.5): /setup apply never runs a free command anymore.
// Catalog-backed actions only enter the install queue; a ticket exists only
// after the owner's card „Ja“, or — P9, independent of YOLO — for entries with a
// standing permission in the one permission store (trust.json). Without the
// owner's code nothing else runs, YOLO or not. Workers only get image suggestions.

const childProcess = vi.hoisted(() => ({
    exec: vi.fn(() => { throw new Error('exec must not run') }),
    execSync: vi.fn(() => { throw new Error('execSync must not run') }),
    execFile: vi.fn(() => { throw new Error('execFile must not run in the daemon') }),
    spawn: vi.fn(() => { throw new Error('spawn must not run') }),
}))
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<any>()), ...childProcess }))

import { applySelfSetupAction } from './self-setup-orchestrator.js'
import { approveQueuedInstall, loadInstallQueue, proposeCatalogInstall, rollbackQueuedInstall, setApprovalLevel, type InstallQueueDeps, type InstallTargetNode } from '../install/install-queue.js'
import { installTicketBytes, verifyInstallTicket } from '../install/install-ticket.js'
import { getInstallCatalog } from '../install/install-catalog.js'

const STATE_FILE = join(process.cwd(), '.nova-data', 'setup-state.json')
let previousState: string | null = null
beforeAll(() => { previousState = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf-8') : null })
afterAll(() => { if (previousState !== null) writeFileSync(STATE_FILE, previousState) })

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const spark: InstallTargetNode = { nodeId: 'spark', installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64', gpuVendor: 'nvidia', version: '2.79.4' }
const owner = { permission: 'owner', principalId: 'alfred', channel: 'telegram' }
let deps: InstallQueueDeps
let host: { execute: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }

function writeState(mode: 'proposal' | 'yolo', actions: any[]): void {
    mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), mode, summary: '', actions,
        voice: { ok: true, warnings: [] }, memory: {}, llm: { localCandidates: [] }, mesh: { nodes: [], missingCapabilities: [] } }))
}
const ffmpegAction = { id: 'local:ffmpeg', type: 'local_shell', title: 'ffmpeg', reason: 'r', risk: 'medium', command: 'sudo apt-get install -y ffmpeg', catalogId: 'ffmpeg' }

beforeEach(() => {
    for (const fn of Object.values(childProcess)) fn.mockClear()
    host = {
        execute: vi.fn(async (ticket: any) => ({ success: true, nodeId: 'spark', ticketId: ticket.payload.id, catalogId: ticket.payload.catalogId, evidenceHash: 'e'.repeat(64), newPackages: ['ffmpeg'], rollback: { argv: ['/usr/bin/apt-get', 'remove', '-y', '--', 'ffmpeg'] } })),
        rollback: vi.fn(async () => ({ success: true, restored: true, evidenceHash: 'f'.repeat(64) })),
        status: vi.fn(async () => null),
    }
    deps = { dataDir: mkdtempSync(join(tmpdir(), 'install-queue-')), ticketPrivateKey: privateKey, hostNodeId: 'spark', hostClientId: 'xaventra-main', hostClient: host }
})

describe('/setup apply runs no free commands (Stufe 2)', () => {
    it('refuses a free local command even with the owner confirmation', async () => {
        writeState('proposal', [{ id: 'local:echo', type: 'local_shell', title: 't', reason: 'r', risk: 'low', command: 'echo ok' }])
        const result = await applySelfSetupAction('local:echo', 'APPLY:local:echo', { installDeps: deps, target: spark })
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Freie Befehle/)
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
    })

    it('refuses a well-formed remote ssh command and YOLO free commands alike', async () => {
        writeState('yolo', [
            { id: 'remote:good', type: 'remote_shell', title: 't', reason: 'r', risk: 'medium', command: "ssh -- xaventra@100.64.0.24 'ollama pull nomic-embed-text'" },
            { id: 'local:gpu', type: 'local_shell', title: 't', reason: 'r', risk: 'medium', command: 'npm rebuild node-llama-cpp' },
        ])
        expect((await applySelfSetupAction('remote:good', 'APPLY:remote:good', { installDeps: deps, target: spark })).success).toBe(false)
        expect((await applySelfSetupAction('local:gpu', '', { installDeps: deps, target: spark })).success).toBe(false)
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
        expect(host.execute).not.toHaveBeenCalled()
    })

    it('turns a catalog-backed action into a queued proposal, never an execution', async () => {
        writeState('proposal', [ffmpegAction])
        const result = await applySelfSetupAction('local:ffmpeg', 'APPLY:local:ffmpeg', { installDeps: deps, target: spark })
        expect(result.message).toMatch(/\/setup approve iq-[a-f0-9]{12}/)
        expect(loadInstallQueue(deps)).toMatchObject([{ catalogId: 'ffmpeg', nodeId: 'spark', status: 'queued', route: { kind: 'host-agent' } }])
        expect(host.execute).not.toHaveBeenCalled()
        for (const fn of Object.values(childProcess)) expect(fn).not.toHaveBeenCalled()
    })
})

describe('P9: standing permission from the one store, never YOLO', () => {
    it('keeps an entry without standing permission queued, YOLO or not', async () => {
        for (const mode of ['yolo', 'proposal'] as const) {
            writeState(mode, [ffmpegAction])
            const result = await applySelfSetupAction('local:ffmpeg', '', { installDeps: deps, target: spark })
            expect(result.success).toBe(false)
        }
        expect(host.execute).not.toHaveBeenCalled()
        expect(loadInstallQueue(deps)[0].status).toBe('queued')
    })

    it('installs an entry with standing permission without YOLO, signed as policy:vertrauensleiter (never as owner)', async () => {
        expect(setApprovalLevel('ffmpeg', 'erlauben', owner, deps).ok).toBe(true)
        expect(existsSync(join(deps.dataDir, 'install-policy.json'))).toBe(false)
        expect(JSON.parse(readFileSync(join(deps.dataDir, 'action-policy', 'trust.json'), 'utf8')).erlaubt['install-katalog|ffmpeg'])
            .toMatchObject({ kind: 'install-katalog', subject: 'ffmpeg', by: 'owner:alfred' })
        writeState('proposal', [ffmpegAction])
        const result = await applySelfSetupAction('local:ffmpeg', '', { installDeps: deps, target: spark })
        expect(result.success).toBe(true)
        expect(host.execute).toHaveBeenCalledOnce()
        const signed = host.execute.mock.calls[0][0]
        const ticket = verifyInstallTicket(signed, { nodeId: 'spark', clientId: 'xaventra-main', publicKey, catalog: getInstallCatalog() })
        expect(ticket).toMatchObject({ catalogId: 'ffmpeg', approval: 'erlauben', approvedBy: 'policy:vertrauensleiter', operation: 'install' })
        expect(verify(null, installTicketBytes(ticket), publicKey, Buffer.from(signed.signature, 'base64'))).toBe(true)
        expect(loadInstallQueue(deps)[0]).toMatchObject({ status: 'done', ticketId: ticket.id })
    })

    it('„fragen“ removes the standing permission again', async () => {
        setApprovalLevel('ffmpeg', 'erlauben', owner, deps)
        expect(setApprovalLevel('ffmpeg', 'fragen', owner, deps).ok).toBe(true)
        writeState('proposal', [ffmpegAction])
        await applySelfSetupAction('local:ffmpeg', '', { installDeps: deps, target: spark })
        expect(host.execute).not.toHaveBeenCalled()
    })

    it('migrates a legacy install-policy.json „erlauben“ once into trust.json', async () => {
        writeFileSync(join(deps.dataDir, 'install-policy.json'), JSON.stringify({ version: 1, levels: { ffmpeg: 'erlauben', 'playwright-chromium': 'fragen' } }))
        writeState('proposal', [ffmpegAction])
        const result = await applySelfSetupAction('local:ffmpeg', '', { installDeps: deps, target: spark })
        expect(result.success).toBe(true)
        expect(existsSync(join(deps.dataDir, 'install-policy.json'))).toBe(false)
        expect(existsSync(join(deps.dataDir, 'install-policy.json.migrated'))).toBe(true)
        const grants = JSON.parse(readFileSync(join(deps.dataDir, 'action-policy', 'trust.json'), 'utf8')).erlaubt
        expect(Object.keys(grants)).toEqual(['install-katalog|ffmpeg'])
    })

    it('YOLO without the owner code never applies a config patch (closed gap)', async () => {
        writeState('yolo', [{ id: 'cfg:x', type: 'config_patch', title: 't', reason: 'r', risk: 'low', patch: { selfSetup: { probe: true } }, configPath: 'selfSetup.probe' }])
        const result = await applySelfSetupAction('cfg:x', '', { installDeps: deps, target: spark })
        expect(result.success).toBe(false)
        expect(result.message).toMatch(/Freigabe/)
    })
})

describe('owner approval cannot come from the model', () => {
    it('refuses non-owner, model-originated and fabricated approvals', async () => {
        const { proposal } = proposeCatalogInstall('ffmpeg', spark, deps, 'model')
        for (const approver of [{ ...owner, permission: 'admin' }, { ...owner, permission: 'user' }, { ...owner, viaModel: true }, { permission: 'owner', principalId: '' }]) {
            expect((await approveQueuedInstall(proposal!.id, approver, deps)).ok).toBe(false)
        }
        expect((await approveQueuedInstall('iq-000000000000', owner, deps)).ok).toBe(false)
        expect((await approveQueuedInstall('APPROVE:ffmpeg', owner, deps)).ok).toBe(false)
        expect(setApprovalLevel('ffmpeg', 'erlauben', { ...owner, viaModel: true }, deps).ok).toBe(false)
        expect(host.execute).not.toHaveBeenCalled()
    })

    it('owner approval issues one ticket, receipt lands in the queue, rollback is owner-only', async () => {
        const { proposal } = proposeCatalogInstall('ffmpeg', spark, deps, 'owner')
        const approved = await approveQueuedInstall(proposal!.id, owner, deps)
        expect(approved.ok).toBe(true)
        expect(host.execute).toHaveBeenCalledOnce()
        expect(host.execute.mock.calls[0][0].payload).toMatchObject({ approvedBy: 'owner:alfred', approval: 'fragen', nodeId: 'spark' })
        expect((await approveQueuedInstall(proposal!.id, owner, deps)).ok).toBe(false)
        expect((await rollbackQueuedInstall(proposal!.id, { ...owner, permission: 'admin' }, deps)).ok).toBe(false)
        const rolled = await rollbackQueuedInstall(proposal!.id, owner, deps)
        expect(rolled.ok).toBe(true)
        expect(host.rollback.mock.calls[0][0].payload).toMatchObject({ operation: 'rollback', installTicketId: host.execute.mock.calls[0][0].payload.id })
        expect(loadInstallQueue(deps)[0].status).toBe('rolled-back')
    })

    it('refuses ids that are not in the catalog', () => {
        for (const id of ['htop', 'ffmpeg;rm', 'ollama-model:llama3', '../x']) expect(proposeCatalogInstall(id, spark, deps, 'model').ok).toBe(false)
        expect(loadInstallQueue(deps)).toEqual([])
    })
})

describe('workers and NAS never get apt', () => {
    const worker: InstallTargetNode = { nodeId: 'xaventra-ns1', installPath: 'image', role: 'worker', local: false, platform: 'linux', arch: 'x64', version: '2.79.4' }
    it('a worker entry yields only an image-variant suggestion and no ticket', async () => {
        const { proposal } = proposeCatalogInstall('ffmpeg', worker, deps, 'owner')
        expect(proposal).toMatchObject({ status: 'suggested', route: { kind: 'image', variant: 'ffmpeg', packages: ['ffmpeg'], suggestedTag: '2.79.4-ffmpeg' } })
        expect((await approveQueuedInstall(proposal!.id, owner, deps)).ok).toBe(false)
        expect(host.execute).not.toHaveBeenCalled()
    })
    it('NAS refuses system packages and only suggests models into the volume', () => {
        const nas: InstallTargetNode = { ...worker, nodeId: 'xaventra-nas', modelOnly: true }
        expect(proposeCatalogInstall('xfce-workstation', nas, deps, 'owner').proposal?.route.kind).toBe('refused')
        expect(proposeCatalogInstall('ollama-model:nomic-embed-text', nas, deps, 'owner').proposal?.route).toMatchObject({ kind: 'model-volume', model: 'nomic-embed-text' })
    })
    it('node-llama-cpp-cuda only on the Spark (arm64 + NVIDIA via host agent)', () => {
        expect(proposeCatalogInstall('node-llama-cpp-cuda', { ...spark, gpuVendor: 'none' }, deps, 'owner').proposal?.route.kind).toBe('refused')
        expect(proposeCatalogInstall('node-llama-cpp-cuda', worker, deps, 'owner').proposal?.route.kind).toBe('refused')
        expect(proposeCatalogInstall('node-llama-cpp-cuda', spark, deps, 'owner').proposal?.route.kind).toBe('host-agent')
    })
})
