import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('2.89.4 natural personal memory through the real entry', () => {
    it('persists a pet statement without a memory command and recalls it after restart', async () => {
        h = await createE2EHarness({ keepRoot: true })
        const root = h.root
        const first = await h.telegram('Mein Hund Bello ist ein kleiner brauner Mischling und trägt ein graues Halsband.', [
            call => {
                expect(call.tools).toContain('remember')
                expect(call.tools).toContain('knowledge_store')
                const system = call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
                expect(system).toContain('GEDÄCHTNISWEGE (REGISTRIERT)')
                return { text: 'Danke, dass du mir von deinem Hund erzählst.' }
            },
        ])
        expect(first.error).toBeUndefined()
        const governance = await h.module('memory/memory-governance.js')
        const before = governance.getMemoryGovernanceCoordinator().getContextForPrompt('user:700000001', 'Wie heißt mein Hund?')
        expect(before).toContain('Bello')
        expect(before).toContain('graues Halsband')
        await h.close(); h = undefined

        h = await createE2EHarness({ reuseRoot: root })
        const recalled = await h.telegram('Wie heißt mein Hund?', [call => {
            // The scripted model must derive its answer from persisted context,
            // never from the test's original statement or an old chat session.
            const system = call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
            expect(system).toContain('Bello')
            expect(system).toContain('graues Halsband')
            expect(system).toContain('VERIFIZIERT')
            const name = system.match(/Mein Hund ([\p{L}-]+) ist/u)?.[1]
            expect(name).toBeDefined()
            return { text: `Dein Hund heißt ${name}.` }
        }])
        expect(recalled.error).toBeUndefined()
        expect(recalled.final).toContain('Bello')
    }, 90_000)

    it('offers memory tools for a natural do-not-forget request', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Vergiss nicht: Mein Hund heißt Bello.', [call => {
            expect(call.tools).toContain('remember')
            expect(call.tools).toContain('knowledge_store')
            return { text: 'Ich prüfe meine Erinnerung dazu.' }
        }])
        expect(result.error).toBeUndefined()
    }, 90_000)
})
