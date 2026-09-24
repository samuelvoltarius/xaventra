import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, ftruncateSync, statSync, linkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createRepairStateCopyScript, type RepairStateCopyLimits } from './docker-repair-state.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'state-copy-')); roots.push(root)
    const source = join(root, 'source'), destination = join(root, 'destination')
    mkdirSync(source); mkdirSync(destination)
    return { source, destination }
}
function copy(f: ReturnType<typeof fixture>, limits?: RepairStateCopyLimits) {
    const script = createRepairStateCopyScript(limits)
        .replaceAll("'/source'", JSON.stringify(f.source)).replaceAll("'/destination'", JSON.stringify(f.destination))
    // Enforce the streaming contract in the actual helper, not a mocked copy.
    execFileSync(process.execPath, ['--max-old-space-size=48', '-e',
        "require('node:fs').readFileSync=()=>{throw Error('Whole-file read prohibited')};\n" + script],
    { timeout: 30_000, stdio: 'pipe' })
}

it('budgets one snapshot, not the sum of its three verification passes', () => {
    const f = fixture(); writeFileSync(join(f.source, 'data'), 'abc')
    copy(f, { maxBytes: 3, maxFileBytes: 3, maxEntries: 2 })
    expect(readFileSync(join(f.destination, 'data'), 'utf8')).toBe('abc')
})

it('streams an explicitly enrolled large file while preserving conservative defaults', () => {
    const f = fixture(), size = 129 * 1024 ** 2
    const fd = openSync(join(f.source, 'audit.jsonl'), 'wx')
    try { ftruncateSync(fd, size) } finally { closeSync(fd) }
    expect(() => copy(f)).toThrow('State copy budget exceeded')
    copy(f, { maxBytes: size, maxFileBytes: size })
    expect(statSync(join(f.destination, 'audit.jsonl')).size).toBe(size)
}, 30_000)

it('refuses a nonempty destination without overwriting its files', () => {
    const f = fixture(); writeFileSync(join(f.destination, 'keep'), 'original')
    expect(() => copy(f)).toThrow('Destination must be empty')
    expect(readFileSync(join(f.destination, 'keep'), 'utf8')).toBe('original')
})

it('retains hard-link rejection with streaming enabled', () => {
    const f = fixture(); writeFileSync(join(f.source, 'data'), 'abc')
    linkSync(join(f.source, 'data'), join(f.source, 'alias'))
    expect(() => copy(f)).toThrow('Unsupported state entry')
})

it('rejects aggregate overflow even when individual files fit', () => {
    const f = fixture(); writeFileSync(join(f.source, 'a'), 'abc'); writeFileSync(join(f.source, 'b'), 'def')
    expect(() => copy(f, { maxBytes: 5, maxFileBytes: 3 })).toThrow('State copy budget exceeded')
})

it.each([{ maxBytes: Infinity }, { maxFileBytes: -1 }, { maxEntries: 100001 },
    { maxBytes: 33 * 1024 ** 3 }, { timeoutMs: 540001 }, { maxBytes: 1, maxFileBytes: 2 }])(
    'rejects invalid or unbounded enrollment %j', limits => {
        expect(() => createRepairStateCopyScript(limits)).toThrow()
    })
