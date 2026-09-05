import { describe, expect, it } from 'vitest'
import { restrictWorkerTools } from './nova-runner.js'

describe('agent backend tool restriction', () => {
    const contractTools = [{ name: 'read_file' }, { name: 'health_status' }]

    it('treats an explicit empty list as planning-only', () => {
        expect(restrictWorkerTools(contractTools, [])).toEqual([])
    })

    it('can only narrow the contract and never add an uncontracted tool', () => {
        expect(restrictWorkerTools(contractTools, [
            { name: 'health_status' },
            { name: 'run_command' },
        ])).toEqual([{ name: 'health_status' }])
    })

    it('preserves contract routing when no backend restriction was supplied', () => {
        expect(restrictWorkerTools(contractTools)).toEqual(contractTools)
    })
})
