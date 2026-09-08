import { randomUUID } from 'node:crypto'
import { repairHash } from './repair-activation.js'
import { dockerRepairConfigHash, type DockerRepairEngine } from './docker-repair-driver.js'
import type { PublishedRepair } from './repair-publication.js'

/** Creates a stopped candidate from a protected operator template. Writable
 * named volumes are ALWAYS fresh; no automatic adoption of writable host binds. */
export async function createPublishedRepairContainer(engine: DockerRepairEngine, artifact: PublishedRepair, template: any) {
    const body = structuredClone(template), uid = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(body.User || '')
    if (!uid || !body.HostConfig || body.HostConfig.Binds?.length || body.HostConfig.VolumesFrom?.length
        || body.HostConfig.RestartPolicy?.Name !== 'no' || !body.HostConfig.ReadonlyRootfs || body.HostConfig.Privileged
        || body.HostConfig.NetworkMode === 'host') throw Error('Explicit confined mount-based publication template required')
    body.Image = artifact.imageId
    body.Labels = { ...body.Labels, 'org.xaventra.repair.binding': repairHash(artifact.binding), 'org.xaventra.repair.source': artifact.sourceHash }
    for (const mount of body.HostConfig.Mounts || []) {
        if (mount.ReadOnly === true || mount.Type === 'tmpfs') continue
        if (mount.Type !== 'volume' || !mount.Target?.startsWith('/') || mount.Target === '/') throw Error('Writable host binds cannot be adopted automatically')
        const volume = `xaventra-repair-${randomUUID()}`
        const created = await engine.call('POST', '/volumes/create', { Name: volume, Labels: { 'org.xaventra.repair.binding': repairHash(artifact.binding) } })
        if (created.Name !== volume) throw Error('Candidate volume identity mismatch')
        mount.Source = volume; mount.VolumeOptions = { NoCopy: true }
        const helper = await engine.call('POST', `/containers/create?name=xaventra-volume-init-${randomUUID()}`, {
            Image: artifact.baseImageId, User: '0:0', Entrypoint: ['/usr/local/bin/node'],
            // chmod while the narrowly privileged helper still owns the empty
            // directory; after chown, CAP_CHOWN does not grant CAP_FOWNER.
            Cmd: ['-e', `const fs=require('node:fs');if(fs.readdirSync('/state').length)throw Error('Not empty');fs.chmodSync('/state',0o700);fs.chownSync('/state',${Number(uid[1])},${Number(uid[2])});`],
            HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: ['CHOWN'], SecurityOpt: ['no-new-privileges'],
                Memory: 128 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 16, RestartPolicy: { Name: 'no' },
                Mounts: [{ Type: 'volume', Source: volume, Target: '/state', VolumeOptions: { NoCopy: true } }] },
        })
        if (!/^[a-f0-9]{64}$/.test(helper.Id)) throw Error('Invalid volume-helper identity')
        try {
            await engine.call('POST', `/containers/${helper.Id}/start`)
            const result = await engine.call('POST', `/containers/${helper.Id}/wait?condition=not-running`)
            if (result.StatusCode !== 0 || result.Error?.Message) throw Error('Volume initialization failed')
        } finally { await engine.call('DELETE', `/containers/${helper.Id}?force=true`) }
    }
    const created = await engine.call('POST', `/containers/create?name=xaventra-repair-${randomUUID()}`, body)
    if (!/^[a-f0-9]{64}$/.test(created.Id)) throw Error('Candidate container identity invalid')
    const info = await engine.call('GET', `/containers/${created.Id}/json`)
    if (info.State?.Running || info.Image !== artifact.imageId) throw Error('Candidate must remain stopped')
    return { release: { id: artifact.releaseId, previousReleaseId: artifact.previousReleaseId, sourceHash: artifact.sourceHash,
        imageId: artifact.imageId, binding: artifact.binding }, containerId: created.Id, configHash: dockerRepairConfigHash(info) }
}
