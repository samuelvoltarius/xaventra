import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Stufe 1 (S1.6, 30.09.2026): measured against ns2, `StrictHostKeyChecking=no`
// connects even with a wrong host key in known_hosts, `accept-new` refuses it
// and still connects when known_hosts is not writable (hardened service).
// No runtime source may disable host-key verification again.
function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return sources(path)
        return /\.(ts|mts|mjs|js)$/.test(name) && !/\.test\.(ts|mts|mjs|js)$/.test(name) ? [path] : []
    })
}

describe('ssh host-key policy', () => {
    it('no runtime source disables host-key verification', () => {
        const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
        const offenders = sources(root).filter(path => /StrictHostKeyChecking\s*=\s*no\b|StrictHostKeyChecking['"]?\s*,\s*['"]no['"]/i.test(readFileSync(path, 'utf8')))
        expect(offenders.map(path => relative(root, path))).toEqual([])
    })
})
