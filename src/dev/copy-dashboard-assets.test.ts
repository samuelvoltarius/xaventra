import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { copyDashboardAssets, DASHBOARD_UI_FILES } from './copy-dashboard-assets.js'

describe('copyDashboardAssets', () => {
    it('copies exactly the shared UI files without a platform shell command and removes old leftovers', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-dashboard-assets-'))
        const source = join(root, 'desktop', 'renderer')
        mkdirSync(source, { recursive: true })
        for (const name of DASHBOARD_UI_FILES) writeFileSync(join(source, name), `/* ${name} */`)
        writeFileSync(join(source, 'notes.md'), 'not part of the UI')
        const stale = join(root, 'dist', 'dashboard', 'public')
        mkdirSync(stale, { recursive: true })
        writeFileSync(join(stale, 'style.css'), 'old page')

        const result = copyDashboardAssets(root)

        expect(result.destination).toBe(join(root, 'dist', 'dashboard', 'public'))
        for (const name of DASHBOARD_UI_FILES) expect(readFileSync(join(result.destination, name), 'utf8')).toBe(`/* ${name} */`)
        expect(existsSync(join(result.destination, 'notes.md'))).toBe(false)
        expect(existsSync(join(result.destination, 'style.css'))).toBe(false)
    })

    it('fails closed when the authoritative source assets are absent', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-dashboard-assets-missing-'))
        expect(() => copyDashboardAssets(root)).toThrow('Dashboard assets are missing')
    })
})
