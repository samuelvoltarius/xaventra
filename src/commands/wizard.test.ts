import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'

const fake = vi.hoisted(() => ({ answers: [] as string[], close: vi.fn() }))
vi.mock('node:readline', () => ({ createInterface: () => ({
    question: (_prompt: string, callback: (answer: string) => void) => callback(fake.answers.shift() || ''),
    close: fake.close,
}) }))
import { runSetupWizard } from './wizard.js'

beforeEach(() => { fake.close.mockClear(); fake.answers = [] })
describe('setup wizard configuration preservation', () => {
    it('keeps identity, mesh policy and existing channels when answers are blank', async () => {
        const config = { provider: 'local', model: 'qwen', mesh: { mode: 'ha', nodeId: 'example-node' },
            channels: { telegram: { enabled: true, allowedUsers: ['example-owner'] } } }
        writeFileSync('nova.config.json', JSON.stringify(config))
        await runSetupWizard()
        expect(JSON.parse(readFileSync('nova.config.json', 'utf8'))).toEqual(config)
        expect(fake.close).toHaveBeenCalledOnce()
    })
    it('does not write configuration for an unsupported provider', async () => {
        const original = JSON.stringify({ provider: 'local', model: 'qwen' })
        writeFileSync('nova.config.json', original)
        fake.answers = ['unsupported-provider']
        await expect(runSetupWizard()).rejects.toThrow('Unsupported provider')
        expect(readFileSync('nova.config.json', 'utf8')).toBe(original)
        expect(fake.close).toHaveBeenCalledOnce()
    })
})
