import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }))
import { getCapabilities } from './environment.js'

const dataDir = () => join(process.cwd(), '.nova-data')
const envFile = () => join(dataDir(), 'environment.json')
const hostsFile = () => join(dataDir(), 'hosts.json')

function writeCachedEnv() {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(envFile(), JSON.stringify({
        os: 'linux', arch: 'x64', hostname: 'fixture', shell: '/bin/sh', homeDir: '/home/fixture',
        hasChoco: true, hasScoop: false, hasBrew: false, hasApt: true, hasYum: false,
        hasSSH: true, hasPlink: false, hasSshpass: false, hasSSHKey: true, hasCurl: true, hasWget: false,
        hasGit: true, hasPython: true, hasNode: true, hasDocker: false, hasFfmpeg: false,
        networkReachable: true, detectedAt: new Date().toISOString(), cachedUntil: Date.now() + 60 * 60_000,
    }))
}

beforeEach(() => writeCachedEnv())
afterEach(() => {
    rmSync(hostsFile(), { force: true })
    rmSync(envFile(), { force: true })
})

describe('environment capabilities', () => {
    it('keeps the SSH host inventory out of the role-agnostic prompt block (R2 A9)', () => {
        writeFileSync(hostsFile(), JSON.stringify({ hosts: [{ name: 'fixture-nas', alias: [], ip: '192.0.2.44', user: 'fixture-admin', description: '', lastSeen: null }] }))
        const caps = getCapabilities()
        expect(caps).not.toContain('192.0.2.44')
        expect(caps).not.toContain('fixture-admin')
        expect(caps).toContain('SSH: ✅')
    })

})
