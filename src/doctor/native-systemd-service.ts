import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readProtectedControllerFile } from './repair-controller-files.js'
import { verifyNativeServiceProcess, type NativeProcessProfile } from './native-process-identity.js'
const properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Result', 'ExecMainCode', 'ExecMainStatus', 'FragmentPath', 'DropInPaths', 'Restart', 'KillMode', 'NeedDaemonReload']
export interface SystemdObservation { running: boolean; cleanStopped: boolean; pid: number }
export interface SystemdTransport {
    run(args: string[]): Promise<string>
    readUnit(path: string): string
}
/** Fixed executable and bounded argv-only invocation. Never a shell command. */
export function localSystemdTransport(): SystemdTransport {
    const exec = promisify(execFile)
    return {
        readUnit: path => readProtectedControllerFile(path),
        run: async args => {
            if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('Native systemd controller requires Linux root')
            const result = await exec('/usr/bin/systemctl', args, { timeout: 35_000, maxBuffer: 32 * 1024,
                env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' } })
            return result.stdout
        },
    }
}
/** One protected enrolled unit only. This is the service-control component, not
 * publication, release selection, process binary identity or snapshot fencing.
 * Those independent gates must be wired by the full native operations adapter. */
export class NativeSystemdService {
    constructor(private enrollment: { unit: string; fragmentPath: string; fragmentHash: string; process?: NativeProcessProfile },
        private transport: SystemdTransport = localSystemdTransport(),
        private verifyProcess: (pid: number, profile: NativeProcessProfile) => Promise<void> = verifyNativeServiceProcess) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.service$/.test(enrollment.unit)
            || enrollment.fragmentPath !== `/etc/systemd/system/${enrollment.unit}`
            || !/^[a-f0-9]{64}$/.test(enrollment.fragmentHash)) throw Error('Explicit native systemd enrollment required')
    }
    async inspect(): Promise<SystemdObservation> {
        const before = await this.metadata()
        if (before.running) {
            if (!this.enrollment.process) throw Error('Native process enrollment missing')
            await this.verifyProcess(before.pid, this.enrollment.process)
            const after = await this.metadata()
            if (!after.running || after.pid !== before.pid) throw Error('Systemd process changed during verification')
        }
        return before
    }
    private async metadata(): Promise<SystemdObservation> {
        const raw = await this.transport.run(['show', this.enrollment.unit, '--no-pager', ...properties.map(p => `--property=${p}`)])
        if (Buffer.byteLength(raw) > 32 * 1024) throw Error('Systemd observation budget exceeded')
        const fields: Record<string, string> = Object.create(null)
        for (const line of raw.trimEnd().split('\n')) {
            const at = line.indexOf('='), key = line.slice(0, at)
            if (at < 1 || !properties.includes(key) || Object.hasOwn(fields, key)) throw Error('Ambiguous systemd observation')
            fields[key] = line.slice(at + 1)
        }
        if (properties.some(p => !Object.hasOwn(fields, p)) || fields.Id !== this.enrollment.unit || fields.LoadState !== 'loaded'
            || fields.FragmentPath !== this.enrollment.fragmentPath || fields.DropInPaths !== '' || fields.NeedDaemonReload !== 'no'
            || fields.Restart !== 'no' || fields.KillMode !== 'control-group') throw Error('Systemd identity or exclusive restart ownership mismatch')
        const content = this.transport.readUnit(this.enrollment.fragmentPath)
        if (createHash('sha256').update(content).digest('hex') !== this.enrollment.fragmentHash) throw Error('Systemd unit content changed')
        if (!/^\d+$/.test(fields.MainPID)) throw Error('Invalid systemd PID')
        const pid = Number(fields.MainPID)
        if (!Number.isSafeInteger(pid)) throw Error('Invalid systemd PID')
        const running = fields.ActiveState === 'active' && fields.SubState === 'running' && pid > 0
        const stopped = fields.ActiveState === 'inactive' && fields.SubState === 'dead' && pid === 0
        if (!running && !stopped) throw Error('Systemd service transition or failed state; reconcile before retry')
        const cleanStopped = stopped && fields.Result === 'success' && fields.ExecMainStatus === '0' && ['0', '1'].includes(fields.ExecMainCode)
        return { running, cleanStopped, pid }
    }
    async stop(authorized: () => Promise<boolean>): Promise<void> {
        if (!await authorized()) throw Error('Systemd stop fenced')
        const before = await this.inspect()
        if (!before.running) throw Error('Systemd stop requires known running baseline')
        if (!await authorized()) throw Error('Systemd stop fenced')
        await this.transport.run(['stop', this.enrollment.unit, '--no-ask-password'])
        if (!await authorized()) throw Error('Systemd authority lost after stop')
        const after = await this.inspect()
        if (after.running || !after.cleanStopped) throw Error('Systemd clean process exit not proven')
    }
    async start(authorized: () => Promise<boolean>): Promise<void> {
        if (!await authorized()) throw Error('Systemd start fenced')
        const before = await this.inspect()
        if (before.running || !before.cleanStopped) throw Error('Systemd start requires clean stopped state')
        if (!await authorized()) throw Error('Systemd start fenced')
        await this.transport.run(['start', this.enrollment.unit, '--no-ask-password'])
        if (!await authorized()) throw Error('Systemd authority lost after start')
        if (!(await this.inspect()).running) throw Error('Systemd startup not confirmed')
    }
}
