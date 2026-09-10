import { it, expect, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateControllerServer } from './update-controller-server.js'
import { updateControllerRequest } from './update-controller-client.js'
import { upstreamUpdateCommand } from './upstream-update-command.js'
const id = `2.79.0-${'a'.repeat(64)}`
async function fixture(run: (f: any) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'update-rpc-')), keys = generateKeyPairSync('ed25519'), tokenFile = join(root, 'token')
    writeFileSync(tokenFile, 'fixture-' + 'x'.repeat(40), { mode: 0o600 })
    let release!: () => void; const gate = new Promise<void>(r => { release = r })
    const deploy = vi.fn(async () => { await gate; return { status: 'installed', releaseId: id, updatedAt: Date.now(), ticket: { targetId: 'fixture', proposalId: `upstream-${id}` } } as any })
    const authorize = vi.fn(async () => true)
    const options = { root: join(root, 'jobs'), targetId: 'fixture', token: 'fixture-' + 'x'.repeat(40),
        receiptPrivateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), deploy, authorize }
    const server = createUpdateControllerServer(options)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const config = { url: `http://127.0.0.1:${(server.address() as any).port}/update`, targetId: 'fixture', tokenFile,
        receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
    try { await run({ root, options, server, config, deploy, authorize, release }) }
    finally { release(); await new Promise(r => setTimeout(r, 30)); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }) }
}
it('acknowledges before a detached update finishes and coalesces duplicate requests', async () => fixture(async f => {
    expect((await updateControllerRequest('deploy', id, f.config))?.state).toBe('accepted')
    expect((await updateControllerRequest('deploy', id, f.config))?.state).toBe('running')
    expect(f.deploy).toHaveBeenCalledTimes(1)
    f.release()
    await expect.poll(async () => (await updateControllerRequest('status', id, f.config))?.state).toBe('installed')
    expect((await updateControllerRequest('deploy', id, f.config))?.state).toBe('installed')
    expect(f.deploy).toHaveBeenCalledTimes(1)
}))
it('requires an independent grant and denies foreign target before taking a lock', async () => fixture(async f => {
    f.authorize.mockResolvedValue(false)
    await expect(updateControllerRequest('deploy', id, f.config)).rejects.toThrow()
    await expect(updateControllerRequest('deploy', id, { ...f.config, targetId: 'other' })).rejects.toThrow()
    expect(existsSync(join(f.root, 'jobs/job.lock'))).toBe(false); expect(f.deploy).not.toHaveBeenCalled()
}))
it('rejects bad token and untrusted receipt key', async () => fixture(async f => {
    const wrong = join(f.root, 'wrong'); writeFileSync(wrong, 'y'.repeat(40))
    await expect(updateControllerRequest('deploy', id, { ...f.config, tokenFile: wrong })).rejects.toThrow()
    const keys = generateKeyPairSync('ed25519')
    await expect(updateControllerRequest('status', id, { ...f.config, receiptPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).rejects.toThrow()
    expect(f.deploy).not.toHaveBeenCalled()
}))
it('controller restart does not rerun an interrupted persisted job', async () => fixture(async f => {
    writeFileSync(join(f.root, 'jobs', `${id}.json`), JSON.stringify({ releaseId: id, targetId: 'fixture', state: 'running', updatedAt: 1 }))
    expect((await updateControllerRequest('deploy', id, f.config))?.state).toBe('blocked')
    expect(f.deploy).not.toHaveBeenCalled()
}))
it('slash deploy sends an exact ID and shows accepted, never prematurely installed', async () => fixture(async f => {
    const source: any = { prepare: vi.fn(async () => ({ state: 'prepared', releaseId: id, originVerified: true })) }
    const client = (operation: any, release: string) => updateControllerRequest(operation, release, f.config)
    expect(await upstreamUpdateCommand(`deploy ${id}`, 'user', source, client)).toContain('Owner/Admin')
    expect(source.prepare).not.toHaveBeenCalled()
    const output = await upstreamUpdateCommand(`deploy ${id}`, 'owner', source, client)
    expect(output).toContain('angenommen – noch nicht installiert'); expect(output).not.toContain('installiert und geprüft')
    expect(source.prepare).toHaveBeenCalledWith(id)
}))
