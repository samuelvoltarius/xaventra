import { afterEach, describe, expect, it } from 'vitest'
import { resetModelListCache } from './model-list-cache.js'
import { resolveRuntimeModelIdentity } from './runtime-model-identity.js'

afterEach(() => resetModelListCache())
const config = { provider: 'local', model: 'qwen', baseUrl: 'http://127.0.0.1:8000/v1' }
describe('runtime model metadata', () => {
    it('uses only the exact alias on the configured endpoint', async () => {
        resetModelListCache(async (url, init) => {
            expect(url).toBe('http://127.0.0.1:8000/v1/models')
            expect(init?.redirect).toBe('error')
            return Response.json({ data: [{ id: 'other', root: 'wrong/model' }, { id: 'qwen', root: 'Qwen/Qwen3-32B' }] })
        })
        expect(await resolveRuntimeModelIdentity(config)).toEqual({ provider: 'local', alias: 'qwen', model: 'Qwen/Qwen3-32B' })
    })
    it.each([
        [{ id: 'other', root: 'wrong/model' }],
        [{ id: 'qwen', root: 'qwen' }],
        [{ id: 'qwen', root: '/private/model' }],
        [{ id: 'qwen', root: 'one' }, { id: 'qwen', root: 'two' }],
    ])('does not invent a name for ambiguous or missing metadata: %j', async (...entries) => {
        resetModelListCache(async () => Response.json({ data: entries }))
        expect((await resolveRuntimeModelIdentity(config)).model).toBeNull()
    })
    it('keeps alias available on a network failure', async () => {
        resetModelListCache(async () => { throw new Error('offline') })
        expect(await resolveRuntimeModelIdentity(config)).toEqual({ provider: 'local', alias: 'qwen', model: null })
    })
})
