import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { migrateLegacyProcedures, ProcedureStore } from './procedure-store.js'

const src = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))
const ok = (marker: string) => ({ success: true, content: `${marker} report delivered` })

function verified(store: ProcedureStore, request: string, marker: string, userId = 'alice', success = true) {
    return store.recordVerifiedOutcome({ toolName: 'read_file', request, params: { path: marker }, result: ok(marker), success, verified: true, userId })
}

describe('Ein Prozedur-Speicher (P9 Punkt 4)', () => {
    it('merkt sich eine Lösung erst nach zwei verifizierten Erfolgen derselben Form, pro Benutzer', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        expect(verified(store, 'Read the amber project report', 'AMBER').remembered).toBe(false)
        expect(store.recall('Read the amber project report', 'alice')).toBeNull()
        expect(verified(store, 'Read the amber project report', 'AMBER').remembered).toBe(true)
        verified(store, 'Read the cobalt project report', 'COBALT')
        expect(store.recall('Read the amber project report', 'alice')?.solution).toContain('AMBER')
        expect(store.recall('Read the amber project report', 'alice')?.solution).not.toContain('COBALT')
        expect(store.recall('Read the cobalt project report', 'alice')?.solution).toContain('COBALT')
        expect(store.recall('Read the amber project report', 'bob')).toBeNull()
        expect(store.recall('Read the amber project report')).toBeNull()
        // persistent
        const reloaded = new ProcedureStore(store.path)
        expect(reloaded.recall('Read the amber project report', 'alice')?.solution).toContain('AMBER')
        expect(reloaded.getStats()).toMatchObject({ procedures: 2, reusableProcedures: 1 })
    })

    it('ein Fehlschlag setzt die Zählung derselben Form zurück', () => {
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))
        verified(store, 'Read the amber project report', 'AMBER')
        verified(store, 'Read the amber project report', 'AMBER', 'alice', false)
        expect(verified(store, 'Read the amber project report', 'AMBER').remembered).toBe(false)
    })

    it('liegt standardmäßig in .nova-data', async () => {
        const { defaultProcedurePath } = await import('./procedure-store.js')
        expect(defaultProcedurePath()).toBe(join(process.env.NOVA_RUNTIME_ROOT!, '.nova-data', 'learning', 'procedures.json'))
    })

    it('übernimmt L17-, L8- und Koordinator-Dateien einmal und benennt sie in .migriert um', () => {
        const learning = temp('learn-')
        const l8 = join(temp('home-'), 'skills')
        mkdirSync(l8, { recursive: true })
        writeFileSync(join(learning, 'learned-solutions.json'), JSON.stringify([
            { userId: 'alice', problem: 'wie starte ich den dienst auf dem server neu', solution: 'Tool run_command: restarted nova service', learnedAt: 1, successCount: 2 },
            { problem: 'kurz', solution: 'alte Loesung', learnedAt: 1, successCount: 3 },
        ]))
        writeFileSync(join(learning, 'verified-procedures.json'), JSON.stringify({ version: 1, procedures: [['["alice","read_file",["path"]]', 1]] }))
        writeFileSync(join(l8, 'qr_code.json'), JSON.stringify({ id: 'skill_1', name: 'QR', capability: 'qr_code', description: 'Automatisch gelernt', toolCode: 'export async function x() {}', successCount: 0, learnedAt: 1, lastUsed: 1, source: 'qrcode' }))
        const store = new ProcedureStore(join(temp('proc-'), 'procedures.json'))

        const first = migrateLegacyProcedures({ store, learningDir: learning, l8SkillsDir: l8 })
        expect(first).toMatchObject({ l17: 2, l8: 1, signatures: 1 })
        expect(readdirSync(learning).sort()).toEqual(['learned-solutions.json.migriert', 'verified-procedures.json.migriert'])
        expect(existsSync(l8)).toBe(false)
        expect(existsSync(`${l8}.migriert`)).toBe(true)
        // verified L17 entry is usable, the legacy one is kept but never recalled, L8 code is never recalled
        expect(store.recall('wie starte ich den dienst auf dem server neu', 'alice')?.solution).toContain('restarted')
        expect(store.list().map(item => item.problem)).toContain('kurz')
        expect(store.list().find(item => item.source === 'migriert-l8')?.verified).toBe(false)
        // the coordinator counter continues: one more verified run promotes
        expect(verified(store, 'Read the amber project report', 'AMBER').remembered).toBe(true)

        expect(migrateLegacyProcedures({ store, learningDir: learning, l8SkillsDir: l8 })).toMatchObject({ l17: 0, l8: 0, signatures: 0 })
    })

    it('L8 und L17 sind als eigene Speicher weg, der Prompt bekommt keine L8-Fähigkeiten mehr', () => {
        expect(existsSync(src('layers/L8-meta-learning.ts'))).toBe(false)
        expect(existsSync(src('layers/L17-autonomous-learning.ts'))).toBe(false)
        const pipeline = readFileSync(src('core/message-pipeline.ts'), 'utf8')
        expect(pipeline).not.toMatch(/GELERNTE FÄHIGKEITEN|metaLearning/)
        expect(readFileSync(src('learning/learning-coordinator.ts'), 'utf8')).not.toMatch(/verified-procedures\.json|L17-autonomous|L8-meta/)
    })
})
