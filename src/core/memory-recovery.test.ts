import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const removed = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, rm: (path: any, options?: any) => { removed.push(String(path)); return actual.rm(path, options) } }
})
import { MemoryManager } from './memory.js'

const created: string[] = []
afterEach(async () => { await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function storage(): Promise<string> {
    const path = await mkdtemp(join(process.cwd(), '.nova-tmp-memory-'))
    created.push(path)
    return path
}

const conversation = (id: string) => JSON.stringify({ id, messages: [{ role: 'user', content: `hallo ${id}`, timestamp: 1 }], createdAt: 1, updatedAt: 1 })

describe('CLI memory robustness (R2 A26)', () => {
    it('loads the remaining conversations and keeps a damaged one in the index', async () => {
        const path = await storage()
        await writeFile(join(path, 'index.json'), JSON.stringify({ conversationIds: ['a', 'b', 'c'] }))
        await writeFile(join(path, 'a.json'), conversation('a'))
        await writeFile(join(path, 'b.json'), '{"id": "b", "messages": [')
        await writeFile(join(path, 'c.json'), conversation('c'))
        const manager = new MemoryManager({ storagePath: path })
        expect(manager.getConversation('c')).not.toBeNull()
        manager.addMessage('d', 'user', 'neu')
        await manager.flush()
        const index = JSON.parse(await readFile(join(path, 'index.json'), 'utf8'))
        expect(index.conversationIds).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']))
    })

    it('does not delete a conversation that was re-created before the flush', async () => {
        const path = await storage()
        const manager = new MemoryManager({ storagePath: path })
        manager.addMessage('x', 'user', 'alt')
        await manager.flush()
        manager.clearConversation('x')
        manager.addMessage('x', 'user', 'neu')
        removed.length = 0
        await manager.flush()
        // A concurrent rm of the re-created file races the atomic write.
        expect(removed.some(path => path.endsWith('x.json'))).toBe(false)
        await expect(stat(join(path, 'x.json'))).resolves.toBeDefined()
        expect(await readFile(join(path, 'x.json'), 'utf8')).toContain('neu')
    })
})
