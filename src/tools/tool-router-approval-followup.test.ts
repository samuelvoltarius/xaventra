import { beforeAll, describe, expect, it } from 'vitest'
import { getToolRegistry } from './complete-registry.js'
import { getRelevantTools } from './tool-router.js'
import { issueSetupConfirmation, noteToolApprovalRequest, setupConfirmationPrincipal, toolsReferencedByApproval } from '../core/setup-confirmation.js'

// Abnahme 2.90.0 Langtest C (29.10. 17:12): after cluster_test_pod asked for the
// owner's approval, the owner's next message ("#99c5c5ff8a2f", later the code)
// got 5 tools without cluster_test_pod — its live route reads only the current
// sentence. A message that answers an open approval (the live one-time code, or
// the detail of a just-refused call) must offer exactly that tool again.

async function realRegistry() {
    const registry = getToolRegistry()
    for (let i = 0; i < 50 && !registry.get('load_skill_pack'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    return registry
}
const names = (text: string) => getRelevantTools(text, text).map(tool => tool.name)
beforeAll(async () => { await realRegistry() })

describe('Router: the answer to an approval keeps the tool', () => {
    it('the detail of a just-refused call alone offers that tool', () => {
        expect(names('#1a2b3c4d5e6f')).not.toContain('cluster_test_pod')
        noteToolApprovalRequest('tool:cluster_test_pod:#1a2b3c4d5e6f')
        expect(names('#1a2b3c4d5e6f')).toContain('cluster_test_pod')
        expect(names('ok, #1a2b3c4d5e6f passt')).toContain('cluster_test_pod')
        expect(names('#ffffffffffff')).not.toContain('cluster_test_pod')
    })

    it('a live one-time code offers the tool it is bound to — and only that one', () => {
        const token = issueSetupConfirmation(setupConfirmationPrincipal('telegram', '111'), 'tool:hass_turn_on:switch.example')
        const code = issueSetupConfirmation(setupConfirmationPrincipal('telegram', '111'), 'tool:cluster_test_pod:#0a0b0c0d0e0f')
        expect(names(`Freigabecode ${code}`)).toContain('cluster_test_pod')
        expect(toolsReferencedByApproval(`Freigabecode ${code}`)).toEqual(['cluster_test_pod'])
        expect(toolsReferencedByApproval(`Code ${token}`)).toEqual(['hass_turn_on'])
        expect(names('Freigabecode AAAAAAAAAAAAAAAAAAAAAAAA')).not.toContain('cluster_test_pod')
    })

    it('ordinary messages are not affected; short details never match by accident', () => {
        noteToolApprovalRequest('tool:printer_start:a')
        expect(toolsReferencedByApproval('Was ist das Wetter?')).toEqual([])
        expect(toolsReferencedByApproval('a')).toEqual([])
        expect(names('Wie geht es dir heute so?')).not.toContain('cluster_test_pod')
    })
})
