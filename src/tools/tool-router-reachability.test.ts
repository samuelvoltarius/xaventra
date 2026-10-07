import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ALL_TOOLS, getToolRegistry } from './complete-registry.js'
import { getRelevantTools, loadSkillPackTool, matchesSkillKeyword, routedToolNames, toolExpansionPolicy, toolRoute } from './tool-router.js'

// 2.89 „Jedes Werkzeug erreichbar“: live the router ran in filtered mode and 44
// registered tools (hass_service, send_telegram_message, spawn_subagent(s_parallel),
// start_mission, printers/CAD, camera, self_doctor, read_document …) never reached
// the model. These tests use the REAL registry.

async function realRegistry() {
    const registry = getToolRegistry()
    // load_skill_pack registers itself asynchronously (ESM cycle).
    for (let i = 0; i < 50 && !registry.get('load_skill_pack'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    return registry
}
const names = (text: string, primary?: string) => getRelevantTools(text, primary).map(tool => tool.name)

beforeAll(async () => { await realRegistry() })

describe('invariant: every registered tool has a way to the model', () => {
    it('each built-in tool is in core, a pack or a live route', async () => {
        const registry = await realRegistry()
        const all = registry.getAll().map(tool => tool.name)
        expect(all.length).toBeGreaterThan(200)
        expect(all).toContain('load_skill_pack')
        expect(all.filter(name => !toolRoute(name))).toEqual([])
        expect(all.filter(name => toolRoute(name) === 'dynamic' && !/^(mcp__|forge_)/.test(name))).toEqual([])
    })
    it('load_skill_pack is no core tool: offered only when nothing matched', () => {
        expect(toolRoute('load_skill_pack')).toBe('fallback')
        expect(names('Stell die Heizung auf 21 Grad')).not.toContain('load_skill_pack')
        expect(names('Wie geht es dir heute so?')).toContain('load_skill_pack')
    })
    it('Gegenprobe: a newly registered built-in without a way is caught', () => {
        expect(toolRoute('brand_new_tool_without_pack')).toBeNull()
    })
    it('the router names no tool that is not registered (no dead names)', async () => {
        const registered = new Set((await realRegistry()).getAll().map(tool => tool.name))
        expect(routedToolNames().filter(name => !registered.has(name))).toEqual([])
    })
    it('tool names in ALL_TOOLS are unique (fetch_url, send_file, list_skills, browser_* once)', () => {
        const seen = new Map<string, number>()
        for (const tool of ALL_TOOLS) seen.set(tool.name, (seen.get(tool.name) || 0) + 1)
        expect([...seen].filter(([, count]) => count > 1)).toEqual([])
    })
})

describe('everyday German requests reach the right tool (real registry)', () => {
    it.each([
        ['Stell die Heizung auf 21 Grad', 'hass_service'],
        ['Mach die Deckenlampe im Wohnzimmer an', 'hass_turn_on'],
        ['Ist das Wohnzimmerlicht noch an?', 'hass_get'],
        ['Mach den Rollo im Schlafzimmer runter', 'hass_service'],
        ['Aktiviere die Szene Kino', 'hass_service'],
        ['Wie ist die Temperatur am Thermostat?', 'hass_get'],
        ['Erinnere mich in 10 Minuten an den Tee', 'set_reminder'],
        ['Druck den Würfel', 'printer_print'],
        ['Mach mir ein CAD-Modell für einen Haken und druck es auf dem 3D-Drucker', 'cad_generate'],
        ['lern das: ich trinke Kaffee schwarz', 'remember'],
        ['Was machen meine Projekte?', 'projekte_status'],
        ['schick mir das per Telegram', 'send_telegram_message'],
        ['starte drei Helfer parallel', 'spawn_subagents_parallel'],
        ['Brich den Helfer ab', 'subagent_interrupt'],
        ['Was siehst du auf der Kamera?', 'webcam_capture'],
        ['Lies das PDF von der Rechnung', 'read_document'],
        ['Starte eine Mission für die Steuererklärung', 'start_mission'],
        ['Prüf dich selbst, was ist kaputt?', 'self_doctor'],
        ['Suche im Internet nach dem Wetter in Salzburg', 'web_search'],
        ['Richte die Spracheingabe ein', 'voice_setup'],
        // 2.89 live (07.10.): typing errors of „verbinden“ still reach the connect tools.
        ['paperless kannst du dich mit dem verbinen ?', 'dienst_verbinden'],
        ['kannst du dich mit paperless verbiden', 'dienst_finden'],
        ['koppel dich mit dem NAS', 'dienst_verbinden'],
    ])('„%s“ → %s', (request, tool) => {
        expect(names(request)).toContain(tool)
    })

    it('Gegenprobe: „verbieten“ is no connect request', () => {
        expect(names('Ich verbiete dir das Licht anzumachen')).not.toContain('dienst_verbinden')
    })

    it('stems and compounds match, whole words stay whole (Gegenprobe)', () => {
        expect(matchesSkillKeyword('Erinnere mich morgen', 'erinner*')).toBe(true)
        expect(matchesSkillKeyword('Suche das Rezept', 'such*')).toBe(true)
        expect(matchesSkillKeyword('Besuch bei Oma', 'such*')).toBe(false)
        expect(matchesSkillKeyword('die Deckenlampe', '*lampe')).toBe(true)
        expect(matchesSkillKeyword('erstell dir dafür einen skill', 'kill')).toBe(false)
        expect(names('Das ist meine Pflicht')).not.toContain('hass_status')
        expect(names('Schreib mir ein Gedicht über den Herbst')).not.toContain('hass_status')
    })

    it('filler words (wenn, morgen, richtig, falsch, aufgabe, update, version, link, aktuell, bild) no longer pull packs', () => {
        const filler = names('Wenn das morgen richtig oder falsch ist: welche Aufgabe, welches Update, die Version, welcher Link, aktuell, Bild?')
        for (const tool of ['create_hook', 'set_reminder', 'learn_correction', 'mission_config', 'pull_update', 'transcribe_audio']) expect(filler).not.toContain(tool)
    })

    it('filler words do not displace the relevant pack', () => {
        expect(names('Erinnere mich morgen, wenn das Update richtig läuft, an die Aufgabe')).toContain('set_reminder')
    })

    it('the relevant pack never falls off the cap, even in a crowded request with old context', () => {
        const context = ['Prüfe den Hook und den Event-Trigger.', 'Suche im Web nach Docker-Logs und lies die Datei.', 'Stell die Heizung auf 21 Grad'].join('\n')
        const tools = names(context, 'Stell die Heizung auf 21 Grad')
        expect(tools).toContain('hass_service')
        expect(tools.length).toBeLessThanOrEqual(40)
        const crowded = names('Heizung auf 21 Grad, such im Web, lies die Datei, prüfe docker logs, den systemstatus und starte zwei Helfer parallel')
        expect(crowded).toEqual(expect.arrayContaining(['hass_service', 'spawn_subagents_parallel']))
        expect(crowded.length).toBeLessThanOrEqual(40)
    })
})

describe('dynamic tools: forge and plugin tools are reached by their words', () => {
    const added: string[] = []
    afterEach(() => { const registry = getToolRegistry(); for (const name of added.splice(0)) registry.unregister(name) })
    it('a forge tool and a plugin tool join when their words appear', async () => {
        const registry = await realRegistry()
        for (const [name, description] of [['forge_pegel_salzach', '[Schmiede] Liest den Pegelstand der Salzach'], ['wetterstation_lesen', 'Liest die Gartenwetterstation (Plugin)']]) {
            registry.register({ name, description, category: 'other', parameters: [], handler: async () => ({ success: true }) } as any)
            added.push(name)
        }
        expect(names('Wie hoch ist der Pegelstand der Salzach?')).toContain('forge_pegel_salzach')
        expect(names('Was sagt die Gartenwetterstation?')).toContain('wetterstation_lesen')
        expect(names('Schreib mir ein Gedicht über den Herbst')).not.toContain('forge_pegel_salzach')
    })
})

describe('load_skill_pack loads for the running request', () => {
    it('returns the pack tools with a „geladen“ answer', async () => {
        const result: any = await loadSkillPackTool.handler({ pack_name: 'drucker' })
        expect(result.found).toBe(true)
        expect(result.pack).toBe('printer')
        expect(result.tools).toEqual(expect.arrayContaining(['printer_print', 'cad_generate']))
        expect(result.output).toContain('geladen')
    })
    it('node screenshots and direct URL checks stay sealed; a desktop capture never gains send_file', () => {
        expect(toolExpansionPolicy('send mir einen Screenshot von allen nodes').sealed).toBe(true)
        expect(toolExpansionPolicy('https://example.com').sealed).toBe(true)
        const capture = toolExpansionPolicy('Schick mir einen Screenshot vom Desktop')
        expect(capture.sealed).toBe(false)
        expect(capture.excluded.has('send_file')).toBe(true)
        expect(toolExpansionPolicy('Stell die Heizung auf 21 Grad')).toMatchObject({ sealed: false })
    })
})
