import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    buildRoutineSkillPrompt, classifySkillStep, cleanSkillParams, finishRoutineSkillRun, HOME_ASSISTANT_SKILL_ID,
    HOME_ASSISTANT_WRITE_TOOLS, routineSkillHint, RoutineSkillStore, topicTokens, type ObserveInput, type RoutineSkillEvent,
} from './routine-skills.js'

let dir: string
let t: number
let events: RoutineSkillEvent[]
const DAY = Date.parse('2026-10-01T08:00:00.000Z')
const HOUR = 60 * 60_000
const OWNER = 'owner-alfred'

const store = (options: { repeatThreshold?: number } = {}) => new RoutineSkillStore({ dir, now: () => t, notify: event => events.push(event), ...options })

let runCounter = 0
function run(request: string, steps: ObserveInput['steps'], extra: Partial<ObserveInput> = {}): ObserveInput {
    runCounter++
    return { runId: `run-${runCounter}`, principalId: OWNER, permission: 'owner', request, intentKind: 'lookup', steps, success: true, ...extra }
}
const weather = [{ toolName: 'weather_get', params: { location: 'Salzburg', userId: 'x', requestText: 'egal' }, success: true }]

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'routine-skills-'))
    t = DAY
    events = []
    runCounter = 0
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Wiederholung erkennen', () => {
    it('legt beim 3. Mal gleicher Absicht selbst einen Skill an, beim 2. Mal nicht', () => {
        const s = store()
        expect(s.observe(run('Wie ist das Wetter in Salzburg?', weather))).toMatchObject({ counted: true, count: 1 })
        t += HOUR
        const second = s.observe(run('Wie ist das Wetter in Salzburg?', weather))
        expect(second).toMatchObject({ counted: true, count: 2 })
        expect((second as any).created).toBeUndefined()
        expect(s.list().filter(skill => skill.origin === 'gelernt')).toHaveLength(0)
        t += HOUR
        const third = s.observe(run('Wie ist das Wetter in Salzburg?', weather)) as any
        expect(third.count).toBe(3)
        expect(third.created).toBeTruthy()
        const learned = s.list().filter(skill => skill.origin === 'gelernt')
        expect(learned).toHaveLength(1)
        const skill = learned[0]
        expect(skill.enabled).toBe(true)
        expect(skill.steps).toEqual([expect.objectContaining({ tool: 'weather_get', params: { location: 'Salzburg' }, level: 'L0', fragt: false })])
        expect(skill.evidence.map(item => item.runId)).toEqual(['run-1', 'run-2', 'run-3'])
        expect(skill.trigger).toContain('Wetter')
        expect(skill.check).toContain('Validator')
        expect(readdirSync(join(dir, 'routine'))).toContain(`${skill.id}.json`)
        // Gedanke "Neuer Skill" (Abendbericht), keine Karte.
        expect(events).toEqual([expect.objectContaining({ kind: 'neu' })])
        // Ein weiterer gleicher Lauf legt keinen zweiten Skill an.
        t += HOUR
        expect((s.observe(run('Wetter Salzburg', weather)) as any).created).toBeUndefined()
        expect(s.list().filter(item => item.origin === 'gelernt')).toHaveLength(1)
    })

    it('zählt eine andere Formulierung derselben Absicht mit', () => {
        const s = store()
        s.observe(run('Wie ist das Wetter in Salzburg?', weather))
        s.observe(run('Sag mir kurz, ob es in Salzburg regnet', weather))
        const third = s.observe(run('Brauch ich heute in Salzburg einen Schirm?', weather)) as any
        expect(third.count).toBe(3)
        expect(third.created?.keywords).toContain('salzburg')
    })

    it('zählt gleichen Wortlaut mit anderer Werkzeugfolge nicht als gleiche Absicht', () => {
        const s = store()
        s.observe(run('Wetter Salzburg', weather))
        s.observe(run('Wetter Salzburg', [{ toolName: 'web_search', params: { query: 'Wetter Salzburg' } }]))
        const third = s.observe(run('Wetter Salzburg', [{ toolName: 'read_file', params: { path: 'wetter.txt' } }])) as any
        expect(third.count).toBe(1)
        expect(third.created).toBeUndefined()
    })

    it('lernt nicht von Nicht-Ownern, Gruppen, System-Nachrichten oder Fehlschlägen', () => {
        const s = store()
        for (let i = 0; i < 3; i++) {
            expect(s.observe(run('Wetter Salzburg', weather, { permission: 'user', principalId: 'fremder' }))).toMatchObject({ counted: false })
            expect(s.observe(run('Wetter Salzburg', weather, { isGroup: true }))).toMatchObject({ counted: false })
            expect(s.observe(run('Wetter Salzburg', weather, { systemAuthored: true }))).toMatchObject({ counted: false })
            expect(s.observe(run('Wetter Salzburg', weather, { success: false }))).toMatchObject({ counted: false })
        }
        expect(s.list().filter(item => item.origin === 'gelernt')).toHaveLength(0)
        // Fremde Läufe zählen auch nicht für den Owner mit.
        expect(s.observe(run('Wetter Salzburg', weather))).toMatchObject({ counted: true, count: 1 })
    })

    it('zählt Läufe außerhalb des Fensters (7 Tage) nicht', () => {
        const s = store()
        s.observe(run('Wetter Salzburg', weather))
        t += 8 * 24 * HOUR
        s.observe(run('Wetter Salzburg', weather))
        expect(s.observe(run('Wetter Salzburg', weather))).toMatchObject({ count: 2 })
    })

    it('die Schwelle ist konfigurierbar', () => {
        const s = store({ repeatThreshold: 2 })
        s.observe(run('Wetter Salzburg', weather))
        expect((s.observe(run('Wetter Salzburg', weather)) as any).created).toBeTruthy()
    })

    it('Nie-Liste-Werkzeuge kommen nie in einen Skill', () => {
        const s = store()
        const steps = [{ toolName: 'read_file', params: { path: 'notizen.txt' } }, { toolName: 'delete_file', params: { path: 'notizen.txt' } }]
        for (let i = 0; i < 4; i++) expect(s.observe(run('räum die Notizen auf', steps))).toMatchObject({ counted: false })
        expect(s.list().filter(item => item.origin === 'gelernt')).toHaveLength(0)
        expect(classifySkillStep('ssh_exec').nie).toBe(true)
        expect(classifySkillStep('get_secret').nie).toBe(true)
    })
})

describe('Skill nutzen', () => {
    function learnWeather(s: RoutineSkillStore) {
        for (const text of ['Wie ist das Wetter in Salzburg?', 'Wetter Salzburg bitte', 'Regnet es in Salzburg?']) s.observe(run(text, weather))
        return s.list().find(item => item.origin === 'gelernt')!
    }

    it('lädt den Skill bei passender Owner-Anfrage zuerst in den Prompt', () => {
        const s = store()
        const skill = learnWeather(s)
        const hint = routineSkillHint(s, { principalId: OWNER, permission: 'owner', request: 'Und wie wird das Wetter in Salzburg morgen?' })
        expect(hint?.skillId).toBe(skill.id)
        expect(hint?.prompt).toContain('Gespeicherter Skill')
        expect(hint?.prompt).toContain('weather_get {"location":"Salzburg"}')
        expect(hint?.prompt).toContain('Nutze zuerst diese Schritte')
        expect(s.get(skill.id)?.uses).toBe(1)
        // Gegenprobe: unpassende Anfrage, Gast, Gruppe.
        expect(routineSkillHint(s, { principalId: OWNER, permission: 'owner', request: 'Schreib ein Gedicht über Katzen' })).toBeNull()
        expect(routineSkillHint(s, { principalId: OWNER, permission: 'guest', request: 'Wetter Salzburg' })).toBeNull()
        expect(routineSkillHint(s, { principalId: OWNER, permission: 'owner', isGroup: true, request: 'Wetter Salzburg' })).toBeNull()
    })

    it('zählt Erfolg und deaktiviert nach 2 Fehlschlägen in Folge (mit Gedanke)', () => {
        const s = store()
        const skill = learnWeather(s)
        events = []
        const base = { principalId: OWNER, permission: 'owner', request: 'Wetter Salzburg', steps: weather, appliedSkillId: skill.id }
        finishRoutineSkillRun(s, { ...base, runId: 'ok-1', success: true })
        finishRoutineSkillRun(s, { ...base, runId: 'bad-1', success: false })
        expect(s.get(skill.id)).toMatchObject({ enabled: true, successes: 1, failures: 1, consecutiveFailures: 1 })
        // Warten auf Freigabe ist kein Fehlschlag.
        finishRoutineSkillRun(s, { ...base, runId: 'wait-1', success: false, awaitingApproval: true })
        expect(s.get(skill.id)?.failures).toBe(1)
        finishRoutineSkillRun(s, { ...base, runId: 'bad-2', success: false })
        expect(s.get(skill.id)).toMatchObject({ enabled: false, disabledBy: 'automatik', consecutiveFailures: 2 })
        expect(events).toEqual([expect.objectContaining({ kind: 'deaktiviert' })])
        // Deaktivierter Skill wird nicht mehr geladen.
        expect(routineSkillHint(s, { principalId: OWNER, permission: 'owner', request: 'Wetter Salzburg' })).toBeNull()
    })

    it('ein Erfolg setzt die Fehlerserie zurück', () => {
        const s = store()
        const skill = learnWeather(s)
        s.recordOutcome(skill.id, false)
        s.recordOutcome(skill.id, true)
        s.recordOutcome(skill.id, false)
        expect(s.get(skill.id)?.enabled).toBe(true)
    })

    it('ist abschaltbar und wird vom Owner Abgeschaltetes nie automatisch neu gelernt', () => {
        const s = store()
        const skill = learnWeather(s)
        expect(s.setEnabled(skill.id, false)?.disabledBy).toBe('owner')
        for (let i = 0; i < 4; i++) { t += HOUR; s.observe(run('Wetter Salzburg', weather)) }
        expect(s.get(skill.id)?.enabled).toBe(false)
        expect(s.list().filter(item => item.origin === 'gelernt')).toHaveLength(1)
    })

    it('lernt einen automatisch deaktivierten Skill nach neuen Belegen als neue Version', () => {
        const s = store()
        const skill = learnWeather(s)
        s.recordOutcome(skill.id, false)
        s.recordOutcome(skill.id, false)
        for (let i = 0; i < 3; i++) { t += HOUR; s.observe(run('Wetter Salzburg', weather)) }
        expect(s.get(skill.id)).toMatchObject({ enabled: true, version: 2 })
        expect(s.get(skill.id)?.history).toHaveLength(1)
    })
})

describe('Grenzen', () => {
    it('ein Skill mit physischem Schritt fragt weiter (Karte)', () => {
        const s = store()
        const steps = [{ toolName: 'hass_turn_on', params: { entity_id: 'light.wohnzimmer' } }]
        for (const text of ['Schalte das Licht im Wohnzimmer ein', 'Licht Wohnzimmer an', 'Mach im Wohnzimmer Licht']) s.observe(run(text, steps, { intentKind: 'action' }))
        const skill = s.list().find(item => item.origin === 'gelernt')!
        expect(skill.readOnly).toBe(false)
        expect(skill.steps[0]).toMatchObject({ tool: 'hass_turn_on', level: 'L2', fragt: true })
        expect(skill.steps[0].hinweis).toContain('fragt weiter')
        const prompt = buildRoutineSkillPrompt(skill)
        expect(prompt).toContain('erlaubt nichts zusätzlich')
        expect(prompt).toContain('wirkt physisch → fragt weiter (Karte)')
        // Nach außen wirkend ebenso.
        expect(classifySkillStep('send_email')).toMatchObject({ level: 'L2', fragt: true })
        expect(classifySkillStep('purchase_item')).toMatchObject({ fragt: true })
    })

    it('speichert keine Secrets im Skill', () => {
        const s = store()
        const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'
        const steps = [{
            toolName: 'http_get',
            params: { url: 'https://example.com/status', token: 'geheim123', api_key: secret, header: `Bearer ${secret}`, note: 'x'.repeat(40) },
        }]
        for (let i = 0; i < 3; i++) s.observe(run(`Prüf example.com Status mit Token ${secret}`, steps))
        const skill = s.list().find(item => item.origin === 'gelernt')!
        expect(skill.steps[0].params).toEqual({ url: 'https://example.com/status' })
        const onDisk = readFileSync(join(dir, 'routine', `${skill.id}.json`), 'utf8') + readFileSync(join(dir, 'routine-observations.json'), 'utf8')
        expect(onDisk).not.toContain('geheim123')
        expect(onDisk).not.toContain(secret)
        expect(onDisk).not.toContain('abcdefghijklmnopqrstuvwxyz')
        expect(cleanSkillParams({ password: 'x', userId: 'u', requestText: 'r', ok: 'ja' })).toEqual({ ok: 'ja' })
        // Secret-Namen, die redactSecrets allein nicht erkennt, fallen trotzdem weg.
        expect(cleanSkillParams({ cookie: 'chocolate42', session_id: 'abc123', auth: 'x1', room: 'kueche' })).toEqual({ room: 'kueche' })
    })
})

describe('Eingebauter Home-Assistant-Skill', () => {
    it('ist vorhanden, rein lesend und wird bei „guck mal bei Home Assistant“ geladen', () => {
        const s = store()
        const ha = s.get(HOME_ASSISTANT_SKILL_ID)!
        expect(ha.origin).toBe('eingebaut')
        expect(ha.readOnly).toBe(true)
        expect(ha.steps.every(step => step.level === 'L0' && !step.fragt)).toBe(true)
        expect(ha.steps.map(step => step.tool)).toEqual(['hass_status', 'hass_list'])
        for (const step of ha.steps) expect(HOME_ASSISTANT_WRITE_TOOLS).not.toContain(step.tool)
        for (const step of ha.steps) expect(classifySkillStep(step.tool).level).toBe('L0')
        const text = (ha.anleitung || []).join(' ')
        expect(text).toContain('HASS_URL')
        expect(text).toContain('Nie raten')
        expect(text).toContain('Freigabe-Karte')
        for (const request of ['guck mal bei Home Assistant', 'Wie schaut es im HA aus?', 'hass status', 'was ist los im Smart Home']) {
            expect(routineSkillHint(s, { principalId: OWNER, permission: 'owner', request })?.skillId).toBe(HOME_ASSISTANT_SKILL_ID)
        }
        expect(topicTokens('HA-Status')).toEqual(['homeassistant'])
    })

    it('HA-Lesen erzeugt keinen doppelten gelernten Skill', () => {
        const s = store()
        const steps = [{ toolName: 'hass_status' }, { toolName: 'hass_list' }]
        for (let i = 0; i < 4; i++) s.observe(run('guck mal bei Home Assistant', steps))
        expect(s.list().map(item => item.id)).toEqual([HOME_ASSISTANT_SKILL_ID])
    })

    it('kann abgeschaltet werden, die Definition bleibt aus dem Code', () => {
        const s = store()
        s.setEnabled(HOME_ASSISTANT_SKILL_ID, false)
        expect(routineSkillHint(s, { principalId: OWNER, permission: 'owner', request: 'guck mal bei Home Assistant' })).toBeNull()
        const raw = JSON.parse(readFileSync(join(dir, 'routine', `${HOME_ASSISTANT_SKILL_ID}.json`), 'utf8'))
        expect(raw.steps).toBeUndefined()
        expect(store().get(HOME_ASSISTANT_SKILL_ID)?.steps).toHaveLength(2)
    })
})
