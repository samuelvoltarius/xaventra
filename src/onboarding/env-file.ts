import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/
const SAFE_VALUE = /^[A-Za-z0-9_.:@\/+=-]{0,200}$/

/**
 * Sets KEY=value lines in a .env file: replaces the first occurrence, drops
 * duplicates, appends missing keys, keeps every other line and the file mode
 * (0600 for a new file). Values are restricted so no line can be injected.
 */
export function setEnvFileValues(path: string, values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) {
        if (!KEY.test(key) || !SAFE_VALUE.test(value)) throw new Error(`Ungültiger Eintrag für ${KEY.test(key) ? key : 'die .env'}`)
    }
    const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : []
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const pending = new Map(Object.entries(values))
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of lines) {
        const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
        if (key && values[key] !== undefined) {
            if (seen.has(key)) continue
            seen.add(key)
            out.push(`${key}=${values[key]}`)
            pending.delete(key)
            continue
        }
        out.push(line)
    }
    for (const [key, value] of pending) out.push(`${key}=${value}`)
    let mode = 0o600
    try { mode = statSync(path).mode & 0o777 } catch { /* new file */ }
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, `${out.join('\n')}\n`, { mode })
    renameSync(tmp, path)
}
