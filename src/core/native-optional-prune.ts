import { lstatSync, openSync, readSync, closeSync, opendirSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Upstream platform packages sometimes over-declare their CPU (e.g.
 * `@node-llama-cpp/linux-arm64` lists `cpu: ["arm64","x64"]`), so npm installs
 * foreign-architecture binaries into a native payload. Only packages the lockfile
 * marks OPTIONAL may be removed, only from the fresh payload copy, and only when
 * they contain an ELF for another machine/class. A mismatch in a required package
 * is left for the qualification gate to reject. */
export interface PrunedOptionalPackage { package: string; file: string; machine: number; elfClass: number }

const MACHINE = { x64: 62, arm64: 183 } as const
const MAX_FILES = 20000

function elfIdentity(path: string): { machine: number; elfClass: number } | undefined {
    const fd = openSync(path, 'r'), header = Buffer.alloc(20)
    try { if (readSync(fd, header, 0, 20, 0) < 20) return undefined } finally { closeSync(fd) }
    if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) return undefined
    const little = header[5] === 1
    return { machine: little ? header.readUInt16LE(18) : header.readUInt16BE(18), elfClass: header[4] }
}

function foreignElf(dir: string, arch: 'x64' | 'arm64'): { file: string; machine: number; elfClass: number } | undefined {
    const stack = [dir]; let count = 0
    while (stack.length) {
        const current = stack.pop()!, handle = opendirSync(current)
        try {
            for (let e = handle.readSync(); e; e = handle.readSync()) {
                if (++count > MAX_FILES) throw Error('Optional package scan budget exceeded')
                const full = join(current, e.name), s = lstatSync(full)
                if (s.isSymbolicLink()) continue
                if (s.isDirectory()) { stack.push(full); continue }
                if (!s.isFile() || s.size < 20) continue
                const id = elfIdentity(full)
                if (id && (id.machine !== MACHINE[arch] || id.elfClass !== 2)) return { file: full, ...id }
            }
        } finally { handle.closeSync() }
    }
    return undefined
}

export function pruneForeignOptionalPackages(payloadRoot: string, lock: { packages?: Record<string, { optional?: boolean; dev?: boolean }> }, arch: 'x64' | 'arm64'): PrunedOptionalPackage[] {
    if (!(arch in MACHINE)) throw Error('Unsupported native architecture')
    const root = realpathSync(resolve(payloadRoot)), modules = join(root, 'node_modules') + sep
    const pruned: PrunedOptionalPackage[] = []
    // Deepest paths first so a pruned parent never hides a nested decision.
    const entries = Object.entries(lock.packages || {})
        .filter(([path, meta]) => path.startsWith('node_modules/') && meta?.optional === true)
        .map(([path]) => path).sort((a, b) => b.length - a.length)
    for (const path of entries) {
        if (path.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Invalid lockfile package path')
        const dir = join(root, ...path.split('/'))
        if (!dir.startsWith(modules) || !existsSync(dir)) continue
        const s = lstatSync(dir)
        if (s.isSymbolicLink() || !s.isDirectory()) continue
        const hit = foreignElf(dir, arch)
        if (!hit) continue
        rmSync(dir, { recursive: true, force: false })
        pruned.push({ package: path.slice('node_modules/'.length), file: hit.file.slice(root.length + 1).split(sep).join('/'), machine: hit.machine, elfClass: hit.elfClass })
    }
    return pruned.sort((a, b) => a.package < b.package ? -1 : a.package > b.package ? 1 : 0)
}
