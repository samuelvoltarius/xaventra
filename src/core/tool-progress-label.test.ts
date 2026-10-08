import { describe, it, expect } from 'vitest'
import { toolProgressLabel } from './tool-progress-label.js'

describe('toolProgressLabel (Websuche)', () => {
    it.each(['web_search', 'searxng_search', 'browser_search', 'google_search', 'brave_search', 'tavily_search', 'mcp__x__tavily_search', 'news_search'])(
        '%s zeigt "suche im Web"', (name) => {
            expect(toolProgressLabel(name)).toBe('suche im Web …')
        })
    it('Gedächtnis- und Codesuche bleiben bei ihren Labels', () => {
        expect(toolProgressLabel('kg_search')).toBe('schaue in mein Gedächtnis …')
        expect(toolProgressLabel('code_search')).toBe('lese Dateien …')
    })
    it('unbekanntes Werkzeug bleibt neutral', () => {
        expect(toolProgressLabel('xyz_tool')).toBe('führe einen Arbeitsschritt aus …')
    })
})
