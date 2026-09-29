import { it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const control = vi.hoisted(() => ({ running: false, failReload: false, reloads: 0 }))
vi.mock('./repair-controller-files.js', () => ({ protectControllerDirectory: () => {}, readProtectedControllerFile: (p: string) => readFileSync(p, 'utf8') }))
vi.mock('./native-systemd-service.js', () => ({
    NativeSystemdService: class {
        constructor(private c: any) {}
        async inspect() { if (createHash('sha256').update(readFileSync(this.c.fragmentPath)).digest('hex') !== this.c.fragmentHash) throw Error('Unit identity mismatch'); return { running: control.running, cleanStopped: !control.running, pid: 0 } }
    },
    localSystemdTransport: () => ({ run: async () => { control.reloads++; if (control.failReload) throw Error('reload interrupted') } }),
}))
import { NativeReleaseSelection } from './native-release-selection.js'
function fixture() {
    control.running = false; control.failReload = false; control.reloads = 0
    const root = mkdtempSync(join(tmpdir(), 'native-selection-')), fragmentPath = join(root, 'unit.service')
    const releases: any = {}
    for (const id of ['old', 'next']) { const unitFile = join(root, `${id}.unit`); writeFileSync(unitFile, id); releases[id] = { unitFile, unitHash: createHash('sha256').update(id).digest('hex'), process: {} } }
    writeFileSync(fragmentPath, 'old')
    const ticket: any = { attemptId: 'repair-11111111-1111-4111-8111-111111111111', expiresAt: Date.now() + 60_000 }
    const auth = vi.fn(async () => true), config = { root, unit: 'fixture.service', fragmentPath, releases }
    return { root, fragmentPath, releases, ticket, auth, selection: new NativeReleaseSelection(config, auth), config }
}
it('atomically selects, replays without reload, and selects rollback separately', async () => {
    const f = fixture(); await f.selection.select('next', 'old', f.ticket)
    await new NativeReleaseSelection(f.config, f.auth).select('next', 'old', f.ticket)
    expect(control.reloads).toBe(1)
    await f.selection.select('old', 'next', f.ticket)
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old')
    expect(existsSync(join(f.root, 'selection.lock'))).toBe(false)
})
it.each(['running', 'hash', 'authority'])('rejects %s without replacing unit', async failure => {
    const f = fixture()
    if (failure === 'running') control.running = true
    if (failure === 'hash') writeFileSync(f.releases.next.unitFile, 'tampered')
    if (failure === 'authority') f.auth.mockResolvedValue(false)
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow()
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old'); expect(control.reloads).toBe(0)
})
it('retains interrupted intent, refuses blind replay and reconciles without another reload', async () => {
    const f = fixture(); control.failReload = true
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow('interrupted')
    expect(existsSync(join(f.root, 'selection.lock'))).toBe(true)
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow('reconciliation')
    await f.selection.reconcile('next', 'old', f.ticket)
    expect(control.reloads).toBe(1); expect(existsSync(join(f.root, 'selection.lock'))).toBe(false)
})
