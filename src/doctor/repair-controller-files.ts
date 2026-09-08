import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

export function protectControllerDirectory(path: string): void {
    let cursor = resolve(path)
    if (realpathSync(cursor) !== cursor) throw new Error('Linked controller state directory')
    while (true) {
        const stat = lstatSync(cursor)
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Controller state and ancestors must be root-owned and runtime-nonwritable')
        const parent = dirname(cursor); if (parent === cursor) break; cursor = parent
    }
}

export function readProtectedControllerFile(path: string, secret = false): string {
    const full = resolve(path), stat = lstatSync(full)
    if (process.platform !== 'linux' || process.getuid?.() !== 0 || realpathSync(full) !== full
        || stat.uid !== 0 || (stat.mode & 0o022) || !stat.isFile() || stat.nlink !== 1) throw new Error('Root-owned unlinked controller file required')
    // Read-only is not confidential: a 0644 receipt key would let the candidate
    // UID forge its own independent recovery evidence. Private files are 0600/0400.
    if (secret && (stat.mode & 0o077)) throw new Error('Controller secret/config must not be group/world readable or accessible')
    protectControllerDirectory(dirname(full))
    if (stat.size > 1024 * 1024) throw new Error('Controller configuration exceeds budget')
    return readFileSync(full, 'utf8')
}
