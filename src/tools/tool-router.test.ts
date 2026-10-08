import { describe, expect, it } from 'vitest'
import { getRelevantTools, matchesSkillKeyword, loadSkillPack, loadSkillPackTool } from './tool-router.js'

describe('bounded capability recovery', () => {
    it.each([
        ['starte meine Test-VM', 'proxmox_vm'], ['mach einen Snapshot vor dem Update', 'proxmox_vm'],
        ['verbinde dich mit Jellyfin', 'dienst_finden'], ['melde dich mit meinem GitHub-Zugang an', 'anmelden_mit_zugang'],
    ])('2.88: offers the plain-word tool for „%s“', (request, tool) => {
        expect(getRelevantTools(request).some(item => item.name === tool)).toBe(true)
    })
    it.each(['Verfolge DHL 12345678', 'Prüfe 17TRACK AB123456789CD'])('exposes the dedicated parcel adapter for provider-only wording: %s', request => {
        expect(getRelevantTools(request).some(tool => tool.name === 'parcel_track')).toBe(true)
    })
    it('offers only source-bound captures for a collective node screenshot request', () => {
        const names = getRelevantTools('was können deine nodes? send mir einen screnn shot vbon jeden').map(t => t.name)
        expect(names).toContain('mesh_screenshot')
        expect(names).not.toContain('desktop_screenshot')
        expect(names).not.toContain('send_file')
        expect(names).not.toContain('ssh_command')
    })
    it('exposes actual computer-use tools for the requested capability', () => {
        const names=getRelevantTools('Kannst du computer use nutzen und mit der Maus klicken?').map(t=>t.name)
        expect(names).toContain('desktop_input')
        expect(names).toContain('desktop_screenshot')
        // 2.89.4: Handlungsaufträge brauchen Steuerwerkzeuge, nicht nur Aufnahmen.
        expect(names).toContain('desktop_control')
        expect(names).toContain('desktop_workspace')
    })
    it.each([
        'Sie hat Computer-Use … dann mach es auf und versuch es nochmal',
        'öffne die Seite auf deinem Arbeitsplatz',
        'öffnen den Browser auf deinem Desktop',
        'versuch es im Browser auf deinem Rechner',
        'tipp die Sendungsnummer ein und klick auf Suchen',
    ])('2.89.4: offers desktop_control (+ desktop_workspace) for the workstation action „%s“', request => {
        const names = getRelevantTools(request).map(tool => tool.name)
        expect(names).toContain('desktop_control')
        expect(names).toContain('desktop_workspace')
    })
    it('resolves the reviewed web alias without inventing a new pack', async () => {
        expect(loadSkillPack('web')).toMatchObject({ loaded: true, tools: expect.arrayContaining(['fetch_url']) })
        const loaded: any = await loadSkillPackTool.handler({ pack_name: 'web' })
        expect(loaded.pack).toBe('web-search')
        expect(loaded.output).toContain('web-search')
        expect(loaded.output).not.toContain('Rest der Session verfügbar')
    })
    it('does not guess unknown or instruction-bearing pack names', () => {
        for (const name of ['web; run_command', 'web-admin', '../web', 'weeb']) {
            expect(loadSkillPack(name)).toMatchObject({ loaded: false, tools: [] })
        }
    })
    it('routes an exact GET check to fetch instead of an unrelated search', () => {
        const request = "test es noch mal [24.09.2026 18:27] User: check mal url -sS --get 'https://search.example/search' --data-urlencode 'q=Agent' --data-urlencode 'format=json'"
        const names = getRelevantTools(request).map(tool => tool.name)
        expect(names).toContain('fetch_url')
        expect(names).not.toContain('searxng_search')
        expect(names).not.toContain('run_command')
    })
    it('does not narrow general research or mixed actions to a URL check', () => {
        expect(getRelevantTools('Recherchiere aktuelle Informationen zur Fotografie').some(t => t.name === 'searxng_search')).toBe(true)
        expect(getRelevantTools('Suche im Web nach Agent und prüfe https://example.test').some(t => t.name === 'searxng_search')).toBe(true)
        expect(getRelevantTools('Prüfe https://example.test und nutze health_status').some(t => t.name === 'health_status')).toBe(true)
    })
})

describe('smart tool router keyword matching', () => {
    it('matches explicit skill language', () => {
        expect(matchesSkillKeyword('erstell dir dafür einen skill', 'skill')).toBe(true)
    })

    it('does not match a keyword inside another word', () => {
        expect(matchesSkillKeyword('erstell dir dafür einen skill', 'kill')).toBe(false)
    })
})

describe('context-aware tool selection', () => {
    it('keeps an explicitly named registered tool in the bounded worker contract', () => {
        const tools = getRelevantTools('Nutze jetzt health_status und antworte mit dem verifizierten Ergebnis.')
        expect(tools.some(tool => tool.name === 'health_status')).toBe(true)
        expect(tools.length).toBeLessThanOrEqual(40)
    })

    it('does not route a registered tool from a larger identifier', () => {
        const tools = getRelevantTools('Der Text prehealth_statusx ist nur ein Bezeichner.')
        expect(tools.some(tool => tool.name === 'health_status')).toBe(false)
    })

    it('offers file tools for plural file requests even without exact pack keywords', () => {
        expect(getRelevantTools('Lies beide Dateien /tmp/a.txt und /tmp/b.txt').some(tool => tool.name === 'read_file')).toBe(true)
        expect(getRelevantTools('Read both files and add the totals').some(tool => tool.name === 'read_file')).toBe(true)
    })
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
        // 2.89: four core tools (load_skill_pack is a fallback now), then the current instruction
        expect(tools[4]?.name).toBe('codex_install')
        expect(tools.length).toBeLessThanOrEqual(40)
    })

    it('keeps a multi-domain worker contract bounded', () => {
        const tools = getRelevantTools('suche im web, prüfe docker logs, lies die datei und prüfe den systemstatus')
        expect(tools.length).toBeLessThanOrEqual(40)
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

describe('desktop route delivery boundary', () => {
    it('does not expose generic send_file on the desktop capture/computer-use routes', () => {
        for (const text of ['Schick mir einen Screenshot vom Desktop', 'computer use: klicke auf OK']) {
            const names = getRelevantTools(text).map(t => t.name)
            expect(names).toContain('desktop_screenshot')
            expect(names).not.toContain('send_file')
        }
    })
})
