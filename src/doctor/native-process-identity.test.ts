import { it, expect, vi } from 'vitest'
import { verifyNativeProcess, type ProcessIdentityReader } from './native-process-identity.js'
function fixture() {
    const expected = { pid: 123, startTicks: '456', executable: '/opt/enrolled/node', executableHash: 'a'.repeat(64), argv: ['/opt/enrolled/node', '/opt/enrolled/app.js'], cwd: '/state/enrolled', cgroup: '0::/system.slice/enrolled.service\n' }
    const stat = (ticks = '456') => Buffer.from(`123 (name ) with spaces) S ${Array(18).fill('0').join(' ')} ${ticks} 0`)
    const reader: ProcessIdentityReader = { read: vi.fn(async path => path.endsWith('/stat') ? stat() : path.endsWith('/cmdline') ? Buffer.from(expected.argv.join('\0') + '\0') : Buffer.from(expected.cgroup)),
        link: vi.fn(async path => path.endsWith('/exe') ? expected.executable : expected.cwd), hash: vi.fn(async () => expected.executableHash) }
    return { expected, reader, stat }
}
it('verifies bounded identity without ever reading environ', async () => {
    const f = fixture(); await verifyNativeProcess(f.expected, f.reader)
    expect(vi.mocked(f.reader.read).mock.calls.every(([p]) => !p.includes('environ'))).toBe(true)
})
it.each(['path', 'hash', 'argv', 'cgroup', 'incarnation'])('rejects changed %s', async kind => {
    const f = fixture()
    if (kind === 'path') vi.mocked(f.reader.link).mockResolvedValue('/other')
    if (kind === 'hash') vi.mocked(f.reader.hash).mockResolvedValue('b'.repeat(64))
    const read = f.reader.read
    if (kind === 'argv' || kind === 'cgroup') f.reader.read = async (p, l) => p.endsWith(kind === 'argv' ? '/cmdline' : '/cgroup') ? Buffer.from('other\0') : read(p, l)
    if (kind === 'incarnation') { let n = 0; f.reader.read = async (p, l) => p.endsWith('/stat') ? f.stat(++n === 1 ? '456' : '789') : read(p, l) }
    await expect(verifyNativeProcess(f.expected, f.reader)).rejects.toThrow()
})
it('rejects missing process and malformed enrollment', async () => {
    const f = fixture(); vi.mocked(f.reader.read).mockRejectedValue(Error('ENOENT'))
    await expect(verifyNativeProcess(f.expected, f.reader)).rejects.toThrow()
    await expect(verifyNativeProcess({ ...f.expected, pid: -1 }, f.reader)).rejects.toThrow('enrolled')
})
