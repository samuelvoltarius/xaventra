/**
 * 2.92.2 (Abnahme 2.92.0): „welche knoten sind offline?“ bekam die Geräteliste statt der Knoten: der Satz lief in den
 * Inventur-Pfad (environment_inventory). Und bei der Akku-Frage 13:20:10 aktivierte der Router „mesh-network, web-search“
 * aus dem Verlauf, obwohl die Frage ihr eigenes Thema hat (Profil-Fahrzeug).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { isEnvironmentOverview, isNodeStatusQuestion } from '../core/request-capabilities.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('node status questions', () => {
    it.each(['welche knoten sind offline?', 'Welche Nodes sind online?', 'sind alle knoten erreichbar?'])('"%s" is a node status question, no inventory', text => {
        expect(isNodeStatusQuestion(text)).toBe(true)
        expect(isEnvironmentOverview(text)).toBe(false)
    })
    it.each(['Was läuft auf den Knoten?', 'welche Geräte sind im Netz?', 'Gib diese Aufgabe an ns1: uptime'])('"%s" stays what it was', text => {
        expect(isNodeStatusQuestion(text)).toBe(false)
    })
    it('starts with mesh_status over the real entry, not the device inventory', async () => {
        h = await createE2EHarness({})
        const result = await h.telegram('welche knoten sind offline?', [{ text: 'Alle Knoten sind online.' }])
        expect(result.error).toBeUndefined()
        expect(result.executedTools[0]).toBe('mesh_status')
        expect(result.executedTools).not.toContain('environment_inventory')
    }, 120_000)
})

describe('a question with its own topic loads no packs from the history', () => {
    it('the profile vehicle question offers no mesh or web pack tools after a mesh turn', async () => {
        h = await createE2EHarness({ seed: root => {
            mkdirSync(join(root, '.nova-data'), { recursive: true })
            writeFileSync(join(root, '.nova-data', 'owner-profile.json'), JSON.stringify({ version: 1, owner: { name: 'Max Muster' },
                entities: [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'], facts: [] }], rules: [] }))
        } })
        await h.telegram('Such im Web nach Mesh-Netzwerk Knoten Status auf ns1 und zeig mir den mesh status', [{ text: 'Ok.' }])
        const result = await h.telegram('Wie viel Akku hat der Dolphin?', [{ text: 'Das weiß ich nicht.' }])
        expect(result.offeredTools).toContain('hass_list')
        expect(result.offeredTools.filter(name => /^mesh_|web_search|browser_search/.test(name))).toEqual([])
    }, 120_000)
})
