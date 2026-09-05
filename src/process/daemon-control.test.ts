import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDaemonControl, stopLocalDaemon } from './daemon-control.js'

const roots: string[] = []
const controls: Awaited<ReturnType<typeof startDaemonControl>>[] = []
const children: ChildProcess[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'xaventra-control-')); roots.push(path); return path }
function record(path: string) { return JSON.parse(readFileSync(join(path, '.nova-data', 'daemon-control.json'), 'utf8')) }
function save(path: string, value: unknown) { writeFileSync(join(path, '.nova-data', 'daemon-control.json'), JSON.stringify(value)) }
function post(value: any, overrides: Record<string, string> = {}, id = value.instanceId) {
    return fetch(`http://127.0.0.1:${value.port}/stop/${id}`, { method: 'POST', headers: {
        Authorization: `Bearer ${value.token}`, 'X-Xaventra-Pid': String(value.pid), ...overrides,
    } })
}
async function child(path: string) {
    const project = process.env.NOVA_PROJECT_ROOT!
    const handle = spawn(process.execPath, [
        '--import', pathToFileURL(join(project, 'node_modules/tsx/dist/loader.mjs')).href,
        join(project, 'test/fixtures/daemon-control-worker.mjs'),
        pathToFileURL(join(project, 'src/process/daemon-control.ts')).href, path,
    ], { cwd: path, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    children.push(handle)
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Control test child did not become ready')), 8000)
        let output = ''
        handle.stdout!.on('data', chunk => {
            output += chunk
            if (output.includes('READY\n')) { clearTimeout(timer); resolve() }
        })
        handle.once('error', error => { clearTimeout(timer); reject(error) })
        handle.once('exit', code => { clearTimeout(timer); reject(new Error(`Control test child exited before ready: ${code}`)) })
    })
    return handle
}

afterEach(async () => {
    for (const control of controls.splice(0)) await control.close()
    for (const handle of children.splice(0)) {
        if (handle.exitCode === null && handle.signalCode === null) {
            await new Promise<void>(resolve => { handle.once('exit', () => resolve()); handle.kill() })
        }
    }
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('instance-scoped daemon lifecycle', () => {
    it('routes npm stop/kill/restart aliases through the scoped CLI', () => {
        const pkg = JSON.parse(readFileSync(join(process.env.NOVA_PROJECT_ROOT!, 'package.json'), 'utf8'))
        for (const name of ['nova:stop', 'nova:kill', 'xaventra:stop']) expect(pkg.scripts[name]).toBe('node dist/cli.js stop')
        for (const name of ['nova:restart', 'xaventra:restart']) expect(pkg.scripts[name]).toBe('node dist/cli.js restart')
    })

    it('does not search or signal processes when no local instance exists', async () => {
        expect(await stopLocalDaemon(root())).toBe('not-running')
    })

    it('refuses legacy PID-only and inconsistent identities', async () => {
        const path = root()
        writeFileSync(join(path, '.nova.pid'), String(process.pid))
        await expect(stopLocalDaemon(path)).rejects.toThrow('No authenticated control')
        const stop = vi.fn()
        controls.push(await startDaemonControl(path, stop))
        writeFileSync(join(path, '.nova.pid'), 'invalid')
        await expect(stopLocalDaemon(path)).rejects.toThrow('identity markers disagree')
        expect(stop).not.toHaveBeenCalled()
    })

    it('rejects wrong credentials, instance and PID before any shutdown', async () => {
        const path = root()
        const stop = vi.fn()
        controls.push(await startDaemonControl(path, stop))
        const value = record(path)
        expect((await post(value, { Authorization: 'Bearer wrong' })).status).toBe(401)
        expect((await post(value, {}, 'other-instance')).status).toBe(404)
        expect((await post(value, { 'X-Xaventra-Pid': '1' })).status).toBe(404)
        expect(stop).not.toHaveBeenCalled()
        expect((await post(value)).status).toBe(200)
        expect((await post(value)).status).toBe(200)
        expect(stop).toHaveBeenCalledTimes(1)
    })

    it('never mistakes an acknowledgement for confirmed process exit', async () => {
        const path = root()
        const stop = vi.fn()
        controls.push(await startDaemonControl(path, stop))
        await expect(stopLocalDaemon(path, { timeoutMs: 150 })).rejects.toThrow('process exit was not confirmed')
        expect(stop).toHaveBeenCalledTimes(1)
    })

    it('refuses restart if a supervisor writes a replacement PID during shutdown', async () => {
        const path = root()
        controls.push(await startDaemonControl(path, () => {
            writeFileSync(join(path, '.nova.pid'), 'replacement')
        }))
        await expect(stopLocalDaemon(path)).rejects.toThrow('replacement daemon PID')
    })

    it('rejects foreign, malformed and oversized control records without exposing their contents', async () => {
        const path = root()
        controls.push(await startDaemonControl(path, vi.fn()))
        const value = record(path)
        save(path, { ...value, root: root() })
        await expect(stopLocalDaemon(path)).rejects.toThrow('Invalid local daemon control record')
        writeFileSync(join(path, '.nova-data', 'daemon-control.json'), 'sensitive malformed data')
        await expect(stopLocalDaemon(path)).rejects.toThrow(/^Invalid local daemon control record$/)
        save(path, { ...value, padding: 'x'.repeat(5000) })
        await expect(stopLocalDaemon(path)).rejects.toThrow('Invalid local daemon control record')
        save(path, value)
    })

    it('does not overwrite live ownership or remove a replacement marker', async () => {
        const path = root()
        const control = await startDaemonControl(path, vi.fn())
        controls.push(control)
        await expect(startDaemonControl(path, vi.fn())).rejects.toThrow('already owns')
        const newer = { ...record(path), instanceId: '00000000-0000-4000-a000-000000000000' }
        save(path, newer)
        controls.pop()
        await control.close()
        expect(record(path).instanceId).toBe(newer.instanceId)
    })

    it('stops one real child while another runtime remains alive', async () => {
        const first = root()
        const second = root()
        await child(first)
        const secondChild = await child(second)
        expect(await stopLocalDaemon(first)).toBe('stopped')
        expect(existsSync(join(first, '.nova-data', 'daemon-control.json'))).toBe(false)
        expect(secondChild.exitCode).toBe(null)
        expect(() => process.kill(secondChild.pid!, 0)).not.toThrow()
        expect(await stopLocalDaemon(second)).toBe('stopped')
    }, 15_000)

    it('the real CLI does not start a replacement after an unverified stop', async () => {
        const path = root()
        const project = process.env.NOVA_PROJECT_ROOT!
        writeFileSync(join(path, '.nova.pid'), String(process.pid))
        mkdirSync(join(path, 'dist'))
        const marker = join(path, 'unexpected-start')
        writeFileSync(join(path, 'dist/daemon.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`)
        const cli = spawn(process.execPath, ['--import', pathToFileURL(join(project, 'node_modules/tsx/dist/loader.mjs')).href,
            join(project, 'src/cli.ts'), 'restart'], { cwd: path, windowsHide: true, stdio: 'ignore' })
        children.push(cli)
        const code = await new Promise<number | null>((resolve, reject) => { cli.once('exit', resolve); cli.once('error', reject) })
        expect(code).toBe(1)
        expect(existsSync(marker)).toBe(false)
    }, 10_000)
})
