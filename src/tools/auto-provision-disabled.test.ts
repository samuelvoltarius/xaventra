import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { AUTO_PROVISION_DISABLED, evolutionTools } from './complete-registry.js'

// Stufe 1 (30.09.2026): the confirm string "AUTO_PROVISION:<cap>" could be
// composed by the model itself and the old path ran ssh with
// StrictHostKeyChecking=no. Neither a confirm value nor YOLO may install.
describe('auto_provision is disabled', () => {
    const saved = { yolo: process.env.NOVA_YOLO, setup: process.env.NOVA_SELF_SETUP_YOLO }
    afterEach(() => {
        if (saved.yolo === undefined) delete process.env.NOVA_YOLO; else process.env.NOVA_YOLO = saved.yolo
        if (saved.setup === undefined) delete process.env.NOVA_SELF_SETUP_YOLO; else process.env.NOVA_SELF_SETUP_YOLO = saved.setup
    })
    const tool = () => evolutionTools.find(value => value.name === 'auto_provision')!

    it('refuses a self-composed confirm string and YOLO alike', async () => {
        expect(tool()).toBeTruthy()
        expect(await tool().handler({ capability: 'vision', confirm: 'AUTO_PROVISION:vision' } as any)).toBe(AUTO_PROVISION_DISABLED)
        process.env.NOVA_YOLO = '1'
        process.env.NOVA_SELF_SETUP_YOLO = '1'
        expect(await tool().handler({ capability: 'vision' } as any)).toBe(AUTO_PROVISION_DISABLED)
    })

    it('no longer ships the unverified ssh install path', async () => {
        const orchestrator = await import('../mesh/capability-orchestrator.js') as Record<string, unknown>
        expect(orchestrator.autoProvision).toBeUndefined()
        expect(orchestrator.findOrProvision).toBeUndefined()
        const source = readFileSync(new URL('../mesh/capability-orchestrator.ts', import.meta.url), 'utf8')
        expect(source).not.toContain('StrictHostKeyChecking=no')
    })
})
