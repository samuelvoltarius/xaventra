import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shared = vi.hoisted(() => ({ pulls: [] as any[], rows: [] as any[] }))
vi.mock('./shared-memory.js', () => ({
    pullSharedMemory: async (params: any) => { shared.pulls.push(params); return shared.rows },
    pushSharedMemory: async () => true,
}))

const { LocalMemoryManager } = await import('./local-memory.js')

let dir = ''
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-local-memory-'))
    shared.pulls = []
    shared.rows = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('local memory persistence and shared import (R2 MA-16)', () => {
    it('keeps an unreadable store instead of overwriting it', async () => {
        writeFileSync(join(dir, 'memory.json'), '{ kaputt')
        const memory = new LocalMemoryManager({ dbPath: dir })
        await memory.store({ userId: 'alfred', role: 'user', content: 'neuer Eintrag', timestamp: 1 })
        const aside = readdirSync(dir).filter(name => name.startsWith('memory.json.corrupt-'))
        expect(aside).toHaveLength(1)
        expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe('{ kaputt')
        expect(existsSync(join(dir, 'memory.json'))).toBe(true)
    })

    it('imports only its own shared scope and takes newer versions of known rows', async () => {
        writeFileSync(join(dir, 'memory.json'), JSON.stringify({
            alfred: [{ id: 'm1', userId: 'alfred', role: 'user', content: 'Server Atlas geheim', timestamp: 10, keywords: [] }],
        }))
        shared.rows = [
            { id: 'm1', userId: 'alfred', role: 'user', content: 'bereinigt', timestamp: 20, scope: 'local-memory' },
            { id: 'c1', userId: 'alfred', role: 'system', content: '{"version":1}', timestamp: 30, scope: 'session-continuity' },
        ]
        new LocalMemoryManager({ dbPath: dir })
        await settle()
        expect(shared.pulls[0]?.scope).toBe('local-memory')
        const stored = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
        expect(stored.alfred.map((entry: any) => entry.content)).toEqual(['bereinigt'])
    })
})

describe('vector memory index is not overwritten after a failed load (R2 MA-16)', () => {
    it('moves an unreadable index aside', async () => {
        const { VectorMemoryStore } = await import('./vector-memory.js')
        writeFileSync(join(dir, 'index.json'), '{ kaputt')
        const store = new VectorMemoryStore({ dataDir: dir }) as any
        store.loadFromDisk()
        store.saveToDisk()
        const aside = readdirSync(dir).filter(name => name.startsWith('index.json.corrupt-'))
        expect(aside).toHaveLength(1)
        expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe('{ kaputt')
    })
})
