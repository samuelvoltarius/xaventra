import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// /wave (wave-pipeline.ts) owns .nova-data/missions/missions.json with its own
// format. The responsibility missions (missions.ts) must not share that file,
// otherwise each side reads the other as empty and overwrites it.
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('Missions-Speicher getrennt von /wave', () => {
    it('missions.ts schreibt nicht in missions/missions.json', () => {
        expect(source('./missions.ts')).not.toMatch(/join\(options\.dataDir, 'missions', 'missions\.json'\)/)
        expect(source('../intelligence/wave-pipeline.ts')).toMatch(/'missions\.json'/)
    })
})
