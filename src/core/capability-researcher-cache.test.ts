import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawnSubagent = vi.hoisted(() => vi.fn(async () => { throw new Error('search backend temporarily down') }))
vi.mock('../agents/subagent-orchestrator.js', () => ({ spawnSubagent }))
import { researchCapability } from './capability-researcher.js'

const linuxNode = {
    name: 'linux-node', host: 'linux.example', online: true, capabilities: [], services: {}, canInstall: [],
    recommendedFor: [], ollamaModels: [], hardware: { disks: ['nvme1n1'], ram: 'ram4x16' },
} as any

beforeEach(() => {
    spawnSubagent.mockClear()
    rmSync(join(process.cwd(), '.nova-data', 'capability-research.json'), { force: true })
})

describe('capability research (R2 A22)', () => {
    it('does not mistake an NVMe Linux node for macOS', async () => {
        const result = await researchCapability('stt', linuxNode, { skipWeb: true, force: true })
        expect(result.os).toBe('linux')
        expect(result.recommended.installCommand).not.toMatch(/\bbrew\b/)
    })

    it('does not cache a static fallback after a transient research failure', async () => {
        await researchCapability('tts', linuxNode)
        await researchCapability('tts', linuxNode)
        expect(spawnSubagent).toHaveBeenCalledTimes(2)
    })
})
