import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Der Wissensgraph wird nur über die Memory-Governance befüllt: Quellen
// liefern Subjekt/Beziehung/Wert, die Governance prüft (keine Secrets,
// höchstens 50 Zeichen) und projiziert nur kanonische Einträge.
vi.mock('./lancedb-memory.js', () => ({ remember: async () => null }))
vi.mock('../layers/L6-core-facts.js', () => ({ addFact: () => undefined }))

const { MemoryGovernanceCoordinator, setMemoryGovernanceCoordinator } = await import('./memory-governance.js')
const { AutoObserver } = await import('./auto-observer.js')
const graph = await import('./knowledge-graph.js')

const root = () => join(process.cwd(), '.nova-test-tmp', `kg-fill-${randomUUID()}`)
function fresh() {
    const dir = root()
    const governance = new MemoryGovernanceCoordinator(join(dir, 'governance'))
    setMemoryGovernanceCoordinator(governance)
    return { governance, observer: new AutoObserver({ dataDir: join(dir, 'observer') }) }
}
const env = { test: process.env.NOVA_TEST_MODE, side: process.env.NOVA_NO_SIDE_EFFECTS }
afterEach(() => { process.env.NOVA_TEST_MODE = env.test; process.env.NOVA_NO_SIDE_EFFECTS = env.side })

describe('Governance prüft strukturierte Fakten', () => {
    it('verwirft Subjekt/Beziehung/Wert mit Secret, behält aber den Satz', () => {
        const { governance } = fresh()
        const record = governance.propose({
            content: 'Der NAS-Zugang des Benutzers ist bekannt und dokumentiert.', kind: 'context', scope: 'user:owner',
            source: 'test', evidence: 'explicit_user_instruction', confidence: 1,
            subject: 'user:owner', predicate: 'nas_token', value: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        })!
        expect(record).toBeTruthy()
        expect(record.subject).toBeUndefined()
        expect(record.value).toBeUndefined()
    })

    it('verwirft zu lange Werte (über 50 Zeichen)', () => {
        const { governance } = fresh()
        const record = governance.propose({
            content: 'Der Benutzer arbeitet an einem sehr langen Projekt mit Namen.', kind: 'project', scope: 'user:owner',
            source: 'test', evidence: 'explicit_user_instruction', confidence: 1,
            subject: 'user:owner', predicate: 'arbeitet_an', value: 'x'.repeat(51),
        })!
        expect(record.predicate).toBeUndefined()
    })

    it('projiziert einen kanonischen Wohnort als Ort-Knoten, nur im eigenen Scope sichtbar', async () => {
        const { governance } = fresh()
        process.env.NOVA_TEST_MODE = '0'; process.env.NOVA_NO_SIDE_EFFECTS = '0'
        const record = await governance.record({
            content: 'Der Benutzer wohnt in Hallein bei Salzburg.', kind: 'context', scope: 'user:owner',
            source: 'test', evidence: 'explicit_user_instruction', confidence: 1,
            subject: 'user:owner', predicate: 'wohnt_in', value: 'Hallein',
        })
        expect(record?.backends.knowledgeGraph).toBe(true)
        expect(graph.getNode('Hallein')?.type).toBe('place')
        expect(graph.searchGraph('Hallein', 3, ['user:owner'])).toContain('wohnt_in')
        expect(graph.searchGraph('Hallein', 3, ['user:gast'])).not.toContain('wohnt_in')
    })
})

describe('Auto-Observer liefert Tripel nur im Owner-Kontext', () => {
    it('Owner: Wohnort, Gerät, Projekt und Beziehung werden strukturiert vorgeschlagen', async () => {
        const { governance, observer } = fresh()
        await observer.observe('42', 'Ich wohne in Hallein.', 'user', 's1', { permission: 'owner' })
        await observer.observe('42', 'Mein Drucker heißt Voron.', 'user', 's2', { permission: 'owner' })
        await observer.observe('42', 'Ich arbeite an Xaventra.', 'user', 's3', { permission: 'owner' })
        await observer.observe('42', 'Mein Hund heißt Bello.', 'user', 's4', { permission: 'owner' })
        const triples = governance.list({ scope: 'user:42' })
            .filter(record => record.subject)
            .map(record => `${record.subject} ${record.predicate} ${record.value}`)
        expect(triples).toEqual(expect.arrayContaining([
            'user:42 wohnt_in Hallein',
            'user:42 drucker Voron',
            'user:42 arbeitet_an Xaventra',
            'user:42 hund Bello',
        ]))
    })

    it('Gegenprobe Owner: Beruf/Beschreibung ist kein Name, kleingeschriebenes kein Wert', async () => {
        const { governance, observer } = fresh()
        await observer.observe('42', 'Meine Frau ist Ärztin im Landeskrankenhaus Salzburg.', 'user', 's1', { permission: 'owner' })
        await observer.observe('42', 'Ich arbeite an einem neuen Feature für die Steuerung.', 'user', 's2', { permission: 'owner' })
        expect(governance.list({ scope: 'user:42' }).filter(record => record.subject)).toEqual([])
    })

    it('Nicht-Owner: dieselben Sätze werden gemerkt, aber ohne Tripel', async () => {
        const { governance, observer } = fresh()
        await observer.observe('77', 'Ich wohne in Hallein.', 'user', 's1', { permission: 'user' })
        await observer.observe('77', 'Mein Hund heißt Bello.', 'user', 's2', { permission: 'user' })
        await observer.observe('77', 'My name is Example Guest', 'user', 's3')
        const records = governance.list({ scope: 'user:77' })
        expect(records.length).toBeGreaterThan(0)
        expect(records.every(record => !record.subject && !record.predicate && !record.value)).toBe(true)
    })
})
