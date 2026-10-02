import { describe, expect, it } from 'vitest'
import { combineErrorSources } from './thinking-runtime.js'

// Integration 2.83.0: package A closes bug-finder cases by measured successes
// (ErrorSourcePort.successes); package B combines the error sources. The
// combined source must pass successes through, otherwise no case ever closes.
describe('combineErrorSources reicht Erfolge weiter', () => {
    it('summiert successes aller Quellen, die sie liefern', async () => {
        const combined = combineErrorSources([
            { collect: async () => [], successes: async () => ({ web_search: 4, read_file: 1 }) },
            { collect: async () => [] },
            { collect: async () => [], successes: () => ({ web_search: 2 }) },
        ])
        expect(typeof combined.successes).toBe('function')
        expect(await combined.successes!(0)).toEqual({ web_search: 6, read_file: 1 })
    })

    it('eine kaputte Quelle hält die anderen nicht auf', async () => {
        const combined = combineErrorSources([
            { collect: async () => [], successes: async () => { throw new Error('kaputt') } },
            { collect: async () => [], successes: async () => ({ web_search: 3 }) },
        ])
        expect(await combined.successes!(0)).toEqual({ web_search: 3 })
    })
})
