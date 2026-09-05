import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BotProfileStore } from './bot-profile-store.js'
import { TopicRoomStore } from './topic-room-store.js'
import { ExternalAgentRegistry } from './external-agent-registry.js'
import { NodeEnrollmentService } from './node-enrollment.js'
import { getDesktopModuleCatalog } from './module-catalog.js'
import { advanceSkillProposal, createSkillProposal, getSkillProposals } from '../tools/skill-builder.js'
import { DesktopControlQueue } from './desktop-control.js'
import { pruneDesktopCaptures, withDesktopBotTimeout } from './desktop-api.js'
import { getDesktopAgentContext, publishDesktopAgentOutcome, runWithDesktopAgentContext } from './desktop-agent-context.js'

const roots: string[] = []
function tempFile(name: string): string {
    const root = mkdtempSync(join(tmpdir(), 'nova-desktop-'))
    roots.push(root)
    return join(root, name)
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Nova Desktop platform stores', () => {
    it('bounds a stalled group-chat bot without blocking every other reply', async () => {
        await expect(withDesktopBotTimeout(new Promise(() => {}), 10)).rejects.toThrow('Bot-Lauf nach 1 Sekunden beendet')
        await expect(withDesktopBotTimeout(Promise.resolve('ready'), 100)).resolves.toBe('ready')
    })

    it('seeds governed native bots and keeps custom bots owner-scoped', () => {
        const store = new BotProfileStore(tempFile('bots.json'))
        expect(store.list('owner-a').map(bot => bot.id)).toContain('nova')
        expect(store.list('owner-a').map(bot => bot.id)).toContain('red-team-lab')

        const custom = store.create('owner-a', {
            name: 'Hermes Research', handle: 'hermes-research', avatar: 'H', color: '#4F7CFF',
            description: 'External research worker', specialization: 'research', source: 'hermes',
            externalConnectionId: 'external-1', externalAgentId: 'research', instructions: 'Research only.',
            toolPacks: [], deniedTools: [], preferredNodeIds: [],
            modelPolicy: { mode: 'auto', fallbackToAuto: true }, autonomy: 'observe', enabled: true,
        })

        expect(store.get(custom.id, 'owner-a')?.source).toBe('hermes')
        expect(store.get(custom.id, 'owner-b')).toBeUndefined()
        expect(store.remove('nova', 'owner-a')).toBe(false)
    })

    it('persists topic rooms with selected bots, nodes and pinned model', () => {
        const file = tempFile('rooms.json')
        const store = new TopicRoomStore(file)
        const room = store.createRoom('owner-a', {
            title: 'Release 2.74', topic: 'Desktop rollout', botIds: ['nova', 'developer'],
            preferredNodeIds: ['nova-spark'], modelMode: 'pinned', pinnedModel: 'qwen3.5',
            pinnedRouteId: 'nova-spark::vllm::qwen3.5', workspaceId: 'workspace-a',
        })
        store.addMessage('owner-a', room.id, {
            authorType: 'user', authorId: 'owner-a', content: 'Build it', verifiedEvidence: 1,
            runId: 'run-a', evidence: { durationMs: 240, tools: [{ name: 'desktop_workspace', success: true }] },
        })

        const reloaded = new TopicRoomStore(file)
        expect(reloaded.getRoom(room.id, 'owner-a')).toMatchObject({
            botIds: ['nova', 'developer'], preferredNodeIds: ['nova-spark'], pinnedModel: 'qwen3.5',
            pinnedRouteId: 'nova-spark::vllm::qwen3.5', workspaceId: 'workspace-a',
        })
        expect(reloaded.listMessages('owner-a', room.id)).toEqual([
            expect.objectContaining({ runId: 'run-a', verifiedEvidence: 1, evidence: expect.objectContaining({ durationMs: 240 }) }),
        ])
        expect(() => reloaded.listMessages('owner-b', room.id)).toThrow('Room not found')
    })

    it('accepts only explicit Hermes/OpenClaw endpoints and credential references', () => {
        const store = new ExternalAgentRegistry(tempFile('external.json'))
        const connection = store.create('owner-a', {
            name: 'Local Hermes', kind: 'hermes', baseUrl: 'http://127.0.0.1:8080',
            model: 'hermes-agent', credentialEnv: 'NOVA_EXTERNAL_AGENT_HERMES_TOKEN',
        })
        expect(connection.baseUrl).toBe('http://127.0.0.1:8080')
        expect(store.list('owner-b')).toEqual([])
        expect(() => store.create('owner-a', {
            name: 'Bad', kind: 'openclaw', baseUrl: 'http://169.254.169.254',
            model: 'openclaw/default', credentialEnv: 'TOKEN',
        })).toThrow()
    })

    it('creates fail-closed node enrollments with explicit host verification', () => {
        const store = new NodeEnrollmentService(tempFile('nodes.json'))
        const worker = store.create('owner-a', {
            nodeId: 'nova-nas', displayName: 'NAS Worker', host: '192.0.2.30', sshUser: 'nova',
            expectedHostKeyFingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCD', role: 'worker', runtime: 'docker',
        })
        expect(worker).toMatchObject({ status: 'draft', mainEligible: false, channelMode: 'disabled' })
        expect(store.approve(worker.id, 'owner-a').status).toBe('approved')
        expect(store.markAwaitingNode(worker.id, 'owner-a').status).toBe('awaiting-node')
        expect(() => store.create('owner-a', {
            nodeId: 'nova-unverified', displayName: 'Bad', host: 'node.local', sshUser: 'nova',
            expectedHostKeyFingerprint: 'unknown',
        })).toThrow('verified SHA256 SSH host-key fingerprint')
    })

    it('projects ADA-style capabilities from Novas governed tool registry', () => {
        const modules = getDesktopModuleCatalog()
        expect(modules.find(module => module.id === 'local-voice')?.availableTools).toContain('speak')
        expect(modules.find(module => module.id === 'cad-studio')?.availableTools).toContain('cad_generate')
        expect(modules.find(module => module.id === 'visual-awareness')?.limitation).toContain('keine Login-')
        expect(modules.find(module => module.id === 'skill-forge')?.inspiration).toBe('Ada-SI')
    })

    it('keeps Ada-SI-inspired Forge code inert until every evidence gate passes', () => {
        const proposal = createSkillProposal({
            ownerId: 'owner-a', name: 'sum_values', description: 'Adds two values', why: 'fixture gap',
            code: 'return Number(params.a) + Number(params.b)',
            parameters: [{ name: 'a', type: 'number', description: 'A' }, { name: 'b', type: 'number', description: 'B' }],
        })
        expect(proposal.status).toBe('proposed')
        expect(proposal.activationBlockedReason).toContain('Native sandbox')
        expect(advanceSkillProposal(proposal.id, 'owner-a', 'active', 'operator:test', { operatorApproved: true })).toBeNull()
        expect(advanceSkillProposal(proposal.id, 'owner-a', 'sandbox-authorized', 'operator:test', { operatorApproved: true })?.status).toBe('sandbox-authorized')
        expect(advanceSkillProposal(proposal.id, 'owner-a', 'sandbox-tested', 'unverified:test')).toBeNull()
        expect(getSkillProposals(10, 'owner-b')).toEqual([])
        expect(() => createSkillProposal({ ownerId: 'owner-a', name: 'escape', description: 'bad', why: 'test', code: 'return process.env' })).toThrow('Static skill validation failed')
    })

    it('delivers only typed desktop commands and requires a matching client acknowledgement', () => {
        const queue = new DesktopControlQueue(tempFile('control.json'))
        const command = queue.enqueue('owner-a', 'navigate', { section: 'nodes' }, 'tool:test')
        const delivered = queue.next('owner-a', 'client-a')
        expect(delivered).toMatchObject({ id: command.id, status: 'delivered', action: 'navigate' })
        expect(() => queue.acknowledge('owner-a', command.id, 'client-b', true)).toThrow('does not match')
        expect(queue.acknowledge('owner-a', command.id, 'client-a', true).status).toBe('acknowledged')
        expect(() => queue.enqueue('owner-a', 'navigate', { section: 'unknown' as any })).toThrow('section is not allowed')
    })

    it('projects outcome evidence without leaking its process-local callback', () => {
        let received: any
        runWithDesktopAgentContext({
            principalId: 'owner-a', clientId: 'client-a', authorizationUserId: 'desktop:owner-a',
            roomId: 'room-a', botId: 'nova', preferredNodeIds: ['nova-spark'], modelMode: 'auto',
            workspaceId: 'workspace-a', onOutcome: value => { received = value },
        }, () => {
            expect(getDesktopAgentContext()).toMatchObject({ workspaceId: 'workspace-a', clientId: 'client-a' })
            expect((getDesktopAgentContext() as any).onOutcome).toBeUndefined()
            publishDesktopAgentOutcome({ durationMs: 50, tools: [{ name: 'mesh_nodes', success: true }], verifiedEvidence: 1 })
        })
        expect(received).toMatchObject({ verifiedEvidence: 1, tools: [{ name: 'mesh_nodes', success: true }] })
    })

    it('returns verified screen-capture evidence only to the matching desktop owner and client', async () => {
        const queue = new DesktopControlQueue(tempFile('captures.json'))
        const command = queue.enqueue('owner-a', 'capture_screen', {}, 'tool:desktop_screenshot', 'client-a')
        expect(queue.next('owner-b', 'client-b')).toBeNull()
        expect(queue.next('owner-a', 'client-b')).toBeNull()
        expect(queue.next('owner-a', 'client-a')?.action).toBe('capture_screen')
        queue.acknowledge('owner-a', command.id, 'client-a', true, undefined, {
            kind: 'screen_capture', path: '/isolated/capture.jpg', mimeType: 'image/jpeg', size: 1024,
            sha256: 'a'.repeat(64), width: 800, height: 450,
        })
        await expect(queue.waitForCompletion('owner-a', command.id, 500)).resolves.toMatchObject({
            status: 'acknowledged', result: { kind: 'screen_capture', sha256: 'a'.repeat(64) },
        })
        expect(queue.get('owner-b', command.id)).toBeNull()
    })

    it('delivers workspace reads only to the exact bound desktop client', async () => {
        const queue = new DesktopControlQueue(tempFile('workspace-control.json'))
        expect(() => queue.enqueue('owner-a', 'workspace_operation', { workspaceId: 'workspace-a', operation: 'read', relativePath: 'package.json' })).toThrow('exact desktop client')
        const command = queue.enqueue('owner-a', 'workspace_operation', {
            workspaceId: 'workspace-a', operation: 'read', relativePath: 'package.json',
        }, 'tool:desktop_workspace', 'client-a')
        expect(queue.next('owner-a', 'client-b')).toBeNull()
        expect(queue.next('owner-a', 'client-a')).toMatchObject({ id: command.id, action: 'workspace_operation' })
        queue.acknowledge('owner-a', command.id, 'client-a', true, undefined, {
            kind: 'workspace_result', operation: 'read', workspaceId: 'workspace-a', rootName: 'nova-core',
            relativePath: 'package.json', content: '{"name":"nova"}', sha256: 'b'.repeat(64),
        })
        await expect(queue.waitForCompletion('owner-a', command.id, 500)).resolves.toMatchObject({
            status: 'acknowledged', result: { kind: 'workspace_result', operation: 'read', workspaceId: 'workspace-a' },
        })
    })

    it('bounds retained desktop captures without touching unrelated files', () => {
        const captureDir = tempFile('captures')
        const root = join(captureDir, '..')
        for (let index = 0; index < 35; index++) writeFileSync(join(root, `desktop-${index}.jpg`), 'capture')
        writeFileSync(join(root, 'keep-me.txt'), 'unrelated')
        const old = join(root, 'desktop-old.png')
        writeFileSync(old, 'capture')
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60_000)
        utimesSync(old, oldDate, oldDate)

        pruneDesktopCaptures(root)

        const files = readdirSync(root)
        expect(files.filter(name => /^desktop-.*\.(jpg|png)$/.test(name)).length).toBeLessThanOrEqual(30)
        expect(files).toContain('keep-me.txt')
        expect(files).not.toContain('desktop-old.png')
    })
})
