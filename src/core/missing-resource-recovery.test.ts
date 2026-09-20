import { describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { planMissingResourceRecovery, recoverMissingResource, selectMissingResourceCandidate } from './missing-resource-recovery.js'
import { ExecutionKernel } from './execution-kernel.js'

describe('missing resource recovery', () => {
    it('plans a bounded read-only lookup for a missing relative file', () => {
        const plan = planMissingResourceRecovery('read_file', { path: 'docs/RELESE_PLAN.md' }, { error: 'Datei nicht gefunden' }, '/workspace')
        expect(plan).toMatchObject({ requestedPath: 'docs/RELESE_PLAN.md', searchRoot: resolve('/workspace') })
        expect(plan?.searchArgs).toMatchObject({ pattern: '*.md', type: 'file', max_depth: 8 })
    })

    it('does not recover mutations or unrelated failures', () => {
        expect(planMissingResourceRecovery('write_file', { path: 'a.txt' }, { error: 'not found' })).toBeNull()
        expect(planMissingResourceRecovery('read_file', { path: 'a.txt' }, { error: 'permission denied' })).toBeNull()
    })

    it('refuses to scan a filesystem root for an absolute path with no safe parent', () => {
        expect(planMissingResourceRecovery('read_file', { path: join(process.platform === 'win32' ? 'Z:\\' : '/', 'definitely-absent', 'a.txt') }, { error: 'ENOENT' })).toBeNull()
    })

    it('selects a unique exact or high-confidence typo match and rejects ambiguity', () => {
        expect(selectMissingResourceCandidate('docs/RELEASE_PLAN.md', { results: [{ path: '/repo/docs/RELEASE_PLAN.md' }] })).toMatchObject({ reason: 'exact-name' })
        expect(selectMissingResourceCandidate('docs/RELESE_PLAN.md', { results: [{ path: '/repo/docs/RELEASE_PLAN.md' }] })).toMatchObject({ reason: 'fuzzy-name' })
        expect(selectMissingResourceCandidate('docs/RELEASE_PLAN.md', { results: [
            { path: '/repo/a/RELEASE_PLAN.md' }, { path: '/repo/b/RELEASE_PLAN.md' },
        ] })).toBeNull()
    })

    it('executes find and retry through one kernel and produces completion evidence', async () => {
        const kernel = new ExecutionKernel('Lies docs/RELESE_PLAN.md', {
            allowedChanges: { allowedTools: ['read_file', 'find_files'] },
        })
        const execute = vi.fn(async (toolName: string) => toolName === 'find_files'
            ? { results: [{ path: resolve('/workspace/docs/RELEASE_PLAN.md') }] }
            : { content: 'verified release plan' })
        let sequence = 0
        const recovery = await recoverMissingResource({
            toolName: 'read_file', args: { path: 'docs/RELESE_PLAN.md' },
            failedResult: { error: 'ENOENT' }, kernel, execute,
            nextCallId: name => `${name}-${++sequence}`, workspaceRoot: resolve('/workspace'),
        })
        expect(recovery).toMatchObject({ success: true, reason: 'fuzzy-name' })
        expect(execute.mock.calls.map(call => call[0])).toEqual(['find_files', 'read_file'])
        expect(kernel.validateCompletion('verified release plan').success).toBe(true)
    })

    it('stops after discovery when candidates are ambiguous', async () => {
        const kernel = new ExecutionKernel('Lies docs/RELEASE_PLAN.md', {
            allowedChanges: { allowedTools: ['read_file', 'find_files'] },
        })
        const execute = vi.fn(async () => ({ results: [
            { path: resolve('/workspace/a/RELEASE_PLAN.md') },
            { path: resolve('/workspace/b/RELEASE_PLAN.md') },
        ] }))
        const recovery = await recoverMissingResource({
            toolName: 'read_file', args: { path: 'docs/RELEASE_PLAN.md' },
            failedResult: { error: 'not found' }, kernel, execute,
            nextCallId: name => `${name}-1`, workspaceRoot: resolve('/workspace'),
        })
        expect(recovery).toMatchObject({ success: false, reason: 'ambiguous-or-missing' })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(kernel.validateCompletion('not found').success).toBe(false)
    })
})
