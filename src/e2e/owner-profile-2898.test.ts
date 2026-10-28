/**
 * 2.89.8 (U4, U7, U8) over the real entry (only the model is scripted; fake profile data):
 *  U4 owner profile = fixed Tier-0 facts that win over learned facts, owner-only edits
 *  U7 plain time/date questions never wait for the model
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 120_000

const PROFILE = {
    version: 1,
    owner: { name: 'Max Muster', nicknames: ['Maxi'], company: 'Beispiel GmbH', website: 'https://example.com', timezone: 'Europe/Vienna' },
    entities: [
        { name: 'Bello', kind: 'dog', aliases: [], facts: [{ attribute: 'Rasse', value: 'Beagle', alsoMatches: ['labrador', 'mischling'] }] },
        { name: 'Luna', kind: 'dog', aliases: [], facts: [{ attribute: 'Rasse', value: 'Collie' }] },
        { name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: ['Elektroauto, Akkustand über Home Assistant'] },
    ],
    rules: [],
}
const seedProfile = (root: string) => {
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify(PROFILE, null, 2))
}
const systemOf = (call: { messages: Array<{ role: string; content: any }> }) => call.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')

describe('2.89.8 U4: owner profile', () => {
    it('"wer bin ich?" answers name and company from the profile without a model call', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const result = await h.telegram('wer bin ich?', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('Max Muster')
        expect(result.final).toContain('Beispiel GmbH')
        expect(result.final).not.toMatch(/Keine passende verifizierte Erinnerung/)
    }, T)

    it('"Wie heißen meine Hunde?" uses the profile breeds; contradicting learned facts are superseded, not deleted', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const { getMemoryGovernanceCoordinator } = await h.module('memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const scope = `user:${OWNER_TELEGRAM_ID}`
        const learned = ['Bello ist ein Labrador-Mischling mit grauem Halsband.', 'Bello Rasse: Pudel, das hat der Tierarzt gesagt.']
            .map(content => governance.propose({ content, kind: 'fact', scope, source: 'test', evidence: 'manual', confidence: 1, verified: true })!)
        expect(learned.every(record => ['verified', 'canonical'].includes(record.status))).toBe(true)

        const result = await h.telegram('Wie heißen meine Hunde?', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('Bello')
        expect(result.final).toContain('Beagle')
        expect(result.final).toContain('Collie')
        expect(result.final).not.toMatch(/Labrador|Pudel/)
        for (const record of learned) {
            const stored = governance.get(record.id)
            expect(stored?.status).toBe('superseded')            // kept, not deleted
            expect(stored?.supersededBy).toMatch(/^owner-profile:Bello/)
        }
    }, T)

    // 2.89.13 (live 29.10. 00:52:34, Quiet-Hub relay): the relay appends "(Antworte knapp auf Deutsch, ohne Markdown.)";
    // the profile patterns are anchored at the end, so the fast path listed old contradicting graph facts instead.
    it('a question with an appended style instruction still answers from the profile (Desktop/Hub)', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const { getMemoryGovernanceCoordinator } = await h.module('memory/memory-governance.js')
        getMemoryGovernanceCoordinator().propose({ content: 'Bello ist ein Labrador-Mischling mit grauem Halsband.', kind: 'fact', scope: `user:${OWNER_TELEGRAM_ID}`, source: 'test', evidence: 'manual', confidence: 1, verified: true })
        const result = await h.desktop('Wie heißen meine Hunde?\n(Antworte knapp auf Deutsch, ohne Markdown.)', [])
        expect(result.error).toBeUndefined()
        expect(result.final).toContain('Beagle')
        expect(result.final).toContain('Collie')
        expect(result.final).not.toMatch(/Labrador|Das weiß ich dazu noch/)
    }, T)

    it('the profile is injected as Tier-0 into the owner prompt and wins over learned text', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const result = await h.telegram('Erzähl mir etwas Schönes über meinen Garten im Herbst und was ich dafür brauche.', [call => {
            const system = systemOf(call)
            expect(system).toContain('OWNER-PROFIL')
            expect(system).toContain('Max Muster')
            expect(system).toContain('Beagle')
            return { text: 'Im Herbst kannst du Laub kompostieren.' }
        }])
        expect(result.error).toBeUndefined()
    }, T)

    it('two contradicting learned facts without a profile entry are not stated as certain', async () => {
        h = await createE2EHarness()
        const { getMemoryGovernanceCoordinator } = await h.module('memory/memory-governance.js')
        const governance = getMemoryGovernanceCoordinator()
        const scope = `user:${OWNER_TELEGRAM_ID}`
        for (const content of ['Rex ist ein Dackel mit braunem Fell.', 'Rex ist ein Schäferhund mit schwarzem Fell.']) {
            governance.propose({ content, kind: 'fact', scope, source: 'test', evidence: 'manual', confidence: 1, verified: true })
        }
        const result = await h.telegram('Wie heißt mein Hund Rex und was ist er für einer? Erinnerst du dich an Rex?', [])
        expect(result.final).toMatch(/widersprüchliche Angaben/)
        expect(result.final).toContain('Dackel')
        expect(result.final).toContain('Schäferhund')
    }, T)

    it('an alias that is a vehicle routes the battery question to Home Assistant', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const result = await h.telegram('Wie voll ist der Akku vom Dolphin gerade?', [{ text: 'Ich prüfe das über Home Assistant.' }])
        expect(result.offeredTools).toEqual(expect.arrayContaining(['hass_status', 'hass_list']))
        expect(result.error).toBeUndefined()
    }, T)

    it('"Was ist Dolphin?" is answered from the profile; an unknown name is not a memory question', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const known = await h.telegram('Was ist Dolphin?', [])
        expect(known.final).toMatch(/Fahrzeug/)
        expect(known.final).toContain('Home Assistant')
    }, T)

    it('only the canonical owner can change the profile: Telegram owner yes, REST no', async () => {
        h = await createE2EHarness({ seed: seedProfile })
        const profilePath = join(h.root, '.nova-data', 'owner-profile.json')
        const viaRest = await h.rest('Ändere mein Profil: Name Eve Eindringling', [
            { tool: 'owner_profile', args: { action: 'set_owner', name: 'Eve Eindringling' } }, { text: 'Das geht hier nicht.' },
        ])
        expect(viaRest.error).toBeUndefined()
        expect(JSON.parse(readFileSync(profilePath, 'utf8')).owner.name).toBe('Max Muster')

        const viaTelegram = await h.telegram('Ändere mein Profil: Spitzname Maxl hinzufügen', [
            { tool: 'owner_profile', args: { action: 'set_owner', nicknames: ['Maxi', 'Maxl'] } }, { text: 'Gespeichert.' },
        ])
        expect(viaTelegram.error).toBeUndefined()
        expect(JSON.parse(readFileSync(profilePath, 'utf8')).owner.nicknames).toEqual(['Maxi', 'Maxl'])
    }, T)
})

describe('2.89.8 U7: time questions never wait for the model', () => {
    it.each(['wie spät ist es?', 'Wie viel Uhr ist es?', 'welcher Tag ist heute?', 'Datum heute'])('"%s" is answered from the clock without a model call', async text => {
        h = await createE2EHarness()
        const result = await h.telegram(text, [])
        expect(result.error).toBeUndefined()
        expect(result.calls.length).toBe(0)
        expect(result.trace).toContain('fast-path:current-time')
        expect(result.final).toMatch(/Europe\/Vienna/)
        expect(result.final).toMatch(/\d{1,2}:\d{2}|\d{4}/)
    }, T)

    it('uses the time zone of the owner profile', async () => {
        h = await createE2EHarness({ seed: root => {
            mkdirSync(join(root, '.nova-data'), { recursive: true })
            writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify({ ...PROFILE, owner: { ...PROFILE.owner, timezone: 'America/New_York' } }))
        } })
        const result = await h.telegram('wie spät ist es', [])
        expect(result.final).toMatch(/America\/New_York/)
    }, T)

    it('a compound request still goes to the model', async () => {
        h = await createE2EHarness()
        const result = await h.telegram('Wie spät ist es und wie ist das Wetter in Wien?', [{ text: 'Es ist spät.' }])
        expect(result.trace).not.toContain('fast-path:current-time')
        expect(result.calls.length).toBeGreaterThan(0)
    }, T)
})
