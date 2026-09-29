import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// UEB-17: shared mesh memories carry a scope, and "vergiss" removes mesh
// copies and shared.json entries (tombstone + forget broadcast).

const sharedFile = () => join(process.cwd(), '.nova-data', 'mesh-memory', 'shared.json')
const shared = () => existsSync(sharedFile()) ? readFileSync(sharedFile(), 'utf8') : ''

describe('UEB-17 mesh memory scope and forget', () => {
    it('keeps scoped memories out of the pool and forgets shared ones everywhere', async () => {
        vi.resetModules()
        const sync = await import('./mesh-memory-sync.js')
        const hub = await import('./event-hub.js')
        await sync.initMeshMemory()
        const forgotten = vi.fn()
        hub.on('mesh:memory_forget', forgotten)

        await sync.shareMemory('Privates Detail von Nutzer X', 'fact', 'main', 'user:x')
        expect(shared()).not.toContain('Privates Detail')

        await sync.shareMemory('Der Owner mag Espresso', 'preference', 'main')
        expect(shared()).toContain('Espresso')

        const removed = await sync.forgetSharedMemory({ content: 'Der Owner mag Espresso' })
        expect(removed).toBe(1)
        expect(shared()).not.toContain('Espresso')
        expect(forgotten).toHaveBeenCalled()
        const hashes = forgotten.mock.calls[0][0].data.hashes as string[]

        // A copy arriving later from another node is not re-imported.
        const copy = { id: 'm1', content: 'Der Owner mag Espresso', type: 'preference', source: 'pi5', timestamp: new Date().toISOString(), hash: hashes[0], synced: true }
        expect(sync.receiveSharedMemory(copy as any)).toBe(false)
        // Scoped entries from peers are refused as well.
        expect(sync.receiveSharedMemory({ ...copy, id: 'm2', content: 'x', hash: '0123456789abcdef', scope: 'user:y' } as any)).toBe(false)
    })

    it('applies a forget broadcast received from another node', async () => {
        vi.resetModules()
        const sync = await import('./mesh-memory-sync.js')
        const hub = await import('./event-hub.js')
        await sync.initMeshMemory()
        const memory = { id: 'm3', content: 'Geteiltes Fakt vom Pi', type: 'fact', source: 'pi5', timestamp: new Date().toISOString(), hash: 'fedcba9876543210', synced: true }
        expect(sync.receiveSharedMemory(memory as any)).toBe(true)
        hub.emit('mesh:memory_forget', { hashes: ['fedcba9876543210'] })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(shared()).not.toContain('Geteiltes Fakt')
    })
})
