// Test the BUILT image, not host dist. Only this fixture's full container ID is
// cleaned up. The single read-only bind is public test code, never runtime data.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw Error('Exact locally inspected image ID required')
const root = resolve('.nova-data/update-image-qa', randomUUID()); mkdirSync(root, { recursive: true })
const report = { sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), image,
    sourceDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    evidenceClass: 'actual-packaged-daemon-start-authenticated-REST-CLI-stop-isolated-loopback-provider', passed: false }
let id
try {
    const metadata = JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0]
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version
    if (metadata.Id !== image || metadata.Config?.Labels?.['org.opencontainers.image.version'] !== version
        || metadata.Config?.Labels?.['org.opencontainers.image.revision'] !== report.sourceRevision) throw Error('Package provenance mismatch')
    id = execFileSync('docker', ['create', '--name', `xaventra-package-qa-${randomUUID()}`, '--network', 'none', '--read-only',
        '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '3g', '--cpus', '2', '--pids-limit', '256',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=768m,uid=1000,gid=1000', '--tmpfs', '/runtime:rw,nosuid,nodev,size=64m,uid=1000,gid=1000',
        '--mount', `type=bind,source=${resolve('scripts/check-daemon-lifecycle.mjs')},target=/app/scripts/check-daemon-lifecycle.mjs,readonly`,
        '--entrypoint', '/usr/local/bin/node', image, '/app/scripts/check-daemon-lifecycle.mjs', '--mesh-idle-peer'], { encoding: 'utf8', timeout: 30_000 }).trim()
    if (!/^[a-f0-9]{64}$/.test(id)) { id = undefined; throw Error('Fixture identity unknown; no guessed cleanup') }
    const stdout = execFileSync('docker', ['start', '--attach', id], { encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })
    report.lifecycle = JSON.parse(stdout)
    const state = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0].State
    if (state.Running || state.ExitCode !== 0 || !report.lifecycle.passed || report.lifecycle.version !== version) throw Error('Packaged lifecycle not verified')
    report.passed = true
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally {
    if (id) try { execFileSync('docker', ['rm', '--force', id], { stdio: 'pipe', timeout: 30_000 }) }
    catch (e) { report.passed = false; report.cleanupError = String(e); process.exitCode = 1 }
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
}
