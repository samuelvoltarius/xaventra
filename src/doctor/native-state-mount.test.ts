import { expect, it } from 'vitest'
import { verifyNativeReadOnlyMount } from './native-state-mount.js'

const profile = { path: '/state/old', namespace: 'mnt:[42]', device: '0:99', inode: '123', fsType: 'tmpfs' }
const line = '7 1 0:99 / /state/old ro,nosuid - tmpfs fixture ro,size=4096\n'
function reader(text = line) {
    return { namespace: async () => profile.namespace, mountinfo: async () => text,
        identity: async () => ({ device: profile.device, inode: profile.inode }) }
}
it('accepts an exact enrolled read-only filesystem, not a hash-only claim', async () => {
    await expect(verifyNativeReadOnlyMount(profile, reader())).resolves.toMatchObject({ mountId: '7', fileSystemReadOnly: true })
})
it.each([
    line.replace(' ro,size', ' rw,size'), // Read-only bind over writable superblock.
    line.replace(' ro,nosuid', ' rw,nosuid'),
    line.replace(' / /state', ' /subdir /state'),
    line + '8 7 0:100 / /state/old/nested rw - tmpfs other rw\n',
    line + line.replace('7 1', '9 1'),
    line.replace(' /state/old ', ' /state/oldish '),
    line.replace('0:99', '0:98'),
    line.replace('tmpfs', 'ext4'),
])('rejects incomplete, stacked, nested or mismatched mount evidence', async text => {
    await expect(verifyNativeReadOnlyMount(profile, reader(text))).rejects.toThrow()
})
it('rejects identity and namespace changes during observation', async () => {
    const r = reader(); let calls = 0
    r.namespace = async () => ++calls === 1 ? profile.namespace : 'mnt:[43]'
    await expect(verifyNativeReadOnlyMount(profile, r)).rejects.toThrow()
    const other = reader(); other.identity = async () => ({ device: '0:99', inode: '124' })
    await expect(verifyNativeReadOnlyMount(profile, other)).rejects.toThrow()
})
it('rejects unsafe profiles and oversized kernel evidence', async () => {
    await expect(verifyNativeReadOnlyMount({ ...profile, path: '/state/../old' }, reader())).rejects.toThrow()
    await expect(verifyNativeReadOnlyMount(profile, reader('x'.repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow()
})
it('rejects a mount replaced between observations', async () => {
    const r = reader(); let calls = 0
    r.mountinfo = async () => ++calls === 1 ? line : line.replace('7 1', '8 1')
    await expect(verifyNativeReadOnlyMount(profile, r)).rejects.toThrow('changed')
})
it('decodes kernel-escaped paths without treating them as shell input', async () => {
    const p = { ...profile, path: '/state/old copy' }
    await expect(verifyNativeReadOnlyMount(p, reader(line.replace('/state/old', '/state/old\\040copy')))).resolves.toMatchObject({ path:p.path })
    await expect(verifyNativeReadOnlyMount(p, reader(line.replace('/state/old', '/state/old\\999copy')))).rejects.toThrow('escape')
})
