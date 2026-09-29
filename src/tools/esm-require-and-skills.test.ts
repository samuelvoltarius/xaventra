import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const perms = vi.hoisted(() => ({ getUserPermission: vi.fn((id: string) => id === 'owner-1' ? 'owner' : 'admin') }))
vi.mock('../users/multi-user-middleware.js', async (original) => ({ ...(await original() as object), getUserPermission: perms.getUserPermission }))
const child = vi.hoisted(() => ({ execSync: vi.fn(() => 'installed\n') }))
vi.mock('node:child_process', async (original) => ({ ...(await original() as object), execSync: child.execSync }))
vi.mock('../mesh/mesh-brain.js', () => ({ getMeshBrain: () => ({ load: () => ({ summary: 'cached mesh summary' }), scan: vi.fn() }) }))
vi.mock('../core/skills-loader.js', () => ({ loadAllSkills: () => [] }))
vi.mock('../mesh/event-hub.js', () => ({ emit: vi.fn() }))

let dir = ''
let registry: typeof import('./complete-registry.js')
beforeAll(async () => { registry = await import('./complete-registry.js') }, 120_000)
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'esm-require-'))
    writeFileSync(join(dir, 'xaventra.config.json'), JSON.stringify({ apis: { searxng_url: 'http://192.0.2.7:8080' }, nodes: [] }))
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    vi.stubEnv('NOVA_SEARXNG_URL', '')
    child.execSync.mockClear()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('R2 T25: no bare require in ESM code paths', () => {
    it('searxng reads the configured URL', async () => {
        const { getSearXNGUrl } = await import('./searxng-search.js')
        expect(getSearXNGUrl()).toBe('http://192.0.2.7:8080')
    })
    it('mesh_scan reads the configuration', async () => {
        const tool = registry.ALL_TOOLS.find(entry => entry.name === 'mesh_scan')!
        expect(await tool.handler({})).toBe('cached mesh summary')
    })
    it('list_skills lists installed skill directories', async () => {
        vi.resetModules()
        const { listInstalledSkills } = await import('./skills-import-cli.js')
        mkdirSync(join(dir, '.agent', 'skills', 'demo-skill'), { recursive: true })
        expect(listInstalledSkills()).toEqual(['demo-skill'])
    })
})

describe('R2 T25: source scan (vitest itself provides require, production ESM does not)', () => {
    it.each(['searxng-search.ts', 'skills-import-cli.ts', 'complete-registry.ts', 'vision-tool.ts', 'cad-tool.ts', 'browser.ts'])('%s has no bare require of fs/path', (file) => {
        const source = readFileSync(join(__dirname, file), 'utf8')
        const code = source.split('
').filter(line => !line.trim().startsWith('//'))
        expect(code.filter(line => /(^|[^\w.'"`])require\((['"])(node:)?(fs|path)\)/.test(line))).toEqual([])
    })
})

describe('R2 T28: import_skill only with owner approval', () => {
    it('refuses without approval and never runs npx', async () => {
        const tool = registry.ALL_TOOLS.find(entry => entry.name === 'import_skill')!
        for (const params of [{ authorizationUserId: 'owner-1', channel: 'telegram' }, { authorizationUserId: 'admin-1', channel: 'telegram', confirm: 'x' }]) {
            const result = await tool.handler({ ...params, package: 'evil/skill' }) as any
            expect(result.success).toBe(false)
        }
        expect(child.execSync).not.toHaveBeenCalled()
    })
    it('rejects option-shaped package names', async () => {
        const { importSkill } = await import('./skills-import-cli.js')
        expect((await importSkill('--prefix/tmp/evil')).success).toBe(false)
        expect(child.execSync).not.toHaveBeenCalled()
    })
})
