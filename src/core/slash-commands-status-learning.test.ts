import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MemoryGovernanceCoordinator, setMemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { _setDecisionMainCheckForTest, observeOwnerMessage } from './decisions.js'

// /status und /gelernt zählen Korrekturen aus der Memory-Governance und
// Regeln aus den Entscheidungen — nicht mehr aus L7-corrections.json und
// L20-self-rules.json.
const runtime = mkdtempSync(join(process.cwd(), '.nova-test-tmp', 'status-learning-'))
const previousRoot = process.env.NOVA_RUNTIME_ROOT
process.env.NOVA_RUNTIME_ROOT = runtime
const governance = new MemoryGovernanceCoordinator(join(runtime, 'governance'))
setMemoryGovernanceCoordinator(governance)
_setDecisionMainCheckForTest(() => true)
afterAll(() => { _setDecisionMainCheckForTest(null); process.env.NOVA_RUNTIME_ROOT = previousRoot })

const { recordUserCorrectionMemory } = await import('../memory/correction-memory.js')
const { handleCommand } = await import('./slash-commands.js')
const state: any = {
    running: true, channels: { telegram: null, whatsapp: null, discord: null }, llm: null, internalLlm: null, memory: null,
    learning: null, tools: null, resilience: null, startTime: Date.now(), config: {},
}
const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }

describe('/status zählt aus den neuen Quellen', () => {
    it('Korrekturen aus der Governance, Regeln aus den Entscheidungen', async () => {
        await recordUserCorrectionMemory({ scope: 'user:owner-1', message: 'Nein, nicht Prusa — sondern Voron 2.4' })
        observeOwnerMessage({ text: 'Ab jetzt Druckaufträge nie ohne Knopf starten.', permission: 'owner', principalId: 'owner-1', channel: 'cli' })
        const text = String(await handleCommand('status', '', 'owner-1', state, [], owner))
        expect(text).toContain('Korrekturen: 1')
        expect(text).toMatch(/Entscheidungen: 1 gültig/)
        expect(text).not.toContain('Self-Rules')
        const learned = String(await handleCommand('gelernt', '', 'owner-1', state, [], owner))
        expect(learned).toContain('Korrekturen')
        expect(learned).not.toContain('L7 Korrekturen')
    })
})
