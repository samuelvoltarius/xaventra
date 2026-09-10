// Real Linux Docker engine + HTTP release fixture + compiled /update command.
// Fixture issuer/oracle/drain do NOT attest production Mesh fencing or live GHCR.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, randomUUID, createHash, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitHubUpdateSource } from '../dist/core/github-update.js'
import { encodeUpdatePackage, decodeUpdatePackage } from '../dist/core/update-package.js'
import { upstreamUpdateCommand } from '../dist/core/upstream-update-command.js'
import { updateControllerRequest } from '../dist/core/update-controller-client.js'
import { createUpdateControllerServer } from '../dist/core/update-controller-server.js'
import { UpdateActivationController } from '../dist/core/update-activation.js'
import { DockerRepairDriver, localDockerRepairEngine } from '../dist/doctor/docker-repair-driver.js'
import { createPublishedRepairContainer } from '../dist/doctor/docker-repair-publication.js'
import { createDockerRepairStateCloner } from '../dist/doctor/docker-repair-state.js'
import { createHttpRepairProbe } from '../dist/doctor/repair-controller-server.js'
import { repairHash, signRepairValue } from '../dist/doctor/repair-activation.js'
import { writeUpdateState } from '../dist/core/update-store.js'

const image = process.env.XAVENTRA_REPAIR_SANDBOX_IMAGE
if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw Error('Explicit pinned disposable fixture image required')
const root = resolve('.nova-data/container-update-qa', randomUUID()); mkdirSync(root, { recursive: true })
const engine = localDockerRepairEngine(), ids = [], volumes = [], servers = []
const report = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    evidenceClass: 'real-Docker-HTTP-release-fixture-not-live-GitHub-GHCR-or-production-fencing', checks: [] }
const key = () => { const k = generateKeyPairSync('ed25519'); return { privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }
const listen = async server => { servers.push(server); await new Promise(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}` }
const record = async r => { ids.push(r.containerId); const info = await engine.call('GET', `/containers/${r.containerId}/json`); for (const m of info.Mounts || []) if (m.Type === 'volume') volumes.push(m.Name); return info }
const code = `const fs=require('node:fs');if(!fs.existsSync('/runtime/fact'))fs.writeFileSync('/runtime/fact','corrected user fact');if(process.env.BAD==='yes')fs.writeFileSync('/runtime/fact','candidate damage');const server=require('node:http').createServer((q,s)=>s.end(process.env.BAD==='yes'?'BAD':'OK')).listen(8181,'0.0.0.0');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`
const template = bad => ({ Image: image, User: '1000:1000', Entrypoint: ['/usr/local/bin/node'], Cmd: ['-e', code], Env: [`BAD=${bad ? 'yes' : 'no'}`],
    ExposedPorts: { '8181/tcp': {} }, Healthcheck: { Test: ['CMD', '/usr/local/bin/node', '-e', "fetch('http://127.0.0.1:8181').then(()=>process.exit(0)).catch(()=>process.exit(1))"], Interval: 1_000_000_000, Timeout: 1_000_000_000, Retries: 3 },
    HostConfig: { NetworkMode: 'bridge', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 32, RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } }, PortBindings: { '8181/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] }, Mounts: [{ Type: 'volume', Source: 'replaced-by-fresh-volume', Target: '/runtime' }] } })
try {
    for (const bad of [false, true]) {
        const scenario = join(root, bad ? 'rollback' : 'install'); mkdirSync(scenario)
        const publisher = key(), approval = key(), receipt = key(), targetId = `fixture-${randomUUID()}`
        const payload = { schema: 1, kind: 'docker', repository: 'samuelvoltarius/xaventra', version: '2.79.0', commit: 'a'.repeat(40), platform: 'linux', arch: process.arch, image: `ghcr.io/samuelvoltarius/xaventra@${image}` }
        const bytes = encodeUpdatePackage(payload), name = `xaventra-2.79.0-linux-${process.arch}.tar.gz`
        const manifest = { schema: 1, repository: payload.repository, version: payload.version, commit: payload.commit, minUpdater: '2.78.22', artifacts: [{ name, platform: 'linux', arch: process.arch, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
        const signedManifest = { keyId: 'fixture', payload: manifest, signature: sign(null, Buffer.from(JSON.stringify(manifest)), publisher.privateKey).toString('base64') }
        const releases = [{ tag_name: 'v2.79.0', draft: false, prerelease: false, assets: ['xaventra-update.json', name].map(n => ({ name: n, state: 'uploaded', size: n === name ? bytes.length : 0, browser_download_url: `https://github.com/${payload.repository}/releases/download/v2.79.0/${n}` })) }]
        const fixtureUrl = await listen(createServer((q, s) => { s.end(q.url.startsWith('/repos/') ? JSON.stringify(releases) : q.url.endsWith('.json') ? JSON.stringify(signedManifest) : bytes) }))
        const fixtureFetch = (url, options) => fetch(fixtureUrl + new URL(url).pathname, options)
        const source = new GitHubUpdateSource(join(scenario, 'runtime-download'), { publisherKeys: { fixture: publisher.publicKey } }, '2.78.22', { platform: 'linux', arch: process.arch }, fixtureFetch)
        const available = await source.check(); assert.equal(available.state, 'available')
        const binding = { proposalId: `upstream-${available.releaseId}`, patchHash: manifest.artifacts[0].sha256, baselineHash: 'b'.repeat(64), candidateHash: repairHash(manifest), probeId: 'acceptance', targetId }
        const ticket = { ...binding, attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 240_000 }
        const artifact = { version: 1, binding, imageId: image, baseImageId: image, compiledHash: 'c'.repeat(64), createdAt: Date.now() }
        const portReservation = createServer(); await new Promise(r => portReservation.listen(0, '127.0.0.1', r))
        const fixedPort = String(portReservation.address().port); await new Promise(r => portReservation.close(r))
        const oldTemplate = template(false); oldTemplate.HostConfig.PortBindings['8181/tcp'][0].HostPort = fixedPort
        const old = await createPublishedRepairContainer(engine, { ...artifact, releaseId: 'old', previousReleaseId: 'older', sourceHash: binding.baselineHash }, oldTemplate)
        await record(old); await engine.call('POST', `/containers/${old.containerId}/start`)
        let info
        for (let i = 0; i < 100; i++) { info = await engine.call('GET', `/containers/${old.containerId}/json`); if (info.State.Health?.Status === 'healthy') break; await new Promise(r => setTimeout(r, 100)) }
        assert.equal(info.State.Health.Status, 'healthy')
        // Enroll immutable configuration after initial operator-owned launch.
        const { dockerRepairConfigHash } = await import('../dist/doctor/docker-repair-driver.js'); old.configHash = dockerRepairConfigHash(info)
        const nextTemplate = template(bad); nextTemplate.HostConfig.PortBindings['8181/tcp'][0].HostPort = info.NetworkSettings.Ports['8181/tcp'][0].HostPort
        let maintenance = false, currentState, candidate, completions = 0
        const driver = new DockerRepairDriver({ targetId, initialReleaseId: 'old', releases: { old }, catalog: {}, hasAuthority: async () => true,
            loadState: () => currentState, saveState: state => { currentState = state; writeUpdateState(join(scenario, 'runtime-state.json'), state) },
            stateReady: createDockerRepairStateCloner({ engine, helperImageId: image, quiescent: async () => maintenance }),
            prepareRelease: async () => {
                // Separate trusted download; runtime cache path is NOT accepted.
                const trusted = new GitHubUpdateSource(join(scenario, 'controller-download'), { publisherKeys: { fixture: publisher.publicKey } }, '2.78.22', { platform: 'linux', arch: process.arch }, fixtureFetch)
                const staged = await trusted.prepare(available.releaseId); assert.equal(staged.state, 'prepared')
                assert.equal(decodeUpdatePackage(readFileSync(staged.packagePath), manifest, process.arch).image, payload.image)
                candidate = await createPublishedRepairContainer(engine, { ...artifact, releaseId: available.releaseId, previousReleaseId: 'old', sourceHash: binding.candidateHash }, nextTemplate)
                await record(candidate); return candidate
            } }, engine)
        driver.beginMaintenance = async () => { maintenance = true }
        const probe = createHttpRepairProbe([{ id: 'acceptance', targetId, url: `http://127.0.0.1:${nextTemplate.HostConfig.PortBindings['8181/tcp'][0].HostPort}`, expectedStatus: 200, expectedBodySha256: createHash('sha256').update('OK').digest('hex') }], driver)
        const activation = new UpdateActivationController(join(scenario, 'activation'), approval.publicKey, driver, async release => {
            const observation = await probe('acceptance', targetId, randomUUID()); assert.equal(observation.state, 'healthy'); assert.equal(observation.releaseId, release); return observation.fingerprint
        }, async () => { completions++; maintenance = false })
        const signed = signRepairValue(ticket, approval.privateKey), tokenFile = join(scenario, 'client-token'); writeFileSync(tokenFile, 'fixture-' + 'x'.repeat(40))
        const controller = createUpdateControllerServer({ root: join(scenario, 'jobs'), targetId, token: readFileSync(tokenFile, 'utf8'), receiptPrivateKey: receipt.privateKey, authorize: async id => id === available.releaseId,
            deploy: () => activation.deploy(signed, {}) })
        const socketPath = `/tmp/xaventra-update-qa-${randomUUID()}.sock`
        servers.push(controller); await new Promise(r => controller.listen(socketPath, r))
        const client = { socketPath, targetId, tokenFile, receiptPublicKey: receipt.publicKey }
        const rpc = (operation, id) => updateControllerRequest(operation, id, client)
        const reply = await upstreamUpdateCommand(`deploy ${available.releaseId}`, 'owner', source, rpc)
        assert.ok(reply.includes('angenommen – noch nicht installiert'))
        let job
        for (let i = 0; i < 400; i++) { job = await rpc('status', available.releaseId); if (['installed', 'rolled-back', 'blocked'].includes(job.state)) break; await new Promise(r => setTimeout(r, 150)) }
        assert.equal(job.state, bad ? 'rolled-back' : 'installed', JSON.stringify(job)); assert.equal(completions, 1); assert.equal(maintenance, false)
        const activeId = bad ? old.containerId : candidate.containerId
        assert.equal((await engine.call('GET', `/containers/${activeId}/json`)).State.Running, true)
        assert.equal((await engine.call('GET', `/containers/${bad ? candidate.containerId : old.containerId}/json`)).State.Running, false)
        assert.equal(execFileSync('docker', ['exec', activeId, '/usr/local/bin/node', '-e', "process.stdout.write(require('fs').readFileSync('/runtime/fact','utf8'))"], { encoding: 'utf8' }), 'corrected user fact')
        const previousCount = ids.length; await rpc('deploy', available.releaseId); assert.equal(ids.length, previousCount); assert.equal(completions, 1)
        report.checks.push({ id: bad ? 'failed-canary-real-rollback-restored-user-state' : 'signed-download-slash-detached-controller-real-container-switch-state-clone', passed: true })
        report.checks.push({ id: `${bad ? 'rollback' : 'install'}-duplicate-request-no-second-switch`, passed: true })
    }
} catch (error) { report.checks.push({ id: 'failure', passed: false, error: String(error) }); process.exitCode = 1 }
finally {
    for (const server of servers) await new Promise(r => server.close(() => r()))
    for (const id of ids) try { await engine.call('DELETE', `/containers/${id}?force=true`) } catch (e) { report.checks.push({ id: 'container-cleanup', passed: false, error: String(e) }); process.exitCode = 1 }
    for (const v of volumes) try { await engine.call('DELETE', `/volumes/${v}`) } catch (e) { report.checks.push({ id: 'volume-cleanup', passed: false, error: String(e) }); process.exitCode = 1 }
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
}
