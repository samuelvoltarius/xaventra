import { afterEach, describe, expect, it } from 'vitest'
import { getRelevantTools } from '../tools/tool-router.js'
import { handoffTargetNode, setKnownNodeNamesForTests } from './known-node-names.js'

const LIVE = 'Gib diese Aufgabe an ns1: Sag mir, wie spät es dort ist und wer ich bin.'
const NODES = [
    { nodeId: 'xaventra-ns1', hostname: 'ns1' },
    { nodeId: 'xaventra-ns2', hostname: 'ns2' },
    { nodeId: 'nova-a1b2c3d4', hostname: 'lab' },
]
const names = (text: string) => getRelevantTools(text, text, { quiet: true }).map(tool => tool.name)

afterEach(() => setKnownNodeNamesForTests(null))

describe('2.90.0 hand-over to a named node (live 29.10. 14:00, „Gib diese Aufgabe an ns1“)', () => {
    it('the live sentence offers mesh_delegate and names the real node id', () => {
        setKnownNodeNamesForTests(NODES)
        expect(names(LIVE)).toContain('mesh_delegate')
        expect(handoffTargetNode(LIVE)).toEqual({ nodeId: 'xaventra-ns1', alias: 'ns1' })
    })
    it.each([
        ['lass das ns2 machen: df -h', 'xaventra-ns2'],
        ['Übergib das an den Knoten lab und lass ihn uptime prüfen', 'nova-a1b2c3d4'],
        ['auf ns2: uptime und df', 'xaventra-ns2'],
        ['schick die Aufgabe an xaventra-ns1', 'xaventra-ns1'],
        ['führ das auf ns1 aus: wie spät ist es', 'xaventra-ns1'],
    ])('„%s“ → %s', (text, nodeId) => {
        setKnownNodeNamesForTests(NODES)
        expect(handoffTargetNode(text)?.nodeId).toBe(nodeId)
        expect(names(text)).toContain('mesh_delegate')
    })
    it('Gegenprobe: a status question about a node offers status, no hand-over', () => {
        setKnownNodeNamesForTests(NODES)
        expect(handoffTargetNode('wie geht es ns1?')).toBeNull()
        const offered = names('wie geht es ns1?')
        expect(offered).toContain('mesh_status')
        expect(offered).not.toContain('mesh_delegate')
    })
    it('only real nodes count: an unknown name gets no hand-over', () => {
        setKnownNodeNamesForTests([{ nodeId: 'xaventra-ns2', hostname: 'ns2' }])
        expect(handoffTargetNode(LIVE)).toBeNull()
        expect(names(LIVE)).not.toContain('mesh_delegate')
    })
    it('a generic prefix is no alias („gib das an Xaventra“ is not a node)', () => {
        setKnownNodeNamesForTests(NODES)
        expect(handoffTargetNode('gib das an xaventra weiter')).toBeNull()
        expect(handoffTargetNode('gib das an nova')).toBeNull()
    })
})
