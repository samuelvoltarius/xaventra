import { describe, expect, it } from 'vitest'
import { inferModelRouteNode } from './model-control.js'
import type { CapabilityGraphNode } from '../mesh/capability-graph.js'

describe('desktop model route ownership', () => {
    it('attributes a discovered vLLM endpoint to the exact mesh node', () => {
        const nodes = [{
            id: 'nova-spark', hostname: 'gpu-main', host: '100.64.0.10', status: 'online',
            capabilities: [], runtimes: [], updatedAt: new Date().toISOString(),
        }] as CapabilityGraphNode[]
        expect(inferModelRouteNode('http://100.64.0.10:8000', nodes)?.id).toBe('nova-spark')
    })

    it('does not invent ownership for an unknown endpoint', () => {
        expect(inferModelRouteNode('http://192.0.2.10:8000', [])).toBeUndefined()
    })
})
