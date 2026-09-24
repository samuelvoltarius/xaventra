import { describe, expect, it } from 'vitest'
import { selectContractTools } from './tool-contract-selection.js'

describe('shared immutable tool catalog', () => {
    const catalog = [{ name: 'fetch_url' }, { name: 'run_command' }, { name: 'fetch_url' }]
    it('never treats an empty contract as all tools', () => {
        expect(selectContractTools([], catalog)).toEqual([])
    })
    it('intersects supplied tools with the contract and removes duplicates', () => {
        expect(selectContractTools(['fetch_url'], catalog)).toEqual([{ name: 'fetch_url' }])
    })
    it('retains a caller deny list without changing the contract', () => {
        const allowed = Object.freeze(['fetch_url', 'run_command'])
        expect(selectContractTools(allowed, catalog, ['run_command'])).toEqual([{ name: 'fetch_url' }])
        expect(allowed).toEqual(['fetch_url', 'run_command'])
    })
    it('never fills an explicitly empty supplied catalog', () => {
        expect(selectContractTools(['fetch_url'], [])).toEqual([])
    })
})
