/**
 * 2.89.4: Knoten-lokale Modell-Endpunkte (127.0.0.1) nur als Mesh-Job.
 * Main ruft die Peer-Adresse nie per HTTP — kein Fallback, kein Warten.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isLoopbackUrl, meshEndpoint, parseMeshEndpoint, requiresMeshJob, runNodeLocalModel } from './node-local-model.js'

const jobs = vi.hoisted(() => ({ calls: [] as any[], fail: false }))
vi.mock('./mesh-remote-exec.js', () => ({
    remoteExec: async (node: string, type: string, payload: any) => {
        jobs.calls.push({ node, type, payload })
        if (jobs.fail) throw new Error('mesh down')
        return { requestId: 'r', from: node, success: true, result: { ok: true }, durationMs: 1 }
    },
    registerHandler: vi.fn(),
}))

beforeEach(() => { jobs.calls.length = 0; jobs.fail = false })

describe('2.89.4: Mesh-Handle und Aufrufregel', () => {
    it('mesh:// ist der einzige Handle für einen fremden Knoten', () => {
        expect(meshEndpoint('ns1')).toBe('mesh://ns1')
        expect(meshEndpoint('ns1', '/api/embed')).toBe('mesh://ns1/api/embed')
        expect(parseMeshEndpoint('mesh://ns1/api/embed')).toEqual({ node: 'ns1', path: '/api/embed' })
        expect(parseMeshEndpoint('http://127.0.0.1:11434')).toBeNull()
    })

    it('fremder Knoten braucht immer einen Mesh-Job, eigener localhost nicht', () => {
        expect(requiresMeshJob({ baseUrl: 'mesh://ns1', node: 'ns1', localNodeId: 'main' })).toBe(true)
        expect(requiresMeshJob({ baseUrl: 'http://localhost:11434', node: 'ns1', localNodeId: 'main' })).toBe(true)
        expect(requiresMeshJob({ baseUrl: 'http://ns1.example.com:11434', node: 'ns1', localNodeId: 'main' })).toBe(true)
        expect(requiresMeshJob({ baseUrl: 'http://127.0.0.1:11434', node: 'main', localNodeId: 'main' })).toBe(false)
        expect(requiresMeshJob({ baseUrl: 'http://127.0.0.1:11434' })).toBe(false)
    })

    it('Loopback erkennen (Worker-Seite)', () => {
        expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true)
        expect(isLoopbackUrl('http://localhost:11434')).toBe(true)
        expect(isLoopbackUrl('http://ns1.example.com:11434')).toBe(false)
    })

    it('runNodeLocalModel: Mesh-Job, und bei Mesh-Fehler null ohne HTTP-Fallback', async () => {
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)
        expect(await runNodeLocalModel('ns1', { path: '/api/embed', body: { model: 'm' } })).toEqual({ ok: true })
        expect(jobs.calls).toHaveLength(1)
        expect(fetchSpy).not.toHaveBeenCalled()
        jobs.fail = true
        expect(await runNodeLocalModel('ns1', { path: '/api/embed', body: { model: 'm' } })).toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
        vi.unstubAllGlobals()
    })
})
