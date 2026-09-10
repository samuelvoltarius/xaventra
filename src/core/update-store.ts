import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Controller journals must survive power loss, not only concurrent readers. */
export function writeUpdateState(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    let fd: number | undefined
    try {
        fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
        renameSync(temporary, path)
        if (process.platform !== 'win32') { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) } }
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }) }
}
