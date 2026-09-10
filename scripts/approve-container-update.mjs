// Deliberate operator action, not an app endpoint. Keep approval identity outside
// the controller and application containers. Re-check creates no broad/standing grant.
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readProtectedControllerFile as read, protectControllerDirectory } from '../dist/doctor/repair-controller-files.js'
import { GitHubUpdateSource, verifyUpstreamManifest } from '../dist/core/github-update.js'
import { upstreamReleaseId } from '../dist/core/update-package.js'
import { repairHash, signRepairValue } from '../dist/doctor/repair-activation.js'
import { writeUpdateState } from '../dist/core/update-store.js'
const [file, id] = process.argv.slice(2), o = JSON.parse(read(file || '', true))
process.umask(0o077)
const c = JSON.parse(read(o.controllerConfigFile, true))
protectControllerDirectory(o.authorityGrantsRoot); protectControllerDirectory(c.grantsRoot)
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?-[a-f0-9]{64}$/.test(id || '') || !o.holderNodeId
    || !Number.isSafeInteger(o.leaseEpoch) || o.leaseEpoch < 1 || !o.probeId || !c.probes.some(p => p.id === o.probeId && p.targetId === c.targetId)) throw Error('Exact release, current holder/epoch and enrolled probe required')
const d = JSON.parse(read(c.deploymentFile)), statePath = join(c.stateRoot, 'runtime-state.json'), reg = join(c.stateRoot, 'registrations.json')
if (existsSync(reg)) Object.assign(d.releases, JSON.parse(read(reg)))
const state = existsSync(statePath) ? JSON.parse(read(statePath)) : { releaseId: d.initialReleaseId }, old = d.releases[state.releaseId]
if (!old?.version || d.targetId !== c.targetId) throw Error('Baseline enrollment missing')
const publisherKeys = Object.fromEntries(Object.entries(c.publisherPublicKeyFiles).map(([id, file]) => [id, read(file)]))
const source = new GitHubUpdateSource(join(c.stateRoot, 'approval-downloads'), { publisherKeys, channel: c.channel || 'stable' }, old.version)
const prepared = await source.prepare(id)
if (prepared.state !== 'prepared') throw Error('Release preparation failed')
const m = verifyUpstreamManifest(JSON.parse(readFileSync(`${prepared.packagePath}.manifest.json`, 'utf8')), { publisherKeys }, prepared.version, old.version)
if (upstreamReleaseId(m) !== id) throw Error('Exact release changed')
const artifact = m.artifacts.find(a => a.platform === 'linux' && a.arch === process.arch)
if (!artifact) throw Error('No matching architecture')
const binding = { proposalId: `upstream-${id}`, patchHash: artifact.sha256, baselineHash: old.release.sourceHash, candidateHash: repairHash(m), probeId: o.probeId, targetId: c.targetId }
const ticket = { ...binding, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 9 * 60_000 }
const grantFile = join(c.grantsRoot, `${id}.json`)
if (existsSync(grantFile)) throw Error('Existing grant retained; do not change an active attempt')
writeUpdateState(join(o.authorityGrantsRoot, `${binding.patchHash}.json`), { binding, expiresAt: ticket.expiresAt, holderNodeId: o.holderNodeId, leaseEpoch: o.leaseEpoch })
writeUpdateState(grantFile, signRepairValue(ticket, read(o.approvalPrivateKeyFile, true)))
console.log(JSON.stringify({ releaseId: id, targetId: c.targetId, attemptId: ticket.attemptId, expiresAt: ticket.expiresAt, next: `/update deploy ${id}` }))
