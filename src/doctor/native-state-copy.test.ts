import { it, expect } from 'vitest'
import { Script } from 'node:vm'
import { createNativeStateCopyScript, createRepairStateCopyScript } from './docker-repair-state.js'
it.each([['/a','/a'],['/a','/a/b'],['/a/b','/a'],['/','/b'],['relative','/b'],['/a/../b','/c'],['/a\n','/b']])('refuses unsafe native paths %j %j', (a,b) => {
    expect(() => createNativeStateCopyScript(a,b)).toThrow('paths')
})
it('keeps path text as data and produces parseable source for both helpers', () => {
    expect(() => new Script(createNativeStateCopyScript('/state/a\'x','/state/b"y'))).not.toThrow()
    expect(() => new Script(createRepairStateCopyScript())).not.toThrow()
})
it('preserves conservative limits and refuses caller over-budget requests', () => {
    expect(() => createNativeStateCopyScript('/a','/b',{maxBytes:0})).toThrow()
    expect(() => createNativeStateCopyScript('/a','/b',{maxBytes:10,maxFileBytes:11})).toThrow()
    const code=createNativeStateCopyScript('/a','/b')
    expect(code).toContain('syncDirectories')
    expect(code).toContain('Native state ownership mismatch')
    expect(code).toContain('sourceAfterHash:unchanged')
})
