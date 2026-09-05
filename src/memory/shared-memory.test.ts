import { afterEach, describe, expect, it } from 'vitest'
import { readNodeId } from './shared-memory.js'

describe('shared memory node identity', () => {
    const previous = process.env.NOVA_NODE_ID

    afterEach(() => {
        if (previous === undefined) delete process.env.NOVA_NODE_ID
        else process.env.NOVA_NODE_ID = previous
    })

    it('prefers the canonical deployment node id over a legacy instance file', () => {
        process.env.NOVA_NODE_ID = 'nova-spark'
        expect(readNodeId()).toBe('nova-spark')
    })
})
