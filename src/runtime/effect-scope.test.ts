import { describe, expect, it } from 'vitest'
import { EffectScope } from './effect-scope.js'

describe('EffectScope', () => {
    it('unwinds effects and children once in reverse order', async () => {
        const events: string[] = []
        const scope = new EffectScope('root')
        scope.effect(() => { events.push('first') }, 'first')
        const child = scope.child('child')
        child.effect(() => { events.push('child') }, 'child-effect')
        scope.effect(() => { events.push('last') }, 'last')
        await scope.dispose()
        await scope.dispose()
        expect(events).toEqual(['last', 'child', 'first'])
        expect(scope.signal.aborted).toBe(true)
    })
})
