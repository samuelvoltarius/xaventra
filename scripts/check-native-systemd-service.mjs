// Opt-in disposable native fixture. No existing service is selected or modified.
// Bundle with esbuild for an isolated Linux test host; retains unit and evidence.
import { NativeSystemdService } from '../src/doctor/native-systemd-service.ts'
import { NativeReleaseSelection } from '../src/doctor/native-release-selection.ts'
import { verifyNativeServiceProcess } from '../src/doctor/native-process-identity.ts'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import assert from 'node:assert/strict'
if (process.platform !== 'linux' || process.getuid() !== 0 || process.env.XAVENTRA_NATIVE_FIXTURE !== '1') throw Error('Explicit disposable Linux root fixture opt-in required')
const name = `xaventra-updater-fixture-${randomUUID()}`, unit = `${name}.service`
const root = `/var/lib/${name}`, fragmentPath = `/etc/systemd/system/${unit}`, executable = realpathSync(process.execPath)
if (!/^\/[a-zA-Z0-9/_.-]+$/.test(executable)) throw Error('Fixture executable path cannot be represented safely')
mkdirSync(root, { mode: 0o755 })
const script = `${root}/service.mjs`, ready = `/run/${name}/ready`
writeFileSync(script, `import fs from 'node:fs';process.on('SIGTERM',()=>process.exit(0));fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`, { flag: 'wx', mode: 0o644 })
const fixtureUid=Number(execFileSync('/usr/bin/id',['-u','nobody'],{encoding:'utf8'}).trim()),fixtureGid=Number(execFileSync('/usr/bin/id',['-g','nobody'],{encoding:'utf8'}).trim())
const text = `[Unit]\nDescription=Isolated Xaventra updater acceptance fixture\n[Service]\nType=exec\nUser=${fixtureUid}\nGroup=${fixtureGid}\nExecStart=${executable} ${script}\nWorkingDirectory=${root}\nRestart=no\nKillMode=control-group\nTimeoutStopSec=10\nRuntimeMaxSec=120\nRuntimeDirectory=${name}\nNoNewPrivileges=true\nPrivateNetwork=true\nProtectSystem=strict\nProtectHome=true\n`
writeFileSync(fragmentPath, text, { flag: 'wx', mode: 0o644 })
const ctl = args => execFileSync('/usr/bin/systemctl', args, { timeout: 20_000, stdio: 'pipe' })
const hash = b => createHash('sha256').update(b).digest('hex')
const cmdId=flag=>execFileSync('/usr/bin/id',[flag,'nobody'],{encoding:'utf8',timeout:5000}).trim()
const enrollment = { unit, fragmentPath, fragmentHash: hash(text), process: {
    runtimeAccount:{uid:Number(cmdId('-u')),gid:Number(cmdId('-g'))},
    executable, executableHash: hash(readFileSync(executable)), argv: [executable, script], cwd: root, cgroup: `0::/system.slice/${unit}\n`,
} }
const service = new NativeSystemdService(enrollment)
let stopped = false
try {
    ctl(['daemon-reload'])
    assert.equal((await service.inspect()).cleanStopped, true)
    await service.start(async () => true) // Explicit fixture authority, NOT a production lease.
    const deadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    assert.equal(readFileSync(ready, 'utf8'), 'ready')
    const running = await service.inspect(); assert.equal(running.running, true)
    const mutableEnrollment = structuredClone(enrollment)
    const fixedService = new NativeSystemdService(mutableEnrollment)
    mutableEnrollment.unit = 'not-enrolled-fixture.service'
    mutableEnrollment.process.argv[1] = `${root}/not-enrolled.mjs`
    mutableEnrollment.process.runtimeAccount.uid++
    assert.equal((await fixedService.inspect()).pid, running.pid)
    const wrongAccount=new NativeSystemdService({...enrollment,process:{...enrollment.process,runtimeAccount:{uid:enrollment.process.runtimeAccount.uid+1,gid:enrollment.process.runtimeAccount.gid}}})
    await assert.rejects(wrongAccount.stop(async()=>true),/account enrollment mismatch/)
    await assert.rejects(()=>verifyNativeServiceProcess(running.pid,{...enrollment.process,runtimeAccount:{uid:enrollment.process.runtimeAccount.uid+1,gid:enrollment.process.runtimeAccount.gid}}),/account identity mismatch/)
    assert.equal((await service.inspect()).pid,running.pid)
    const wrong = new NativeSystemdService({ ...enrollment, process: { ...enrollment.process, executableHash: '0'.repeat(64) } })
    await assert.rejects(wrong.stop(async () => true), /hash mismatch/)
    assert.equal((await service.inspect()).pid, running.pid)
    await service.stop(async () => true); stopped = true
    assert.equal((await service.inspect()).cleanStopped, true)
    const nextScript = `${root}/next.mjs`
    writeFileSync(nextScript, readFileSync(script, 'utf8').replace("'ready'", "'next'"), { flag: 'wx', mode: 0o644 })
    const nextText = text.replace(` ${script}\n`, ` ${nextScript}\n`), nextProcess = { ...enrollment.process, argv: [executable, nextScript] }
    const oldUnit = `${root}/old.unit`, nextUnit = `${root}/next.unit`
    writeFileSync(oldUnit, text, { flag: 'wx', mode: 0o600 }); writeFileSync(nextUnit, nextText, { flag: 'wx', mode: 0o600 })
    const selectionConfig = { root, unit, fragmentPath, releases: {
        old: { unitFile: oldUnit, unitHash: hash(text), process: enrollment.process },
        next: { unitFile: nextUnit, unitHash: hash(nextText), process: nextProcess },
    } }
    const selection = new NativeReleaseSelection(selectionConfig, async () => true)
    const changedAuthority = new NativeReleaseSelection(selectionConfig, async t => {
        t.attemptId = `repair-${randomUUID()}`
        return true
    })
    selectionConfig.releases.next.unitFile = `${root}/not-enrolled.unit`
    const ticket = { attemptId: `repair-${randomUUID()}`, expiresAt: Date.now() + 60_000, targetId: 'fixture', proposalId: 'upstream-fixture', probeId: 'fixture', patchHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64), candidateHash: 'c'.repeat(64) }
    const originalTicket = structuredClone(ticket)
    await assert.rejects(changedAuthority.select('next', 'old', ticket), /selection fenced/)
    assert.deepEqual(ticket, originalTicket)
    assert.equal(readFileSync(fragmentPath, 'utf8'), text)
    await selection.select('next', 'old', ticket)
    await selection.select('next', 'old', ticket)
    const next = new NativeSystemdService({ ...enrollment, fragmentHash: hash(nextText), process: nextProcess })
    stopped = false; await next.start(async () => true)
    const nextDeadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < nextDeadline) await new Promise(r => setTimeout(r, 50))
    assert.equal(readFileSync(ready, 'utf8'), 'next')
    await next.stop(async () => true); stopped = true
    await selection.select('old', 'next', ticket)
    assert.equal((await service.inspect()).cleanStopped, true)
    const report = { evidenceClass: 'real-disposable-systemd-selection-lifecycle-not-production-update',
        positiveLifecycle: true, callerEnrollmentMutationIsolated:true, enrolledAccountObserved:true, wrongAccountRejectedBeforeStop:true, wrongExecutableRejectedBeforeStop: true, selectedNextAndReplayed: true, nextProgramObserved: true, originalUnitRestored: true, fixtureStopped: true, root, unit }
    report.selectionEnrollmentMutationIsolated = true
    report.changedAuthorityTicketRejected = true
    writeFileSync(`${root}/evidence.json`, JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(report))
} catch (error) {
    writeFileSync(`${root}/failure.json`, JSON.stringify({ error: String(error), unit }), { mode: 0o600 })
    throw error
} finally {
    if (!stopped) ctl(['stop', unit]) // Only the unique fixture created by this process.
}
