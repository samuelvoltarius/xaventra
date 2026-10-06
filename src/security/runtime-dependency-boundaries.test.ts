import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleGit } from 'simple-git'
import { vulnerabilityCheck } from '@simple-git/argv-parser'
import proxyaddr from 'proxy-addr'

describe('patched indirect runtime dependency boundaries', () => {
    it.each(['VISUAL', 'visual', 'ViSuAl'])('detects editor substitution via %s without executing it', name => {
        expect(vulnerabilityCheck(['commit', '--amend'], { [name]: 'harmless-not-executed' }).length).toBeGreaterThan(0)
    })

    it.each(['trailer.audit.cmd=harmless-not-executed', 'include.path=harmless-not-opened'])('rejects unsafe Git configuration: %s', config => {
        expect(vulnerabilityCheck(['-c', config, '--version'], {}).length).toBeGreaterThan(0)
    })

    it('does not trust arbitrary IPv4 peers through malformed mapped IPv6 subnets', () => {
        expect(proxyaddr.compile('::ffff:10.0.0.0/8')('203.0.113.9', 0)).toBe(false)
        expect(proxyaddr.compile('::/1')('203.0.113.9', 0)).toBe(false)
        expect(proxyaddr.compile('10.0.0.0/8')('10.1.2.3', 0)).toBe(true)
        expect(proxyaddr.compile('::ffff:10.0.0.0/104')('10.1.2.3', 0)).toBe(true)
        expect(proxyaddr.compile('10.0.0.0/8')('203.0.113.9', 0)).toBe(false)
    })

    it('preserves native-library local bundle clone and removeRemote APIs with and without progress', async () => {
        const root = mkdtempSync(join(tmpdir(), 'git-dependency-'))
        const repo = simpleGit(root)
        await repo.init()
        await repo.addConfig('user.name', 'Dependency Test')
        await repo.addConfig('user.email', 'dependency-test@example.invalid')
        writeFileSync(join(root, 'fixture.txt'), 'local-only fixture\n')
        await repo.add('fixture.txt')
        await repo.commit('fixture')
        const bundle = join(root, 'fixture.bundle')
        await repo.raw(['bundle', 'create', bundle, 'HEAD'])
        for (const progress of [false, true]) {
            const target = join(root, progress ? 'with-progress' : 'without-progress')
            const client = simpleGit(progress ? { progress: () => {} } : {})
            await client.clone(bundle, target, { '--quiet': null })
            const cloned = simpleGit(target)
            await cloned.removeRemote('origin')
            expect(await cloned.getRemotes()).toEqual([])
            expect((await cloned.log(['-1'])).latest?.message).toBe('fixture')
        }
    }, 15000)
})
