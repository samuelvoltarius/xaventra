import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopApi, desktopExecutionPrincipal } from './desktop-api.js'
import { getNovaState, updateNovaState } from '../core/nova-state.js'
import { getDesktopAgentContext } from './desktop-agent-context.js'

const repairMocks = vi.hoisted(() => ({
    authoritative: true,
    approve: vi.fn(async () => ({ success: false, error: 'PATCH_GATE token invalid' })),
    proposals: [{ id: 'patch-doctor-1', status: 'queued', file: 'src/example.ts', description: 'Bound repair', createdAt: 42,
        repairProfileId: 'profile-1', doctorCorrelation: { caseId: 'a'.repeat(24), runId: `doctor-candidate-${'1'.repeat(8)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(12)}`, observationHash: 'b'.repeat(64) },
        sandbox: { verified: true, reproductionPassed: true, cleanupVerified: true, rollbackPassed: true, recoveryPassed: true,
            baselineHash: 'c'.repeat(64), candidateHash: 'd'.repeat(64), output: 'private sandbox output' },
        search: 'private old source', replace: 'private new source', signedActivation: { secret: true } }],
}))
vi.mock('../synthesis/self-evolution.js', () => ({
    getPatchProposals: () => repairMocks.proposals,
    approveEvolutionProposal: repairMocks.approve,
}))
vi.mock('../mesh/leader-election.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../mesh/leader-election.js')>()),
    getServiceFencingToken: () => repairMocks.authoritative ? { epoch: 7, token: 'test-fencing-token' } : null,
}))

afterEach(() => vi.unstubAllEnvs())

describe('Desktop execution identity and current-message boundary', () => {
    it('uses the same channel identity mapping as the real pipeline', () => {
        const previous = getNovaState().config
        try {
            updateNovaState({ config: {} })
            expect(desktopExecutionPrincipal('alice')).toBe('desktop:alice')
            expect(desktopExecutionPrincipal('bob')).toBe('desktop:bob')
            updateNovaState({ config: { userPrincipals: { 'desktop:desktop:alice': 'linked-alice' }, userAliases: { 'desktop:bob': 'linked-alice' } } })
            expect(desktopExecutionPrincipal('alice')).toBe('linked-alice')
            expect(desktopExecutionPrincipal('bob')).toBe('desktop:bob')
        } finally { updateNovaState({ config: previous }) }
    })

    it('does not promote room history into the next command or consent', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        const calls: Array<{ content: string; context: ReturnType<typeof getDesktopAgentContext> }> = []
        const app = express(); app.use(express.json())
        registerDesktopApi(app, () => async content => { calls.push({ content, context: getDesktopAgentContext() }); return 'Recorded.' })
        const server = app.listen(0, '127.0.0.1')
        await new Promise<void>(resolve => server.once('listening', resolve))
        const endpoint = `http://127.0.0.1:${(server.address() as any).port}/api/desktop`
        const post = async (path: string, body: unknown) => {
            const res = await fetch(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nova-principal': 'history-regression-user' }, body: JSON.stringify(body) })
            expect(res.ok).toBe(true); return res.json() as Promise<any>
        }
        try {
            const room = await post('/rooms', { title: 'Regression', botIds: ['nova'] })
            await post(`/rooms/${room.id}/messages`, { content: 'Installiere Beispielsoftware erst nach Freigabe.' })
            await post(`/rooms/${room.id}/messages`, { content: '/status' })
            await post(`/rooms/${room.id}/messages`, { content: 'Guten Abend' })
            expect(calls.map(call => call.content)).toEqual(['Installiere Beispielsoftware erst nach Freigabe.', '/status', 'Guten Abend'])
            expect(calls[1].context).toMatchObject({ principalId: 'history-regression-user', authorizationUserId: 'desktop:history-regression-user', roomId: room.id })
        } finally {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    })
})

describe('Desktop Doctor repair approval boundary', () => {
    it('shows sanitized persisted evidence only to the owner and forwards a transient token to the canonical gate', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
        vi.stubEnv('NOVA_DESKTOP_OWNER_ID', 'owner')
        repairMocks.authoritative = true
        repairMocks.approve.mockClear()
        const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
        const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
        const endpoint = `http://127.0.0.1:${(server.address() as any).port}/api/desktop`
        const request = (path: string, owner = 'owner', init: RequestInit = {}) => fetch(endpoint + path, {
            ...init, headers: { 'Content-Type': 'application/json', 'x-nova-principal': owner, ...(init.headers || {}) },
        })
        try {
            expect((await request('/trust/repairs', 'different-user')).status).toBe(403)
            const listed = await (await request('/trust/repairs')).json() as any
            expect(listed.authoritative).toBe(true)
            expect(listed.proposals[0]).toMatchObject({ id: 'patch-doctor-1', evidence: { verified: true, rollbackPassed: true, recoveryPassed: true } })
            expect(JSON.stringify(listed)).not.toContain('private old source')
            expect(JSON.stringify(listed)).not.toContain('private sandbox output')
            expect(JSON.stringify(listed)).not.toContain('signedActivation')
            const denied = await request('/trust/repairs/patch-doctor-1/approve', 'owner', { method: 'POST', body: JSON.stringify({ approvalToken: 'transient-token' }) })
            expect(denied.status).toBe(409)
            expect(repairMocks.approve).toHaveBeenCalledWith('patch-doctor-1', 'transient-token')
            expect(JSON.stringify(await denied.json())).not.toContain('transient-token')
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    })

    it('fails closed before approval when this process lacks Main/dashboard fencing', async () => {
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', ''); vi.stubEnv('NOVA_DESKTOP_OWNER_ID', 'owner')
        repairMocks.authoritative = false; repairMocks.approve.mockClear()
        const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
        const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve))
        try {
            const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/desktop/trust/repairs/patch-doctor-1/approve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nova-principal': 'owner' }, body: JSON.stringify({ approvalToken: 'never-forwarded' }),
            })
            expect(response.status).toBe(409); expect(repairMocks.approve).not.toHaveBeenCalled()
        } finally { repairMocks.authoritative = true; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    })
})
