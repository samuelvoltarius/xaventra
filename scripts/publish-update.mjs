// Called only by the protected signing job AFTER architecture builds. Does not
// load application code/plugins, run npm, or include runtime/private directories.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const [version, commit, directory, ...images] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '') || images.length !== 2) throw Error('Exact version, commit and two architecture digests required')
const key = createPrivateKey(process.env.XAVENTRA_UPDATE_PUBLISHER_KEY || '')
if (key.asymmetricKeyType !== 'ed25519' || !/^[a-zA-Z0-9._-]{1,80}$/.test(process.env.XAVENTRA_UPDATE_PUBLISHER_ID || '')) throw Error('Enrolled Ed25519 publisher required')
mkdirSync(directory, { recursive: true })
const artifacts = ['x64', 'arm64'].map((arch, i) => {
    const image = images[i]
    if (!/^ghcr\.io\/samuelvoltarius\/xaventra@sha256:[a-f0-9]{64}$/.test(image)) throw Error('Immutable canonical registry digest required')
    const payload = Buffer.from(JSON.stringify({ schema: 1, kind: 'docker', repository: 'samuelvoltarius/xaventra', version, commit, platform: 'linux', arch, image }))
    const header = Buffer.alloc(512)
    header.write('container.json'); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(payload.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263)
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    const bytes = gzipSync(Buffer.concat([header, payload, Buffer.alloc((512 - payload.length % 512) % 512 + 1024)]), { level: 9 })
    const name = `xaventra-${version}-linux-${arch}.tar.gz`
    writeFileSync(join(directory, name), bytes, { flag: 'wx' })
    return { name, platform: 'linux', arch, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
const payload = { schema: 1, repository: 'samuelvoltarius/xaventra', version, commit, minUpdater: '2.78.22', artifacts }
const signed = { keyId: process.env.XAVENTRA_UPDATE_PUBLISHER_ID, payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString('base64') }
writeFileSync(join(directory, 'xaventra-update.json'), JSON.stringify(signed, null, 2), { flag: 'wx' })
writeFileSync(join(directory, 'SHA256SUMS'), artifacts.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n', { flag: 'wx' })
console.log(JSON.stringify({ version, commit, artifacts: artifacts.map(a => a.name), publisher: signed.keyId }))
