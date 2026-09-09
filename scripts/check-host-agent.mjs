// Real Docker acceptance with an explicitly selected disposable fixture image.
// Never stops, restarts or changes any pre-existing host container.
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDockerHostAgent, hostDockerEngine, permitBytes } from '../dist/host/docker-agent.js'

const image = process.env.XAVENTRA_HOST_TEST_IMAGE
if (!image) throw Error('Explicit XAVENTRA_HOST_TEST_IMAGE required (must contain node); no automatic pull')
const reportRoot = process.env.XAVENTRA_HOST_QA_DIR
if (reportRoot) mkdirSync(reportRoot, { recursive: true })
const root = mkdtempSync(join(reportRoot || tmpdir(), 'xaventra-host-live-'))
const token = randomBytes(32).toString('hex'), keys = generateKeyPairSync('ed25519')
const socketPath = join(root, 'agent.sock'), stateDir = join(root, 'state')
const fixture = execFileSync('docker', ['run', '--pull', 'never', '-d', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '64', '--entrypoint', 'node', image, '-e', 'console.log("fixture-log"); setInterval(()=>{},1000)'], { encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{64}$/.test(fixture)) throw Error('Unexpected fixture identity')
const options = { nodeId: 'fixture-host', clientId: 'fixture-client', token, stateDir, approvalPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), allowedContainerIds: [fixture] }
let server = createDockerHostAgent(options, hostDockerEngine())
const report = { version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), platform: process.platform, scope: 'Real local Docker/Unix socket and disposable fixture; not Telegram, production enrollment or HA', checks: {} }
const call = (op, body = {}, credential = token) => new Promise((resolve, reject) => {
    const req = request({ socketPath, agent: false, method: 'POST', path: `/v1/docker/${op}`, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } }, res => {
        let text = ''; res.on('data', c => text += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }) } catch (e) { reject(e) } })
    }); req.on('error', reject); req.setTimeout(45000, () => req.destroy(Error('fixture deadline'))); req.end(JSON.stringify(body))
})
function grant(action, id = randomBytes(16).toString('hex')) {
    const permit = { id, nodeId: 'fixture-host', clientId: 'fixture-client', containerId: fixture, action, expiresAt: Date.now() + 240000, approvedBy: 'fixture-owner' }
    return { permit, signature: sign(null, permitBytes(permit), keys.privateKey).toString('base64') }
}
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    report.checks.unauthenticatedDenied = (await call('list', {}, 'wrong')).status === 401
    const list = await call('list'); report.checks.liveInventory = list.body.containers.some(c => c.id === fixture) && Boolean(list.body.evidenceHash)
    report.checks.noEnvironmentInStatus = !JSON.stringify((await call('status', { containerId: fixture })).body).includes('Env')
    report.checks.logs = (await call('logs', { containerId: fixture, lines: 20 })).body.logs.includes('fixture-log')
    report.checks.missingApprovalDenied = !(await call('action', {})).body.success
    const stop = grant('stop'); report.checks.stop = (await call('action', stop)).body.running === false
    const restart = grant('start'); report.checks.start = (await call('action', restart)).body.running === true
    const generationBefore = JSON.parse(execFileSync('docker', ['inspect', fixture], { encoding: 'utf8' }))[0].State.StartedAt
    // A restarted agent must retain the old stop receipt, not stop the now-running fixture again.
    await new Promise(resolve => server.close(resolve))
    server = createDockerHostAgent(options, hostDockerEngine()); await new Promise(resolve => server.listen(socketPath, resolve))
    const replay = await call('action', stop)
    report.checks.restartReplaySafe = replay.body.running === false && JSON.parse(execFileSync('docker', ['inspect', fixture], { encoding: 'utf8' }))[0].State.Running
    const again = await call('action', grant('restart'))
    report.checks.restart = again.body.success === true && JSON.parse(execFileSync('docker', ['inspect', fixture], { encoding: 'utf8' }))[0].State.StartedAt !== generationBefore
    report.checks.freeExecDenied = (await call('exec', { command: 'id' })).status === 404
    report.passed = Object.values(report.checks).every(Boolean)
} catch (error) { report.error = error.message; report.passed = false }
finally {
    await new Promise(resolve => server.close(resolve))
    // Exact newly created ID only; never a name pattern, volume prune or host process kill.
    execFileSync('docker', ['rm', '-f', fixture], { stdio: 'ignore' })
    report.finishedAt = new Date().toISOString()
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, reportPath: join(root, 'report.json') }, null, 2))
    if (!report.passed) process.exitCode = 1
}
