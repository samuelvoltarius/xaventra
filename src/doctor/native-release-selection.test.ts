import { it, expect, vi, afterEach } from 'vitest'
import { UPDATE_ROLLBACK_GRACE_MS } from '../core/update-activation.js'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const control = vi.hoisted(() => ({ running: false, unclean: false, failReload: false, reloads: 0 }))
vi.mock('./repair-controller-files.js', () => ({ protectControllerDirectory: () => {}, readProtectedControllerFile: (p: string) => readFileSync(p, 'utf8') }))
vi.mock('./native-systemd-service.js', () => ({
    NativeSystemdService: class {
        constructor(private c: any) {}
        async inspect() { if (createHash('sha256').update(readFileSync(this.c.fragmentPath)).digest('hex') !== this.c.fragmentHash) throw Error('Unit identity mismatch'); return { running: control.running, cleanStopped: !control.running && !control.unclean, stopped: !control.running, failed: false, pid: 0 } }
    },
    localSystemdTransport: () => ({ run: async () => { control.reloads++; if (control.failReload) throw Error('reload interrupted') } }),
}))
import { NativeReleaseSelection } from './native-release-selection.js'
function fixture() {
    control.running = false; control.unclean = false; control.failReload = false; control.reloads = 0
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
it('rejects a replacement unit even when caller mutates its enrolled hash', async () => {
    const f = fixture()
    writeFileSync(f.releases.next.unitFile, 'unapproved')
    f.releases.next.unitHash = createHash('sha256').update('unapproved').digest('hex')
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow('CAS mismatch')
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old')
    expect(control.reloads).toBe(0)
})
it('keeps one ticket binding throughout selection despite callback mutation', async () => {
    const f = fixture(), original = structuredClone(f.ticket)
    f.auth.mockImplementation(async (ticket?: any) => {
        if (ticket) ticket.attemptId = 'repair-22222222-2222-4222-8222-222222222222'
        return true
    })
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow('fenced')
    expect(f.ticket).toEqual(original)
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old')
    expect(control.reloads).toBe(0)
    f.auth.mockImplementation(async () => true)
    await f.selection.select('next', 'old', original)
    expect(control.reloads).toBe(1)
})
it('releases its own lock when fenced before the intent exists, so rollback selection still works', async () => {
    const f = fixture(); await f.selection.select('next', 'old', f.ticket)
    // Rollback direction: first authority check passes, the one before the intent fails.
    f.auth.mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(f.selection.select('old', 'next', f.ticket)).rejects.toThrow('fenced')
    expect(existsSync(join(f.root, 'selection.lock'))).toBe(false)
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('next'); expect(control.reloads).toBe(1)
    f.auth.mockResolvedValue(true)
    await f.selection.select('old', 'next', f.ticket)
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old'); expect(control.reloads).toBe(2)
    expect(existsSync(join(f.root, 'selection.lock'))).toBe(false)
})
it('releases its own lock when the stopped-service proof fails before the intent', async () => {
    const f = fixture(); control.running = true
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow('clean stopped')
    expect(existsSync(join(f.root, 'selection.lock'))).toBe(false)
    control.running = false
    await f.selection.select('next', 'old', f.ticket)
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('next')
})
it('never releases a lock owned by another selection binding', async () => {
    const f = fixture(); mkdirSync(join(f.root, 'selection.lock'))
    writeFileSync(join(f.root, 'selection.lock', 'owner.json'), JSON.stringify({ bindingHash: 'e'.repeat(64) }))
    await expect(f.selection.select('next', 'old', f.ticket)).rejects.toThrow()
    expect(existsSync(join(f.root, 'selection.lock', 'owner.json'))).toBe(true)
})
it('accepts a stopped unit with an unclean last exit only under the explicit candidate-failure tolerance', async () => {
    const f = fixture(); await f.selection.select('next', 'old', f.ticket)
    control.unclean = true // candidate crashed, reset-failed done: no process, non-zero exit status remains
    await expect(f.selection.select('old', 'next', f.ticket)).rejects.toThrow('clean stopped')
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('next')
    await f.selection.select('old', 'next', f.ticket, { candidateFailure: true })
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old')
    control.running = true
    await expect(f.selection.select('next', 'old', { ...f.ticket, attemptId: 'repair-33333333-3333-4333-8333-333333333333' }, { candidateFailure: true })).rejects.toThrow('clean stopped')
})
afterEach(() => { vi.useRealTimers() })
it('an expired ticket still admits the rollback selection within the grace, never a forward one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(); await f.selection.select('next', 'old', f.ticket)
    vi.setSystemTime(f.ticket.expiresAt + 1_000)
    await expect(f.selection.select('old', 'next', f.ticket)).rejects.toThrow('fenced')
    await f.selection.select('old', 'next', f.ticket, { rollback: true })
    expect(readFileSync(f.fragmentPath, 'utf8')).toBe('old')
    expect(f.auth).toHaveBeenLastCalledWith(expect.anything(), true)
    vi.setSystemTime(f.ticket.expiresAt + UPDATE_ROLLBACK_GRACE_MS)
    const other = { ...f.ticket, attemptId: 'repair-44444444-4444-4444-8444-444444444444' }
    await expect(f.selection.select('next', 'old', other, { rollback: true })).rejects.toThrow('fenced')
})
