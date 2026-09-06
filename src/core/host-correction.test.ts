import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { processForCorrection, recordToolCall } from './correction-detector.js'

const { propose } = vi.hoisted(() => ({ propose: vi.fn(() => null) }))
vi.mock('../memory/memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => ({ propose }) }))
const file = join(process.cwd(), '.nova-data', 'hosts.json')
const host = { name: 'worker', alias: [], ip: '192.0.2.10', user: 'operator', description: '', lastSeen: null }
beforeEach(() => { mkdirSync(join(process.cwd(), '.nova-data'), { recursive: true }); propose.mockClear() })
function correct() {
    recordToolCall('ssh_command', { host: host.ip, user: host.user }, 'failed', 'fixture request', 'owner-fixture')
    processForCorrection('Korrektur: server hat die IP 192.0.2.20', 'owner-fixture')
}
describe('host correction persistence and evidence', () => {
    it.each(['legacy', 'reference', 'malformed'])('does not publish a completed IP change when %s storage cannot change safely', kind => {
        const original = kind === 'malformed' ? '{broken' : JSON.stringify({ hosts: [{ ...host,
            ...(kind === 'legacy' ? { password: 'legacy-fixture' } : { passwordEnv: 'XAVENTRA_SSH_FIXTURE' }),
        }] })
        writeFileSync(file, original)
        correct()
        expect(readFileSync(file, 'utf8')).toBe(original)
        expect(propose).not.toHaveBeenCalled()
    })
    it('still persists an ordinary credential-free host correction before publishing it', () => {
        writeFileSync(file, JSON.stringify({ hosts: [host] }))
        correct()
        expect(JSON.parse(readFileSync(file, 'utf8')).hosts[0].ip).toBe('192.0.2.20')
        expect(propose).toHaveBeenCalledTimes(1)
    })
})
