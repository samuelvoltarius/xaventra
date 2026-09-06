import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDesktopApi, desktopExecutionPrincipal } from './desktop-api.js'
import { getNovaState, updateNovaState } from '../core/nova-state.js'
import { getDesktopAgentContext } from './desktop-agent-context.js'

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
