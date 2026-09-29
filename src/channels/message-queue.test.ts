import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../core/ha-state.js', () => ({
    isHaStateAvailable: async () => false,
    readHaRecords: async () => [],
    writeHaRecord: async () => true,
}))

function queueDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nova-msgq-'))
    mkdirSync(join(dir, '.nova-data'), { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    return dir
}

async function freshQueue() {
    vi.resetModules()
    return import('./message-queue.js')
}

const entry = (id: string, status = 'pending') => JSON.stringify({
    id, chatId: '1', from: '9', content: `msg ${id}`, channel: 'Telegram',
    receivedAt: new Date().toISOString(), status, retries: 0,
})

afterEach(() => { vi.restoreAllMocks() })

describe('H11 persistent queue survives a torn JSONL line', () => {
    it('keeps valid entries around a corrupt line and quarantines the corrupt one', async () => {
        const dir = queueDir()
        const file = join(dir, '.nova-data', 'msg-queue.jsonl')
        writeFileSync(file, `${entry('a')}\n{"id":"torn","chatId":\n${entry('b')}\n`)
        const queue = await freshQueue()
        const replay = queue.initMessageQueue()
        expect(replay.map(m => m.id).sort()).toEqual(['a', 'b'])
        queue.markDone('a')
        const kept = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(kept.map((m: any) => m.id).sort()).toEqual(['a', 'b'])
        const quarantine = join(dir, '.nova-data', 'msg-queue.corrupt.jsonl')
        expect(existsSync(quarantine)).toBe(true)
        expect(readFileSync(quarantine, 'utf8')).toContain('torn')
    })

    it('never overwrites the queue with an empty result after a parse problem', async () => {
        const dir = queueDir()
        const file = join(dir, '.nova-data', 'msg-queue.jsonl')
        writeFileSync(file, `${entry('a')}\n${entry('b')}\n{"id":"half`)
        const queue = await freshQueue()
        queue.initMessageQueue()
        queue.markDone('b')
        const ids = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).id)
        expect(ids.sort()).toEqual(['a', 'b'])
    })

    it('does not glue a new entry onto a torn last line', async () => {
        const dir = queueDir()
        const file = join(dir, '.nova-data', 'msg-queue.jsonl')
        writeFileSync(file, `${entry('a')}\n{"id":"half`)
        const queue = await freshQueue()
        queue.initMessageQueue()
        expect(queue.logIncoming({ id: 'c', chatId: '1', from: '9', content: 'new', channel: 'Telegram' })).toBe(true)
        const reloaded = await freshQueue()
        expect(reloaded.initMessageQueue().map(m => m.id).sort()).toEqual(['a', 'c'])
    })
})
