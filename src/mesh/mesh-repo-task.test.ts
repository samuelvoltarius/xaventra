import { describe, expect, it, vi } from 'vitest'
import type { GitReceipt, GitRequest } from './mesh-git.js'
import { formatRepoTaskResult, runRepoTaskOnNode, type RepoTaskDeps } from './mesh-repo-task.js'

// Mesh-Git (2.88): deliver → work on the node → collect → own branch → always clean up.

const COMMIT = 'c'.repeat(40)
const HEAD = 'd'.repeat(40)

function deps(over: Partial<RepoTaskDeps> = {}): RepoTaskDeps & { calls: string[] } {
    const calls: string[] = []
    const base: RepoTaskDeps = {
        localNodeId: () => 'main-node',
        route: vi.fn(async () => ({ nodeId: 'gpu-box', isLocal: false, reason: 'gpu-box: Modell qwen3-coder geladen, 16 Kerne' })),
        publish: vi.fn(async () => ({ commit: COMMIT })),
        head: vi.fn(async () => COMMIT),
        prepare: vi.fn(async (repo: string, commit: string, workId: string) => ({ operation: 'deliver' as const, repo, workId, commit, bundle: 'AAAA', sha256: 'e'.repeat(64) })),
        request: vi.fn(async (node: string, payload: GitRequest): Promise<GitReceipt> => {
            calls.push(`${payload.operation}@${node}`)
            if (payload.operation === 'deliver') return { operation: 'deliver', workId: payload.workId, commit: payload.commit, path: `mesh-work/${payload.workId}` }
            if (payload.operation === 'collect') return { operation: 'collect', workId: payload.workId, base: payload.base, head: HEAD, changedFiles: 2, bundle: 'AAAA', sha256: 'f'.repeat(64) }
            return { operation: 'release', workId: payload.workId, released: true }
        }),
        importResult: vi.fn(async (_repo: string, node: string, receipt) => ({ branch: `mesh/${node}/${receipt.workId}`, head: receipt.head, changedFiles: receipt.changedFiles })),
        spawn: vi.fn(async task => { calls.push(`spawn@${task.meshNode || 'local'}`); return { status: 'completed', output: 'Tests repariert.' } }),
        newWorkId: () => 'w-0000000000000001',
    }
    return Object.assign({ ...base, ...over }, { calls })
}

describe('runRepoTaskOnNode', () => {
    it('picks the node by strength, works on the same commit and returns the result branch', async () => {
        const d = deps()
        const result = await runRepoTaskOnNode({ repo: 'demo', task: 'Repariere die Tests' }, d)
        expect(d.calls).toEqual(['deliver@gpu-box', 'spawn@gpu-box', 'collect@gpu-box', 'release@gpu-box'])
        expect(result).toMatchObject({ status: 'completed', node: 'gpu-box', commit: COMMIT, branch: 'mesh/gpu-box/w-0000000000000001', changedFiles: 2 })
        const spawned = (d.spawn as any).mock.calls[0][0]
        expect(spawned.task).toContain('Arbeitsordner: mesh-work/w-0000000000000001')
        expect(spawned.task).toContain(`Stand ${COMMIT.slice(0, 12)}`)
        expect(spawned.tools).not.toContain('run_command')
        expect(formatRepoTaskResult(result)).toBe([
            'Erledigt auf gpu-box (gpu-box: Modell qwen3-coder geladen, 16 Kerne).',
            'Ergebnis im Zweig mesh/gpu-box/w-0000000000000001 (2 Dateien geändert). main bleibt unverändert.',
            '', 'Tests repariert.',
        ].join('\n'))
    })

    it('publishes a local repository first when a source path is given', async () => {
        const d = deps()
        await runRepoTaskOnNode({ repo: 'demo', task: 'x', sourcePath: '/work/demo', node: 'node-b' }, d)
        expect(d.publish).toHaveBeenCalledWith('/work/demo', 'demo')
        expect(d.route).not.toHaveBeenCalled()
        expect(d.calls[0]).toBe('deliver@node-b')
    })

    it('always cleans up on the node, also when the work fails', async () => {
        const d = deps({ spawn: vi.fn(async () => { throw new Error('Knoten antwortet nicht') }) })
        const result = await runRepoTaskOnNode({ repo: 'demo', task: 'x' }, d)
        expect(result).toMatchObject({ status: 'failed', error: 'Knoten antwortet nicht' })
        expect(d.calls).toEqual(['deliver@gpu-box', 'release@gpu-box'])
    })

    it('does not start without a mesh repo and says why', async () => {
        const d = deps({ head: vi.fn(async () => { throw new Error('Mesh-Repo demo gibt es noch nicht') }) })
        const result = await runRepoTaskOnNode({ repo: 'demo', task: 'x' }, d)
        expect(result).toEqual({ status: 'not-started', error: 'Mesh-Repo demo gibt es noch nicht' })
        expect(d.calls).toEqual([])
        expect(formatRepoTaskResult(result)).toBe('Nicht gestartet: Mesh-Repo demo gibt es noch nicht')
    })

    it('runs locally (no mesh hop) when this node fits best', async () => {
        const d = deps({ route: vi.fn(async () => ({ nodeId: 'main-node', isLocal: true, reason: 'läuft hier' })) })
        await runRepoTaskOnNode({ repo: 'demo', task: 'x' }, d)
        expect(d.calls).toEqual(['deliver@main-node', 'spawn@local', 'collect@main-node', 'release@main-node'])
    })
})
