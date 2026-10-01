import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Ein Gedächtnis, ein Schreiber: LanceDB, Core Facts und der Wissensgraph
// sind Projektionen der Memory-Governance. Dieser Wächter hält tote
// Parallelspeicher und Direktschreiber draußen.
const root = process.env.NOVA_PROJECT_ROOT || process.cwd()
const src = join(root, 'src')

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) sources(path, out)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path)
    }
    return out
}
const files = sources(src).map(path => ({ path: relative(root, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf-8') }))

describe('Gedächtnis: eine Quelle, ein Schreiber', () => {
    it('tote Parallelspeicher sind gelöscht', () => {
        for (const dead of [
            'src/core/vector-memory.ts', 'src/memory/vector-store.ts', 'src/core/memory.ts',
            'src/memory/advanced-rag.ts', 'src/memory/user-preferences.ts', 'src/intelligence/knowledge-graph.ts',
            'src/memory/lancedb.ts', 'src/core/document-rag.ts', 'src/mesh/visual-mesh-memory.ts',
            'src/mesh/mesh-memory-sync.ts', 'src/memory/local-memory.ts', 'src/memory/vector-memory.ts',
            'src/core/causal-memory.ts', 'src/layers/L20-self-improvement.ts', 'src/thinking/decision-learning.ts',
        ]) expect(existsSync(join(root, dead)), dead).toBe(false)
    })

    it('nur memory-governance.ts schreibt in LanceDB', () => {
        const writers = files
            .filter(file => /lancedb-memory\.js/.test(file.text) && /\bremember\s*\(/.test(file.text))
            .map(file => file.path)
        expect(writers).toEqual(['src/memory/memory-governance.ts'])
    })

    it('nur memory-governance.ts schreibt in den Wissensgraphen', () => {
        const writers = files
            .filter(file => file.path !== 'src/memory/knowledge-graph.ts')
            .filter(file => /\.(addNode|addEdge)\s*\(/.test(file.text))
            .map(file => file.path)
        expect(writers).toEqual(['src/memory/memory-governance.ts'])
    })
})
