import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryGovernanceCoordinator } from './memory-governance.js'
import { migrateLegacyMemoryStores } from './legacy-memory-migration.js'

// Alte Parallelspeicher (L7-Korrekturen, L20-Self-Rules, Local-/Vector-
// Memory, Mesh-Memory-Sync, Kausal-Gedächtnis) gehen beim Start einmal in die
// Memory-Governance auf; jede alte Datei wird als .migriert umbenannt, nie
// gelöscht.
let root: string
let governance: MemoryGovernanceCoordinator
beforeEach(() => {
    root = mkdtempSync(join(process.cwd(), '.nova-test-tmp', 'legacy-memory-'))
    governance = new MemoryGovernanceCoordinator(join(root, '.nova-data', 'memory', 'governance'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
}

describe('Migration der alten Gedächtnis-Dateien', () => {
    it('L7-Korrekturen → Governance (Scope des Absenders), Datei umbenannt', async () => {
        const file = join(root, '.nova-learning', 'corrections.json')
        write(file, [{ id: 'c1', userId: 'alfred', originalResponse: 'Der Drucker ist ein Prusa.', correctedResponse: 'Nein, nicht Prusa — sondern Voron 2.4', context: 'drucker', timestamp: 1, applied: true }])
        const report = await migrateLegacyMemoryStores({ root, governance })
        expect(report.corrections).toBe(1)
        expect(existsSync(file)).toBe(false)
        expect(existsSync(`${file}.migriert`)).toBe(true)
        const [record] = governance.list({ scope: 'user:alfred' })
        expect(record.content).toContain('Voron 2.4')
        expect(record.provenance[0].source).toBe('user-correction')
    })

    it('L20-Self-Rules → Governance als Anweisung im Scope des Nutzers; Testmüll und Legacy ohne Nutzer bleiben draußen', async () => {
        const file = join(root, '.nova-data', 'self-rules.json')
        write(file, [
            { id: 'r1', pattern: 'drucker status', rule: 'Bei Druckerfragen zuerst Moonraker abfragen, nicht raten.', source: 'correction', confidence: 0.9, appliedCount: 4, createdAt: 1, userId: 'alfred' },
            { id: 'r2', pattern: 'test pattern xyz', rule: 'Always do X for test', source: 'correction', confidence: 1, appliedCount: 0, createdAt: 1, userId: 'alfred' },
            { id: 'r3', pattern: 'egal', rule: 'Eine Regel ohne Besitzer wurde nie angewendet.', source: 'correction', confidence: 0.9, appliedCount: 0, createdAt: 1, userId: 'legacy' },
        ])
        const report = await migrateLegacyMemoryStores({ root, governance })
        expect(report.selfRules).toBe(1)
        expect(existsSync(`${file}.migriert`)).toBe(true)
        const records = governance.list()
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({ scope: 'user:alfred', kind: 'instruction', status: 'verified' })
        expect(records[0].content).toContain('Moonraker')
    })

    it('Local-/Vector-Memory → nur dauerhafte Nutzer-Aussagen als Kandidaten (nie Assistenz-Text), Dateien umbenannt', async () => {
        const local = join(root, '.nova-memory', 'memory.json')
        const vector = join(root, '.nova-vector-memory', 'index.json')
        write(local, { alfred: [
            { id: 'l1', userId: 'alfred', role: 'user', content: 'Mein Hauptrechner im Büro ist ein Mac Mini mit 64 GB RAM.', timestamp: 1, keywords: [] },
            { id: 'l2', userId: 'alfred', role: 'assistant', content: 'Ich habe deinen Mac Mini erfolgreich neu gestartet und geprüft.', timestamp: 2, keywords: [] },
            { id: 'l3', userId: 'alfred', role: 'user', content: 'ok', timestamp: 3, keywords: [] },
        ] })
        write(vector, { gast: [
            { id: 'v1', userId: 'gast', role: 'user', content: 'Ich fahre am Wochenende gerne mit dem Rennrad an den Wolfgangsee.', timestamp: 1 },
        ] })
        const report = await migrateLegacyMemoryStores({ root, governance })
        expect(report.localMemory).toBe(1)
        expect(report.vectorMemory).toBe(1)
        expect(existsSync(`${local}.migriert`) && existsSync(`${vector}.migriert`)).toBe(true)
        const alfred = governance.list({ scope: 'user:alfred' })
        expect(alfred.map(record => record.status)).toEqual(['candidate'])
        expect(alfred[0].content).toContain('Mac Mini')
        expect(governance.list({ scope: 'user:gast' })).toHaveLength(1)
        // candidates are never recalled before an owner approves them
        expect(governance.getContextForPrompt('user:alfred', 'Mac Mini')).toBe('')
    })

    it('Mesh-Memory-Sync und Kausal-Gedächtnis werden nur umbenannt (Outcome-Ledger/L22 sind die Quelle)', async () => {
        const shared = join(root, '.nova-data', 'mesh-memory', 'shared.json')
        const syncLog = join(root, '.nova-data', 'mesh-memory', 'sync-log.json')
        const causal = join(root, '.nova-data', 'causal-memory.json')
        write(shared, [{ id: 'm1', content: 'x', type: 'fact', source: 'pi5', timestamp: 't', hash: 'h', synced: true }])
        write(syncLog, { lastSync: 't', totalSynced: 1, nodeMemories: {} })
        write(causal, { version: 1, updatedAt: 't', events: [], links: [] })
        const report = await migrateLegacyMemoryStores({ root, governance })
        expect(report.renamed.sort()).toEqual([causal, shared, syncLog].sort())
        for (const file of [shared, syncLog, causal]) {
            expect(existsSync(file)).toBe(false)
            expect(readFileSync(`${file}.migriert`, 'utf8').length).toBeGreaterThan(0)
        }
        expect(governance.list()).toHaveLength(0)
    })

    it('ist idempotent und lässt eine schon vorhandene .migriert-Datei stehen', async () => {
        const file = join(root, '.nova-data', 'causal-memory.json')
        write(file, { version: 1, events: [], links: [] })
        writeFileSync(`${file}.migriert`, 'alt')
        await migrateLegacyMemoryStores({ root, governance })
        expect(readFileSync(`${file}.migriert`, 'utf8')).toBe('alt')
        expect(existsSync(file)).toBe(false)
        const again = await migrateLegacyMemoryStores({ root, governance })
        expect(again.renamed).toEqual([])
    })
})
