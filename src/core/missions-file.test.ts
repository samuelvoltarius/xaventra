import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// P9: the responsibility missions own missions/responsibility-missions.json;
// /wave (which used missions/missions.json) is gone; Aufträge have their own
// auftraege.json. No two features share one file.
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const source = (rel: string) => readFileSync(here(rel), 'utf8')

describe('Missions-, Auftrags- und Wave-Speicher getrennt', () => {
    it('missions.ts schreibt nur in missions/responsibility-missions.json', () => {
        expect(source('./missions.ts')).toMatch(/join\(options\.dataDir, 'missions', 'responsibility-missions\.json'\)/)
        expect(source('./missions.ts')).not.toMatch(/'missions\.json'/)
    })

    it('/wave ist entfernt; Aufträge schreiben auftraege.json', () => {
        expect(existsSync(here('../intelligence/wave-pipeline.ts'))).toBe(false)
        expect(source('./autonomous-executor.ts')).toMatch(/join\(DATA_DIR, 'auftraege\.json'\)/)
    })
})
