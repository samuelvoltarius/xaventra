// Install with compiled dist/ OUTSIDE application releases, root owned. This
// supervisor is never launched from application-controlled code or configuration.
import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitHubUpdateSource, verifyUpstreamManifest } from '../dist/core/github-update.js'
import { decodeUpdatePackage, upstreamReleaseId } from '../dist/core/update-package.js'
import { UpdateActivationController } from '../dist/core/update-activation.js'
import { createUpdateControllerServer } from '../dist/core/update-controller-server.js'
import { DockerRepairDriver, localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { createPublishedRepairContainer } from '../dist/doctor/docker-repair-publication.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { repairHash, repairRpc, signRepairValue, verifyRepairValue } from '../dist/doctor/repair-activation.js'
import { RepairDrainClient } from '../dist/doctor/repair-drain-client.js'
import { RepairWriterBarrier } from '../dist/doctor/repair-writers.js'
import { writeUpdateState as atomicWriteJsonSync } from '../dist/core/update-store.js'
import { readProtectedControllerFile as protectedFile, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'

const c = JSON.parse(protectedFile(process.argv[2] || '', true))
process.umask(0o077)
protectControllerDirectory(c.stateRoot); protectControllerDirectory(c.grantsRoot)
if ((!c.socketPath && (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535)) || !c.targetId || !['x64', 'arm64'].includes(process.arch)) throw Error('Invalid controller enrollment')
for (const key of ['authorityUrl', 'drainUrl', 'stateHelperImageId', 'deploymentFile', 'templateFile']) if (!c[key]) throw Error(`Missing enrollment: ${key}`)
if (!c.writerHosts && !c.stateAuthorityUrl) throw Error('Complete writer barrier or independent state authority required')
const approvalKey = protectedFile(c.approvalPublicKeyFile), receiptKey = protectedFile(c.receiptPrivateKeyFile, true)
const authorityKey = protectedFile(c.authorityPublicKeyFile)
const publisherKeys = Object.fromEntries(Object.entries(c.publisherPublicKeyFiles).map(([id, file]) => [id, protectedFile(file)]))
const engine = localDockerRepairEngine(c.dockerSocket), exec = promisify(execFile)
const drain = new RepairDrainClient({ url: c.drainUrl, actor: 'operator', privateKey: protectedFile(c.drainOperatorPrivateKeyFile, true),
    authorityPublicKey: protectedFile(c.drainAuthorityPublicKeyFile) })
const decision = async (url, ticket, state = false) => {
    const challenge = randomUUID(), d = await repairRpc(url, { challenge, ticket }, authorityKey)
    return d.allowed === true && d.challenge === challenge && d.bindingHash === repairHash(ticket)
        && d.targetId === ticket.targetId && d.patchHash === ticket.patchHash
        && Number.isFinite(d.expiresAt) && d.expiresAt > Date.now() && d.expiresAt <= Date.now() + 10_000
        && (!state || d.externalWritersQuiesced === true)
}
const stateFile = join(c.stateRoot, 'runtime-state.json'), registrations = join(c.stateRoot, 'registrations.json')
const server = createUpdateControllerServer({ root: join(c.stateRoot, 'jobs'), targetId: c.targetId,
    token: protectedFile(c.clientTokenFile, true).trim(), receiptPrivateKey: receiptKey,
    authorize: async id => {
        const t = verifyRepairValue(JSON.parse(protectedFile(join(c.grantsRoot, `${id}.json`))), approvalKey)
        return t.proposalId === `upstream-${id}` && t.targetId === c.targetId && t.expiresAt > Date.now()
            && t.expiresAt <= Date.now() + 600_000 && await decision(c.authorityUrl, t)
    },
    deploy: async id => {
        // Caller supplies ONLY the release ID. Fetch into supervisor-owned storage;
        // never trust runtime packagePath/cache, model fields or writable manifests.
        const signed = JSON.parse(protectedFile(join(c.grantsRoot, `${id}.json`)))
        const ticket = verifyRepairValue(signed, approvalKey)
        if (ticket.proposalId !== `upstream-${id}` || ticket.targetId !== c.targetId || ticket.expiresAt <= Date.now()
            || ticket.expiresAt > Date.now() + 600_000 || !await decision(c.authorityUrl, ticket)) throw Error('Exact release/node grant missing or fenced')
        const deployment = JSON.parse(protectedFile(c.deploymentFile))
        if (deployment.targetId !== c.targetId) throw Error('Enrollment target mismatch')
        if (existsSync(registrations)) Object.assign(deployment.releases, JSON.parse(protectedFile(registrations)))
        const runtime = existsSync(stateFile) ? JSON.parse(protectedFile(stateFile)) : { releaseId: deployment.initialReleaseId }
        const old = deployment.releases[runtime.releaseId]
        if (!old || old.release.sourceHash !== ticket.baselineHash || !old.version) throw Error('Baseline continuity missing')
        const source = new GitHubUpdateSource(join(c.stateRoot, 'downloads'), { publisherKeys, channel: c.channel || 'stable' }, old.version)
        const staged = await source.prepare(id)
        if (staged.state !== 'prepared') throw Error('Independent package download failed')
        const manifest = verifyUpstreamManifest(JSON.parse(readFileSync(`${staged.packagePath}.manifest.json`, 'utf8')),
            { publisherKeys }, staged.version, old.version)
        if (upstreamReleaseId(manifest) !== id || repairHash(manifest) !== ticket.candidateHash) throw Error('Release binding changed')
        const bytes = readFileSync(staged.packagePath), a = manifest.artifacts.find(a => a.platform === 'linux' && a.arch === process.arch)
        if (!a || bytes.length !== a.size || createHash('sha256').update(bytes).digest('hex') !== a.sha256 || ticket.patchHash !== a.sha256) throw Error('Package binding mismatch')
        const payload = decodeUpdatePackage(bytes, manifest, process.arch)
        // Fixed executable, argv, registry and immutable digest. No shell, hooks,
        // compose files, arbitrary pull origins or candidate-provided Docker config.
        if (!await decision(c.authorityUrl, ticket)) throw Error('Pull fenced')
        await exec('/usr/bin/docker', ['--host', `unix://${c.dockerSocket || '/var/run/docker.sock'}`, 'pull', payload.image],
            { timeout: 300_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', DOCKER_CONFIG: join(c.stateRoot, 'registry-client') } })
        const image = await engine.call('GET', `/images/${encodeURIComponent(payload.image)}/json`)
        if (!/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Os !== 'linux' || image.Architecture !== (process.arch === 'x64' ? 'amd64' : 'arm64')
            || image.Config?.Labels?.['org.opencontainers.image.revision'] !== manifest.commit
            || image.Config?.Labels?.['org.opencontainers.image.version'] !== manifest.version) throw Error('Pulled image identity mismatch')
        const { attemptId: _id, expiresAt: _expiry, ...binding } = ticket
        let candidate, barrier
        const targetIds = Object.values(deployment.releases).map(r => r.containerId)
        const driver = new DockerRepairDriver({ ...deployment, catalog: {}, hasAuthority: t => decision(c.authorityUrl, t),
            loadState: () => runtime, saveState: state => atomicWriteJsonSync(stateFile, state),
            stateReady: createDockerRepairStateCloner({ engine, helperImageId: c.stateHelperImageId,
                quiescent: async t => {
                    const d = await drain.request('status', t)
                    return d.bindingHash === repairHash(t) && d.toolActionsDrained === true
                        && (barrier ? await barrier.quiescent(t) : await decision(c.stateAuthorityUrl, t, true))
                } }),
            prepareRelease: async t => {
                if (!await decision(c.authorityUrl, t)) throw Error('Container creation fenced')
                const artifact = { version: 1, binding, releaseId: id, previousReleaseId: runtime.releaseId, imageId: image.Id,
                    sourceHash: ticket.candidateHash, baseImageId: c.stateHelperImageId, compiledHash: a.sha256, createdAt: Date.now() }
                const next = await createPublishedRepairContainer(engine, artifact, JSON.parse(protectedFile(c.templateFile)))
                candidate = next; targetIds.push(next.containerId)
                const records = existsSync(registrations) ? JSON.parse(protectedFile(registrations)) : {}
                records[id] = { ...next, version: manifest.version }; atomicWriteJsonSync(registrations, records)
                return next
            } }, engine)
        driver.beginMaintenance = async t => {
            await drain.request('begin', t)
            const deadline = Math.min(Date.now() + 30_000, t.expiresAt)
            while (Date.now() < deadline) {
                const s = await drain.request('status', t)
                if (s.bindingHash === repairHash(t) && s.toolActionsDrained === true) {
                    if (c.writerHosts) {
                        const hosts = structuredClone(c.writerHosts)
                        let enrolledTarget = 0
                        for (const h of hosts) {
                            const e = localDockerRepairEngine(h.socketPath)
                            if (h.members.some(m => targetIds.includes(m.containerId))) {
                                enrolledTarget++
                                h.members = h.members.map(m => targetIds.includes(m.containerId) ? { containerId: old.containerId, configHash: old.configHash } : m)
                                h.staged = [{ containerId: candidate.containerId, configHash: candidate.configHash }]
                                const baseline = await e.call('GET', `/containers/${old.containerId}/json`)
                                const next = await e.call('GET', `/containers/${candidate.containerId}/json`)
                                h.preserveSources = baseline.Mounts.filter(m => m.RW && m.Type !== 'tmpfs').map(m => m.Source)
                                h.protectedSources = [...new Set([...h.protectedSources, ...h.preserveSources, ...next.Mounts.filter(m => m.RW && m.Type !== 'tmpfs').map(m => m.Source)])]
                            }
                        }
                        if (enrolledTarget !== 1) throw Error('Target must belong to exactly one enrolled writer host')
                        atomicWriteJsonSync(join(c.stateRoot, `writers-${ticket.attemptId}.json`), hosts)
                        barrier = new RepairWriterBarrier({ root: join(c.stateRoot, `${ticket.attemptId}-writers`),
                            hosts: hosts.map(h => ({ ...h, engine: localDockerRepairEngine(h.socketPath) })), requiredHosts: c.requiredWriterHosts,
                            externalSinks: c.externalWriterSinks, hasAuthority: t => decision(c.authorityUrl, t),
                            toolDrain: async t => { const d = await drain.request('status', t); return d.bindingHash === repairHash(t) && d.toolActionsDrained === true },
                            sinkFenced: async (sink, t) => {
                                const profile = c.sinkFenceProfiles?.[sink]; if (!profile) return false
                                const challenge = randomUUID(), proof = await repairRpc(profile.url, { challenge, ticket: t }, protectedFile(profile.publicKeyFile))
                                return proof.challenge === challenge && proof.bindingHash === repairHash(t) && proof.sink === sink && proof.writesFenced === true
                                    && Number.isFinite(proof.expiresAt) && proof.expiresAt > Date.now() && proof.expiresAt <= Date.now() + 10_000
                            } })
                        await barrier.halt(t); return
                    }
                    if (await decision(c.stateAuthorityUrl, t, true)) return
                }
                if (s.uncertain) throw Error('Uncertain external actions')
                await new Promise(r => setTimeout(r, 250))
            }
            throw Error('Admission / external writer fencing incomplete')
        }
        const probe = createHttpRepairProbe(c.probes, driver)
        const controller = new UpdateActivationController(join(c.stateRoot, 'activation'), approvalKey, driver,
            async (release, t) => {
                const p = await probe(t.probeId, t.targetId, randomUUID())
                if (p.state !== 'healthy' || p.releaseId !== release) throw Error('Independent update acceptance failed')
                return p.fingerprint
            }, async receipt => {
                if (barrier) await barrier.resumePeers(receipt.ticket, targetIds, receipt.status === 'rolled-back')
                await drain.request('release-update', { ticket: receipt.ticket, receipt: signRepairValue(receipt, receiptKey) })
            })
        return controller.deploy(signed, { manifest })
    } })
if (c.socketPath) {
    if (!c.socketPath.startsWith('/') || c.socketPath.includes('\0') || existsSync(c.socketPath)) throw Error('Socket exists or invalid; reconcile supervisor ownership')
    protectControllerDirectory(dirname(c.socketPath))
    server.listen(c.socketPath, () => { chmodSync(c.socketPath, 0o660); console.log('Xaventra update controller ready on enrolled Unix socket') })
} else server.listen(c.port, '127.0.0.1', () => console.log('Xaventra update controller listening on enrolled loopback endpoint'))
