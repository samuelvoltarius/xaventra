import { it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { NativeSystemdService } from './native-systemd-service.js'
const unit = 'xaventra-fixture.service', fragmentPath = `/etc/systemd/system/${unit}`, content = '[Service]\nRestart=no\n'
const enrollment = { unit, fragmentPath, fragmentHash: createHash('sha256').update(content).digest('hex'),
    process: { executable: '/opt/fixture/node', executableHash: 'a'.repeat(64), argv: ['/opt/fixture/node','/opt/fixture/app.js'], cwd: '/fixture', cgroup: '0::/system.slice/xaventra-fixture.service\n' } }
function fixture(overrides = {}) {
    const fields = { Id: unit, LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '123', Result: 'success',
        ExecMainCode: '0', ExecMainStatus: '0', FragmentPath: fragmentPath, DropInPaths: '', Restart: 'no', KillMode: 'control-group', NeedDaemonReload: 'no', User:'1001',Group:'1002',DynamicUser:'no',...overrides }
    const transport = { readUnit: vi.fn(() => content), run: vi.fn(async (args: string[]) => {
        if (args[0] === 'stop') Object.assign(fields, { ActiveState: 'inactive', SubState: 'dead', MainPID: '0' })
        if (args[0] === 'start') Object.assign(fields, { ActiveState: 'active', SubState: 'running', MainPID: '456' })
        return args[0] === 'show' ? Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' : ''
    }) }
    const verifyProcess = vi.fn(async () => {})
    return { fields, transport, verifyProcess, service: new NativeSystemdService(enrollment, transport, verifyProcess) }
}
it('controls only the enrolled unit with fixed argv and verifies exit/start', async () => {
    const f = fixture(); await f.service.stop(async () => true); await f.service.start(async () => true)
    expect((await f.service.inspect()).pid).toBe(456)
    expect(f.transport.run.mock.calls.filter(([a]) => a[0] !== 'show').map(([a]) => a)).toEqual([
        ['stop', unit, '--no-ask-password'], ['start', unit, '--no-ask-password'],
    ])
})
it.each([{ Restart: 'on-failure' }, { DropInPaths: '/tmp/override.conf' }, { NeedDaemonReload: 'yes' },
    { MainPID: 'NaN' }, { ActiveState: 'activating' }, { FragmentPath: '/tmp/other.service' }, { KillMode: 'process' }])('rejects unsafe observation %j before mutation', async changes => {
    const f = fixture(changes); await expect(f.service.stop(async () => true)).rejects.toThrow()
    expect(f.transport.run.mock.calls.every(([a]) => a[0] === 'show')).toBe(true)
})
it('refuses modified unit content', async () => {
    const f = fixture(); f.transport.readUnit.mockReturnValue('modified')
    await expect(f.service.inspect()).rejects.toThrow('content')
})
it('does not mutate after authority expires during observation', async () => {
    const f = fixture(), auth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(f.service.stop(auth)).rejects.toThrow('fenced')
    expect(f.transport.run.mock.calls.every(([a]) => a[0] === 'show')).toBe(true)
})
it('rejects duplicate observation properties', async () => {
    const f = fixture(), raw = await f.transport.run(['show'])
    f.transport.run.mockResolvedValue(raw + 'MainPID=0\n')
    await expect(f.service.inspect()).rejects.toThrow('Ambiguous')
})
it('rejects argument injection and template units at enrollment', () => {
    for (const unit of ['--all', '../evil.service', 'x@y.service', 'a.service;reboot'])
        expect(() => new NativeSystemdService({ ...enrollment, unit })).toThrow()
})
it('rejects a running service without immutable process enrollment', async () => {
    const f = fixture(), { process, ...incomplete } = enrollment
    await expect(new NativeSystemdService(incomplete, f.transport).inspect()).rejects.toThrow('enrollment missing')
})
it('verifies enrolled process identity before any stop operation', async () => {
    const f = fixture(); f.verifyProcess.mockRejectedValue(Error('wrong executable'))
    await expect(f.service.stop(async () => true)).rejects.toThrow('wrong executable')
    expect(f.transport.run.mock.calls.every(([a]) => a[0] === 'show')).toBe(true)
})
it('rejects a PID switch while verifying process identity', async () => {
    const f = fixture(); f.verifyProcess.mockImplementation(async () => { f.fields.MainPID = '999' })
    await expect(f.service.inspect()).rejects.toThrow('changed during')
})
it('rejects wrong process after start, without claiming success', async () => {
    const f = fixture({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0' })
    f.verifyProcess.mockRejectedValue(Error('wrong executable'))
    await expect(f.service.start(async () => true)).rejects.toThrow('wrong executable')
    expect(f.transport.run.mock.calls.filter(([a]) => a[0] === 'start')).toHaveLength(1)
})
it.each([{User:'0'},{Group:'0'},{DynamicUser:'yes'},{User:'named-user'}])('refuses wrong runtime account before starting: %j',async changes=>{
    const f=fixture({ActiveState:'inactive',SubState:'dead',MainPID:'0',...changes})
    const service=new NativeSystemdService({...enrollment,process:{...enrollment.process,runtimeAccount:{uid:1001,gid:1002}}},f.transport,f.verifyProcess)
    await expect(service.start(async()=>true)).rejects.toThrow('account enrollment mismatch')
    expect(f.transport.run.mock.calls.every(([args])=>args[0]==='show')).toBe(true)
})
it('does not let caller mutation retarget an enrolled service after construction', async () => {
    const f = fixture(), supplied = structuredClone(enrollment)
    const service = new NativeSystemdService(supplied, f.transport, f.verifyProcess)
    supplied.unit = 'other.service'
    supplied.fragmentPath = '/etc/systemd/system/other.service'
    supplied.process.argv[1] = '/opt/fixture/substituted.js'
    await service.stop(async () => true)
    expect(f.transport.run.mock.calls.every(([args]) => args[1] === unit)).toBe(true)
    expect(f.verifyProcess.mock.calls[0][1]).toEqual(enrollment.process)
})
