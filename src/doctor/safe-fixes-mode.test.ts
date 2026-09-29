import { readFileSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// MI-11: applying a PATCH_GATE doctor fix rewrites the config (secrets). The
// replacement file must be created owner-only (0600), not with the umask.

const fsSpy = vi.hoisted(() => ({ writes: [] as Array<{ path: string; options: unknown }>, chmods: [] as Array<{ path: string; mode: number }> }))
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
        ...actual,
        writeFileSync: (path: any, data: any, options?: any) => {
            fsSpy.writes.push({ path: String(path), options })
            return actual.writeFileSync(path, data, options)
        },
        chmodSync: (path: any, mode: any) => {
            fsSpy.chmods.push({ path: String(path), mode: Number(mode) })
            return actual.chmodSync(path, mode)
        },
    }
})

import { applyApprovedDoctorProposal, type DoctorConfigProposal } from './safe-fixes.js'
import { resolveConfigPath } from '../config/config-path.js'

afterEach(() => { vi.unstubAllEnvs() })

describe('MI-11 doctor config rewrite permissions', () => {
    it('writes the replacement config and its backup as 0600', async () => {
        vi.stubEnv('NOVA_PATCH_GATE_TOKEN', 'gate-token-0123456789abcdef')
        const configPath = resolveConfigPath(process.cwd())
        const current = JSON.parse(readFileSync(configPath, 'utf8'))
        const proposal = { kind: 'doctor-config', status: 'queued', configPath: 'mesh.mode', configValue: current.mesh?.mode ?? 'standalone' } as unknown as DoctorConfigProposal
        const result = await applyApprovedDoctorProposal(proposal, 'gate-token-0123456789abcdef')
        expect(result.applied).toBe(true)
        const temp = `${configPath}.tmp`
        const write = fsSpy.writes.find(entry => entry.path === temp)
        expect(write?.options).toMatchObject({ mode: 0o600 })
        expect(fsSpy.chmods).toEqual(expect.arrayContaining([{ path: temp, mode: 0o600 }, { path: `${configPath}.bak`, mode: 0o600 }]))
        if (process.platform !== 'win32') expect(statSync(configPath).mode & 0o777).toBe(0o600)
    })
})
