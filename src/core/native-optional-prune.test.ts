import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneForeignOptionalPackages } from './native-optional-prune.js'

const elf = (machine: number, elfClass = 2) => {
    const b = Buffer.alloc(64); b.write('\x7fELF', 'latin1'); b[4] = elfClass; b[5] = 1; b[6] = 1; b.writeUInt16LE(3, 16); b.writeUInt16LE(machine, 18); return b
}
function payload(files: Record<string, Buffer | string>) {
    const root = mkdtempSync(join(tmpdir(), 'prune-'))
    for (const [path, data] of Object.entries(files)) { mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(root, ...path.split('/')), data) }
    return root
}
// Mirrors the real node-llama-cpp lockfile: platform packages are optional and
// the arm/arm64 ones over-declare `cpu` to include x64.
const lock = { packages: {
    'node_modules/node-llama-cpp': {},
    'node_modules/@node-llama-cpp/linux-arm64': { optional: true },
    'node_modules/@node-llama-cpp/linux-armv7l': { optional: true },
    'node_modules/@node-llama-cpp/linux-x64': { optional: true },
    'node_modules/required-native': {},
} }

it('removes only optional packages carrying foreign-architecture ELF files on x64', () => {
    const root = payload({
        'node_modules/node-llama-cpp/index.js': 'x',
        'node_modules/@node-llama-cpp/linux-arm64/bins/linux-arm64/libggml-base.so': elf(183),
        'node_modules/@node-llama-cpp/linux-armv7l/bins/llama-addon.node': elf(40, 1),
        'node_modules/@node-llama-cpp/linux-x64/bins/llama-addon.node': elf(62),
        'node_modules/required-native/addon.node': elf(62),
    })
    const pruned = pruneForeignOptionalPackages(root, lock, 'x64')
    expect(pruned.map(p => p.package)).toEqual(['@node-llama-cpp/linux-arm64', '@node-llama-cpp/linux-armv7l'])
    expect(existsSync(join(root, 'node_modules/@node-llama-cpp/linux-arm64'))).toBe(false)
    expect(existsSync(join(root, 'node_modules/@node-llama-cpp/linux-x64/bins/llama-addon.node'))).toBe(true)
    expect(existsSync(join(root, 'node_modules/required-native/addon.node'))).toBe(true)
})
it('keeps the arm64 package and removes x64-only optional packages on arm64', () => {
    const root = payload({
        'node_modules/@node-llama-cpp/linux-arm64/bins/a.so': elf(183),
        'node_modules/@node-llama-cpp/linux-x64/bins/a.node': elf(62),
    })
    expect(pruneForeignOptionalPackages(root, lock, 'arm64').map(p => p.package)).toEqual(['@node-llama-cpp/linux-x64'])
    expect(existsSync(join(root, 'node_modules/@node-llama-cpp/linux-arm64/bins/a.so'))).toBe(true)
})
it('never removes a REQUIRED package with a foreign binary; qualification must reject it', () => {
    const root = payload({ 'node_modules/required-native/addon.node': elf(183) })
    expect(pruneForeignOptionalPackages(root, lock, 'x64')).toEqual([])
    expect(existsSync(join(root, 'node_modules/required-native/addon.node'))).toBe(true)
})
it('rejects lockfile paths that try to leave node_modules', () => {
    const root = payload({ 'node_modules/a/x.js': 'x' })
    expect(() => pruneForeignOptionalPackages(root, { packages: { 'node_modules/../../etc': { optional: true } } }, 'x64')).toThrow('Invalid lockfile package path')
})
