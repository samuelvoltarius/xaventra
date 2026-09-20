import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistenceCatalog } from './generate-runtime-catalogs.js'

describe('runtime persistence catalog', () => {
    const roots: string[] = []
    afterEach(() => {
        while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
    })

    it('catalogs literal data-root helper paths instead of silently omitting them', () => {
        const root = mkdtempSync(join(tmpdir(), 'xaventra-catalog-'))
        roots.push(root)
        const file = join(root, 'sample.ts')
        const dataCall = 'getNova' + 'DataDir'
        const learningCall = 'getNova' + 'LearningDir'
        writeFileSync(file, [
            `${dataCall}('outcome-router-samples.json')`,
            `${dataCall}('self-doctor', 'failure-research.json')`,
            `${learningCall}('regression-cases.json')`,
        ].join('\n'))

        expect(persistenceCatalog([file])).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: '.nova-data/outcome-router-samples.json' }),
            expect.objectContaining({ path: '.nova-data/self-doctor/failure-research.json' }),
            expect.objectContaining({ path: '.nova-learning/regression-cases.json' }),
        ]))
    })
})
