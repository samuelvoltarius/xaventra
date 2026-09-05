import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryManager } from './memory.js'

const created: string[] = []

async function createManager(): Promise<{ manager: MemoryManager; path: string }> {
    const path = await mkdtemp(join(process.cwd(), '.nova-tmp-memory-'))
    created.push(path)
    return { manager: new MemoryManager({ storagePath: path }), path }
}

afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await Promise.all(created.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MemoryManager persistence and search', () => {
    it('searches for regular-expression characters literally', async () => {
        const { manager } = await createManager()
        manager.addMessage('search', 'user', 'array[0] and array[0]')

        expect(manager.searchConversations('[0]')).toHaveLength(1)
    })

    it('persists an empty conversation when explicitly flushed', async () => {
        const { manager, path } = await createManager()
        manager.startConversation('empty')
        await manager.flush()

        const index = JSON.parse(await readFile(join(path, 'index.json'), 'utf8'))
        expect(index.conversationIds).toContain('empty')
        await expect(stat(join(path, 'empty.json'))).resolves.toBeDefined()
    })

    it('removes cleared conversations from disk', async () => {
        const { manager, path } = await createManager()
        manager.addMessage('obsolete', 'user', 'remove me')
        await manager.flush()
        manager.clearAll()
        await manager.flush()

        const index = JSON.parse(await readFile(join(path, 'index.json'), 'utf8'))
        expect(index.conversationIds).toEqual([])
        await expect(stat(join(path, 'obsolete.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
