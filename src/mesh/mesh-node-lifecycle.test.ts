import { describe, expect, it } from 'vitest'
import {
    NODE_OFFLINE_AFTER_MS,
    NODE_RETIRE_AFTER_MS,
    isActiveNode,
    isNodeVisibleByDefault,
    resolveNodeLifecycle,
} from './mesh-node-lifecycle.js'

describe('mesh node lifecycle', () => {
    const now = Date.parse('2026-07-18T12:00:00Z')
    const atAge = (age: number) => new Date(now - age).toISOString()

    it('separates fresh, temporarily offline and historical nodes', () => {
        expect(resolveNodeLifecycle({ lastHeartbeat: atAge(60_000) }, now)).toBe('active')
        expect(resolveNodeLifecycle({ lastHeartbeat: atAge(NODE_OFFLINE_AFTER_MS + 1) }, now)).toBe('offline')
        expect(resolveNodeLifecycle({ lastHeartbeat: atAge(NODE_RETIRE_AFTER_MS + 1) }, now)).toBe('retired')
    })

    it('keeps explicit retirement and tombstones sticky despite fresh heartbeats', () => {
        expect(resolveNodeLifecycle({ lastHeartbeat: atAge(0), lifecycleState: 'retired' }, now)).toBe('retired')
        expect(resolveNodeLifecycle({ lastHeartbeat: atAge(0), lifecycleState: 'tombstoned' }, now)).toBe('tombstoned')
    })

    it('keeps history out of the default and active views', () => {
        expect(isNodeVisibleByDefault('offline')).toBe(true)
        expect(isNodeVisibleByDefault('retired')).toBe(false)
        expect(isNodeVisibleByDefault('tombstoned')).toBe(false)
        expect(isActiveNode('active')).toBe(true)
        expect(isActiveNode('offline')).toBe(false)
    })
})
