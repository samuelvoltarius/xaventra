import { describe, expect, it, vi } from 'vitest'

const HAL_PATH = '/opt/novaos/hal/platform-info.json'
vi.mock('node:child_process', () => ({ execSync: () => { throw new Error('no hardware probes in tests') } }))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        existsSync: (path: any) => path === HAL_PATH || actual.existsSync(path),
        readFileSync: (path: any, ...rest: any[]) => path === HAL_PATH
            ? JSON.stringify({ platform: 'gx10', name: 'Fixture GX10', arch: 'arm64', ram_mb: 131072 })
            : (actual.readFileSync as any)(path, ...rest),
    }
})
import { detectPlatformRole } from './hardware-role.js'

describe('platform role detection (R2 A24)', () => {
    it('falls back to OS detection for an unknown HAL platform value', () => {
        const role = detectPlatformRole()
        expect(role.roleName).toBeTypeOf('string')
        expect(['desktop', 'rpi', 'jetson', 'dgx']).toContain(role.platform)
    })
})
