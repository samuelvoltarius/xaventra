import { describe, expect, it } from 'vitest'
import { incompleteExecutionsResponse } from './tool-evidence-response.js'

// 2.87.1 (live 07.10.2026): after the turn budget ran out, the owner got four
// Telegram pages of skill-pack catalogue and tool self-description
// ("Kein Skill-Pack … Verfügbare Packs", "### Matches for …") as the "answer".

describe('incomplete turns never show tool catalogues to the user', () => {
    it('drops catalogue and introspection results and says plainly that it is not done', () => {
        const text = incompleteExecutionsResponse([
            { toolName: 'load_skill_pack', success: true, result: 'Kein Skill-Pack "home assistant" im Katalog. Verfügbare Packs:\n• files: Lokale Dateien verwalten' },
            { toolName: 'nova_introspect', success: true, result: 'Nova Self-Introspection — tools\n### Matches for "home assistant" (8)\n- hass_status' },
        ])
        expect(text).not.toContain('Skill-Pack')
        expect(text).not.toContain('Matches for')
        expect(text).not.toContain('Verfügbare Packs')
        expect(text.length).toBeLessThan(400)
    })

    it('real findings are still kept (Gegenprobe)', () => {
        const text = incompleteExecutionsResponse([
            { toolName: 'load_skill_pack', success: true, result: '✅ Skill-Pack "plugins" gefunden.' },
            { toolName: 'web_search', success: true, result: JSON.stringify({ results: [{ title: 'Finding', url: 'https://example.org/a', content: 'Fakt' }] }) },
        ])
        expect(text).toContain('https://example.org/a')
        expect(text).not.toContain('Skill-Pack')
    })
})
