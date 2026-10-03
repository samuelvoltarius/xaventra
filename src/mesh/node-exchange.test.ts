import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXCHANGE_MAX_BYTES, executeExchange, validExchangeRequest, validateExchangeResult } from './node-exchange.js'

const roots: string[] = []
const root = async () => { const p = await mkdtemp(join(tmpdir(), 'node-exchange-')); roots.push(p); return p }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const put = (name = 'report.md', content = 'measured result') => {
    const bytes = Buffer.from(content)
    return { operation: 'write' as const, name, base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
}
describe('node exchange', () => {
    it('validates peer inventories and receipts instead of trusting signed payloads', () => {
        const request = put()
        const receipt = { name: request.name, bytes: 15, sha256: request.sha256 }
        expect(validateExchangeResult(request, receipt)).toEqual(receipt)
        expect(validateExchangeResult({ operation: 'read', name: request.name }, { ...receipt, base64: request.base64 })).toMatchObject({ base64: request.base64 })
        for (const value of [null, { files: [{ name: '../state.json', bytes: 1 }] }, { files: [{ name: 'report.md', bytes: -1 }] }, { files: [{ name: 'report.md', bytes: 1, base64: 'private' }] }, { files: [{ name: 'report.md', bytes: 1 }, { name: 'report.md', bytes: 1 }] }]) {
            expect(() => validateExchangeResult({ operation: 'list' }, value)).toThrow()
        }
        expect(() => validateExchangeResult(request, { ...receipt, bytes: 16 })).toThrow('mismatch')
        expect(() => validateExchangeResult(request, { ...receipt, base64: request.base64 })).toThrow('invalid')
        expect(() => validateExchangeResult({ operation: 'read', name: request.name }, { ...receipt, base64: Buffer.from('different').toString('base64') })).toThrow('hash mismatch')
    })
    it('confirms bytes/hash, survives retries and refuses conflicting overwrite', async () => {
        const dir = await root()
        const receipt = await executeExchange(put(), dir)
        expect(receipt).toEqual({ name: 'report.md', bytes: 15, sha256: put().sha256 })
        expect(await readFile(join(dir, 'exchange', 'report.md'), 'utf8')).toBe('measured result')
        expect(await executeExchange(put(), dir)).toEqual(receipt)
        await expect(executeExchange(put('report.md', 'different'), dir)).rejects.toThrow('different contents')
        expect(await executeExchange({ operation: 'list' }, dir)).toEqual({ files: [{ name: 'report.md', bytes: 15 }] })
    })
    it('cannot select state, credentials, paths or malformed/oversized bodies', () => {
        for (const name of ['../report.md', '/report.md', 'C:\\report.md', '.env', 'auth.json', 'nova.config.json', 'id_ed25519.bin', 'report.md:stream', 'sub/report.md']) expect(validExchangeRequest(put(name))).toBe(false)
        expect(validExchangeRequest({ ...put(), base64: '***' })).toBe(false)
        expect(validExchangeRequest(put('report.md', 'a'.repeat(EXCHANGE_MAX_BYTES + 1)))).toBe(false)
    })
    it('rejects a forged hash without creating a destination', async () => {
        const dir = await root()
        await expect(executeExchange({ ...put(), sha256: '0'.repeat(64) }, dir)).rejects.toThrow('hash mismatch')
        expect(await executeExchange({ operation: 'list' }, dir)).toEqual({ files: [] })
    })
    it('does not commit when Main authority is lost while preparing the file', async () => {
        const dir = await root()
        await expect(executeExchange(put(), dir, async () => { throw new Error('lease lost') })).rejects.toThrow('lease lost')
        expect(await executeExchange({ operation: 'list' }, dir)).toEqual({ files: [] })
    })
    it('rejects credential contents even under an ordinary report name', async () => {
        const dir = await root()
        await expect(executeExchange(put('report.json', '{"password":"fixture-credential"}'), dir)).rejects.toThrow('secrets')
        expect(await executeExchange({ operation: 'list' }, dir)).toEqual({ files: [] })
    })
    it('rejects hardlinked files and linked exchange directories on every OS', async () => {
        const dir = await root()
        const outside = await root()
        await writeFile(join(outside, 'outside.md'), 'private')
        await mkdir(join(dir, 'exchange'))
        await link(join(outside, 'outside.md'), join(dir, 'exchange', 'report.md'))
        await expect(executeExchange({ operation: 'read', name: 'report.md' }, dir)).rejects.toThrow('regular file')
        const linkedRoot = await root()
        await symlink(outside, join(linkedRoot, 'exchange'), process.platform === 'win32' ? 'junction' : 'dir')
        await expect(executeExchange({ operation: 'list' }, linkedRoot)).rejects.toThrow('real directory')
    })
    it.skipIf(process.platform === 'win32')('rejects symlink files on Unix (Windows CI lacks symlink privilege)', async () => {
        const dir = await root()
        const outside = await root()
        await writeFile(join(outside, 'outside.md'), 'private')
        await mkdir(join(dir, 'exchange'))
        await symlink(join(outside, 'outside.md'), join(dir, 'exchange', 'report.md'))
        await expect(executeExchange({ operation: 'read', name: 'report.md' }, dir)).rejects.toThrow('regular file')
    })
})
