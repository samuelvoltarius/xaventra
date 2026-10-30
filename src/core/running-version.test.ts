import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runningVersion } from './running-version.js'
import { getVersionInfo } from '../infra/auto-update.js'

// 2.92.2 (Abnahme 2.92.0): ns1 nannte 2.90.2, /lage 2.91.2. Mehrere Stellen lasen package.json aus process.cwd() - im
// Container ist das /runtime mit einer alten Kopie. Die Selbstauskunft kommt aus der laufenden Installation.
afterEach(() => vi.restoreAllMocks())
const installed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

describe('the running version', () => {
    it('comes from the installation, not from a stale package.json in the working directory', () => {
        const runtime = mkdtempSync(join(tmpdir(), 'stale-runtime-'))
        writeFileSync(join(runtime, 'package.json'), JSON.stringify({ version: '2.90.2' }))
        vi.spyOn(process, 'cwd').mockReturnValue(runtime)
        expect(runningVersion()).toBe(installed)
        expect(getVersionInfo().version).toBe(installed)
    })
})
