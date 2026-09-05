import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MeshIdentity } from '../mesh/mesh-identity.js'
import { listReleaseFiles, releaseTreeHash, trustedKeysFromConfig, verifyReleaseDirectory, type NovaReleaseManifest } from './release-verifier.js'

function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'nova-release-'))
    const root = join(base, 'dist')
    mkdirSync(join(root, 'core'), { recursive: true })
    writeFileSync(join(root, 'daemon.js'), 'console.log("nova")')
    writeFileSync(join(root, 'core', 'worker.js'), 'export const ready = true')
    const identity = new MeshIdentity('nova-main-test', join(base, 'identity'))
    const files = listReleaseFiles(root)
    const payload: NovaReleaseManifest = {
        schemaVersion: 1, releaseId: '1.0.0-test', version: '1.0.0',
        createdAt: new Date().toISOString(), sourceNode: identity.nodeId,
        files, treeHash: releaseTreeHash(files),
    }
    const envelope = identity.create({
        kind: 'update.release', targetNode: '*', payload,
        principal: { id: 'node:nova-main-test', role: 'system' },
    })
    return { root, identity, envelope }
}

describe('signed Nova release verification', () => {
    it('accepts a complete release signed by a trusted mesh identity', () => {
        const { root, identity, envelope } = fixture()
        expect(verifyReleaseDirectory(envelope, root, [identity.publicKey])).toEqual({ valid: true })
    })

    it('rejects modified release files and untrusted signers', () => {
        const { root, identity, envelope } = fixture()
        writeFileSync(join(root, 'daemon.js'), 'tampered')
        expect(verifyReleaseDirectory(envelope, root, [identity.publicKey]).valid).toBe(false)
        expect(verifyReleaseDirectory(envelope, root, []).reason).toContain('not trusted')
    })

    it('accepts a promoted Main from the dedicated release trust list', () => {
        const { identity } = fixture()
        const base = mkdtempSync(join(tmpdir(), 'nova-release-config-'))
        const configPath = join(base, 'nova.config.json')
        writeFileSync(configPath, JSON.stringify({
            mesh: { update: { trustedReleaseKeys: [{ nodeId: identity.nodeId, publicKey: identity.publicKey }] } },
        }))
        expect(trustedKeysFromConfig(configPath, identity.nodeId)).toEqual([identity.publicKey])
    })
})
