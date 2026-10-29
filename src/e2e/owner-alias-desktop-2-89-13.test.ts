/**
 * 2.89.13 (live 29.10.2026, Quiet-Hub relay over the Desktop API): the owner arrives as `desktop:<id>`; the
 * account is linked to the one owner principal (owner-accounts.json), but the memory scopes still used the raw
 * channel id for the config alias (`userAliases[from]`). Telegram (`<id>` → alias `max`) saw `user:max`,
 * the Desktop/Hub path did not — "Wie heißen meine Hunde?" knew nothing there.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000
const systemOf = (call: { messages: Array<{ role: string; content: any }> }) =>
    call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')

async function seedLegacyAliasMemory(e2e: E2EHarness) {
    const governance = (await e2e.module('memory/memory-governance.js')).getMemoryGovernanceCoordinator()
    const record = governance.propose({ content: 'Rex ist ein Beagle und der Hund von Max.', kind: 'fact', scope: 'user:max', source: 'test', evidence: 'explicit_user_instruction', confidence: 1 })
    expect(record).toBeTruthy()
    await governance.publish(record.id)
}

describe('2.89.13 owner alias on every linked owner channel', () => {
    it('the Desktop owner sees memories kept under the configured owner alias', async () => {
        h = await createE2EHarness({ config: { userAliases: { [OWNER_TELEGRAM_ID]: 'max' } } })
        await seedLegacyAliasMemory(h)
        const onTelegram = await h.telegram('Wie heißt mein Hund Rex genau, welche Rasse?', [call => {
            expect(systemOf(call)).toContain('Beagle')
            return { text: 'Rex ist ein Beagle.' }
        }])
        expect(onTelegram.error).toBeUndefined()
        const onDesktop = await h.desktop('Welche Rasse hat mein Hund Rex?', [call => {
            expect(systemOf(call)).toContain('Beagle')
            return { text: 'Rex ist ein Beagle.' }
        }])
        expect(onDesktop.error).toBeUndefined()
    }, T)

    it('a REST/probe principal still does not see the owner alias memory', async () => {
        h = await createE2EHarness({ config: { userAliases: { [OWNER_TELEGRAM_ID]: 'max' } } })
        await seedLegacyAliasMemory(h)
        const probe = await h.rest('Welche Rasse hat mein Hund Rex?', [call => {
            expect(systemOf(call)).not.toContain('Beagle')
            return { text: 'Das weiß ich nicht.' }
        }], { probe: true })
        expect(probe.error).toBeUndefined()
    }, T)
})
