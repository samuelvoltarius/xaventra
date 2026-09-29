import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fileTools } from './complete-registry.js'

// write_file protection regression (review "Mittel/Sicherheit"): the list
// named nova.config.json while the runtime reads xaventra.config.json, and
// paths outside the workspace, the user database and dist/ were writable.

const base = join(process.cwd(), '.nova-test-tmp', `write-guard-${randomUUID()}`)
const workspace = join(base, 'workspace')
const write = (path: string) => fileTools.find(t => t.name === 'write_file')!.handler({ path, content: 'plain text' }) as Promise<any>

beforeAll(() => mkdirSync(workspace, { recursive: true }))
afterAll(() => rmSync(base, { recursive: true, force: true }))
afterEach(() => vi.unstubAllEnvs())

describe('write_file protected paths', () => {
    it.each([
        'xaventra.config.json', 'XAVENTRA.CONFIG.JSON', 'nova.config.json', 'Nova.Config.json',
        '.nova-data/multi-user/users.json', '.NOVA-DATA/Multi-User/users.json',
        'dist/daemon.js', 'DIST/x.txt', 'SRC/Core/x.txt', '.ENV', '.env.local',
        '../outside.txt', '../../escape.txt', 'sub/../../outside.txt',
    ])('blocks %s', async path => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const result = await write(path)
        expect(result.blocked, path).toBe(true)
        expect(existsSync(join(base, 'outside.txt'))).toBe(false)
    })

    it('blocks absolute paths outside the workspace', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        expect((await write(join(base, 'outside.txt'))).blocked).toBe(true)
        expect(existsSync(join(base, 'outside.txt'))).toBe(false)
    })

    // INT-2: the fail-closed CodeGuardian used to block most real modules
    // (imports, unknown identifiers) because it tried to execute them.
    it('writes a typical TypeScript module with imports through the CodeGuardian', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const content = [
            "import { join } from 'node:path'",
            "import { loadThing, type Thing } from '../core/thing.js'",
            'export interface Options { root: string; limit?: number }',
            'export class Finder<T extends Thing> {',
            '    constructor(private readonly options: Options) {}',
            "    find(name: string): T | undefined { return loadThing(join(this.options.root, name)) as T | undefined }",
            '}',
        ].join('\n')
        const handler = fileTools.find(t => t.name === 'write_file')!.handler
        const result = await handler({ path: 'mods/finder.ts', content }) as any
        expect(result.error).toBeUndefined()
        expect(result.success).toBe(true)
        expect(readFileSync(join(workspace, 'mods', 'finder.ts'), 'utf8')).toBe(content)
    })

    it('blocks a module with an indirect eval, also for .cjs files', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const handler = fileTools.find(t => t.name === 'write_file')!.handler
        for (const path of ['mods/bad.ts', 'mods/bad.cjs']) {
            const result = await handler({ path, content: 'const run = (0, globalThis.eval)\nmodule.exports = (s) => run(s)\n' }) as any
            expect(result.blocked, path).toBe(true)
            expect(existsSync(join(workspace, path))).toBe(false)
        }
    })

    it('still writes ordinary files inside the workspace', async () => {
        vi.stubEnv('XAVENTRA_WORKSPACE_ROOT', workspace)
        const result = await write('notes/out.txt')
        expect(result.success).toBe(true)
        expect(readFileSync(join(workspace, 'notes', 'out.txt'), 'utf8')).toBe('plain text')
    })
})
