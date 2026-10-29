import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CODEKARTE_PATH, codekarteGaps, formatCodekarteGaps, listSrcDirs } from './check-codekarte.js'
import { ALL_TOOLS } from '../tools/complete-registry.js'

describe('codekarte coverage', () => {
    it('reports a new src directory and a new tool that the map does not name', () => {
        const karte = '| `src/core` | Pipeline |\nWerkzeuge: `remember`, `recall`'
        const gaps = codekarteGaps(karte, ['core', 'desktop', 'desktop-direct'], ['remember', 'recall', 'kg_remember'])
        expect(gaps.missingDirs).toEqual(['desktop', 'desktop-direct'])
        expect(gaps.missingTools).toEqual(['kg_remember'])
        expect(formatCodekarteGaps({ missingFile: false, ...gaps })).toContain('src/desktop-direct')
    })

    it('does not count a prefix as the directory or a substring as the tool', () => {
        const gaps = codekarteGaps('`src/desktop-direct` and `kg_remember`', ['desktop'], ['remember'])
        expect(gaps).toEqual({ missingDirs: ['desktop'], missingTools: ['remember'] })
    })

    it('the checked-in CODEKARTE names every src directory and every registered tool', () => {
        // vitest runs in a temp cwd, so the repository root comes from this file's location.
        const root = fileURLToPath(new URL('../../', import.meta.url))
        const karte = readFileSync(join(root, CODEKARTE_PATH), 'utf8')
        expect(codekarteGaps(karte, listSrcDirs(root), ALL_TOOLS.map(tool => tool.name))).toEqual({ missingDirs: [], missingTools: [] })
    })
})
