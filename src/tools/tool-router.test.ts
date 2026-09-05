import { describe, expect, it } from 'vitest'
import { getRelevantTools, matchesSkillKeyword } from './tool-router.js'

describe('smart tool router keyword matching', () => {
    it('matches explicit skill language', () => {
        expect(matchesSkillKeyword('erstell dir dafür einen skill', 'skill')).toBe(true)
    })

    it('does not match a keyword inside another word', () => {
        expect(matchesSkillKeyword('erstell dir dafür einen skill', 'kill')).toBe(false)
    })
})

describe('context-aware tool selection', () => {
    it('keeps image generation available for a short subject follow-up', () => {
        const tools = getRelevantTools('kannst du ein bild generieren?\ndie stadt salzburg bitte')
        expect(tools.some(t => t.name === 'generate_image')).toBe(true)
        expect(tools.some(t => t.name === 'find_capability')).toBe(true)
    })

    it('includes self-learning recovery for typo-heavy image actions', () => {
        const tools = getRelevantTools('erstelll mir ein bild von salzburg')
        expect(tools.some(t => t.name === 'generate_image')).toBe(true)
        expect(tools.some(t => t.name === 'build_skill')).toBe(true)
    })

    it('keeps the skill builder focused', () => {
        const tools = getRelevantTools('bau dir einen skill und nutze den')
        expect(tools.some(t => t.name === 'build_skill')).toBe(true)
        expect(tools.length).toBeLessThan(15)
    })

    it('routes an explicit Codex installation request to the governed installer', () => {
        const tools = getRelevantTools('Okay, installiere Codex auf Spark')
        expect(tools.some(t => t.name === 'codex_install')).toBe(true)
    })

    it('does not let old conversation packs evict the current Codex installer', () => {
        const current = 'Installiere Codex auf dem aktuellen Main'
        const context = [
            'Wenn der Node ausfällt, wechselt das Mesh automatisch.',
            'Prüfe den Hook und den Event-Trigger.',
            current,
        ].join('\n')
        const tools = getRelevantTools(context, current)
        expect(tools.some(t => t.name === 'codex_install')).toBe(true)
        expect(tools[5]?.name).toBe('codex_install')
        expect(tools.length).toBeLessThanOrEqual(24)
    })

    it('keeps a multi-domain worker contract bounded', () => {
        const tools = getRelevantTools('suche im web, prüfe docker logs, lies die datei und prüfe den systemstatus')
        expect(tools.length).toBeLessThanOrEqual(24)
    })

    it('selects semantic code and continuable worker tools from natural language', () => {
        const codeTools = getRelevantTools('find references and TypeScript diagnostics for this symbol')
        expect(codeTools.some(t => t.name === 'lsp_query')).toBe(true)

        const workerTools = getRelevantTools('resume the interrupted subagent worker')
        expect(workerTools.some(t => t.name === 'continuable_subagent_followup')).toBe(true)
    })

    it('selects typed Nova Desktop controls from natural language', () => {
        const tools = getRelevantTools('Öffne in der Nova Desktop App die Nodes')
        expect(tools.some(t => t.name === 'desktop_control')).toBe(true)
        expect(tools.some(t => t.name === 'desktop_status')).toBe(true)
    })
})
