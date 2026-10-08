import { describe, it, expect } from 'vitest'
import { homeAssistantStatusPlan } from './home-assistant-status-plan.js'

const base = { permission: 'owner', internal: false, hasImage: false, constrained: false, tools: [{ name: 'hass_status' }, { name: 'run_command' }] }

describe('homeAssistantStatusPlan', () => {
    it.each(['homeassit sollte schon laufen', 'Läuft Home Assistant?', 'ist homeassistant erreichbar', 'hass status'])('%s startet mit hass_status', content => {
        expect(homeAssistantStatusPlan({ ...base, content })).toEqual([{ name: 'hass_status', arguments: {} }])
    })
    it.each(['Schalte das Licht im Wohnzimmer an', 'Starte Home Assistant neu', 'Schreib ein Gedicht', 'Home Assistant einrichten'])('%s nicht', content => {
        expect(homeAssistantStatusPlan({ ...base, content })).toBeNull()
    })
    it('nur für den Besitzer und nur mit dem Werkzeug', () => {
        expect(homeAssistantStatusPlan({ ...base, content: 'läuft homeassistant', permission: 'guest' })).toBeNull()
        expect(homeAssistantStatusPlan({ ...base, content: 'läuft homeassistant', tools: [{ name: 'run_command' }] })).toBeNull()
    })
})
