import { describe, expect, it } from 'vitest'
import { getRelevantTools } from './tool-router.js'

// 2.87.1 (live 07.10.2026): "homeassit sollte schon laufen" and "Ist Home
// Assistant verbunden?" got only the 5 core tools; the model then guessed skill
// pack names ("home assistant", "home-assistant") until the turn budget ran out
// and a raw tool catalogue landed in Telegram.

describe('smart-home questions get the Home Assistant tools', () => {
    it.each([
        'homeassit sollte schon laufen',
        'Ist Home Assistant verbunden?',
        'läuft homeassistant noch?',
        'mach das Licht im Wohnzimmer an',
        'welche Lampen sind an?',
    ])('%s', request => {
        const names = getRelevantTools(request).map(tool => tool.name)
        expect(names).toContain('hass_status')
        expect(names).toContain('hass_list')
    })

    it('unrelated requests do not pull the smart-home tools (Gegenprobe)', () => {
        const names = getRelevantTools('Schreib mir ein Gedicht über den Herbst').map(tool => tool.name)
        expect(names).not.toContain('hass_status')
    })
})
