import { describe, expect, it, vi } from 'vitest'

const CONFIG_PATH = vi.hoisted(() => 'Z:/fake-r2-l9/xaventra.config.json')
const mesh = vi.hoisted(() => ({ discoverNodes: vi.fn(async () => [] as any[]) }))
vi.mock('../mesh/mesh-registry.js', () => ({ discoverNodes: mesh.discoverNodes }))
vi.mock('../config/config-path.js', () => ({ resolveConfigPath: () => CONFIG_PATH }))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        readFileSync: (p: any, ...rest: any[]) => p === CONFIG_PATH
            ? JSON.stringify({ model: 'qwen-configured' })
            : (actual.readFileSync as any)(p, ...rest),
    }
})

import { getCurrentModel } from './model-router.js'
import { resolveCapability } from './capability-router.js'

describe('R2 L9: ESM require() sites in intelligence', () => {
    it('model-router reads the configured model instead of always auto', () => {
        expect(getCurrentModel()).toBe('qwen-configured')
    })

    // Regression guard only: vite-node provides a require() shim, so the
    // pre-fix ReferenceError of the real ESM runtime cannot be shown here.
    it('capability-router resolves installed node modules locally', async () => {
        const resolution = await resolveCapability({
            name: 'vitest',
            check: { type: 'node_module', value: 'vitest' },
            install: [],
        } as any)
        expect(resolution.error).toBeUndefined()
        expect(resolution.runRemotely).toBe(false)
        expect(resolution.installed).toBe(false)
        expect(mesh.discoverNodes).not.toHaveBeenCalled()
    })
})
