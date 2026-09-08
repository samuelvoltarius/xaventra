import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectActionIntent } from '../core/action-intent.js'
import { reflect } from '../intelligence/self-reflection.js'
import { readNodeId } from './L22-federated-memory.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

describe('layer evidence contracts', () => {
    afterEach(() => vi.unstubAllEnvs())
    it('requires live evidence for the reported Docker inspection without misclassifying explanations', () => {
        const request = 'schau dir mal local deine docker an und sag mir was du siehst'
        expect(detectActionIntent(request)).toEqual({requiresTool:true,kind:'system-state'})
        expect(detectActionIntent('Erkläre mir das Konzept von Docker')).toEqual({requiresTool:false,kind:'none'})
        expect(reflect({userMessage:request,assistantResponse:'Entschuldigung, da ist etwas schiefgelaufen. Bitte versuch es nochmal.',toolsUsed:[],toolResults:[]}).needsImprovement).toBe(true)
    })
    it('does not call a failed chat run good quality simply because no tool was required', () => {
        expect(reflect({userMessage:'Guten Abend',assistantResponse:'Entschuldigung, da ist etwas schiefgelaufen.',toolsUsed:[],toolResults:[],execution:{requiresTool:false,validated:false,failed:true}}).needsImprovement).toBe(true)
    })
    it('uses the configured canonical identity over a persisted compatibility alias', () => {
        writeFileSync(join(process.cwd(), '.nova-data/instance-id.txt'), 'nova-legacy-alias')
        vi.stubEnv('NOVA_NODE_ID','xaventra-test-node')
        expect(readNodeId()).toBe('xaventra-test-node')
        vi.stubEnv('NOVA_NODE_ID','')
        expect(readNodeId()).toBe('nova-legacy-alias')
    })
})
