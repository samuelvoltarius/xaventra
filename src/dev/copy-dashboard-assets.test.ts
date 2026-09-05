import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { copyDashboardAssets } from './copy-dashboard-assets.js'

describe('copyDashboardAssets', () => {
    it('copies dashboard assets without relying on a platform shell command', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-dashboard-assets-'))
        const source = join(root, 'src', 'dashboard', 'public')
        mkdirSync(join(source, 'nested'), { recursive: true })
        writeFileSync(join(source, 'index.html'), '<main>Nova</main>')
        writeFileSync(join(source, 'nested', 'app.js'), 'export const ready = true')

        const result = copyDashboardAssets(root)

        expect(result.destination).toBe(join(root, 'dist', 'dashboard', 'public'))
        expect(existsSync(join(result.destination, 'nested', 'app.js'))).toBe(true)
        expect(readFileSync(join(result.destination, 'index.html'), 'utf8')).toBe('<main>Nova</main>')
    })

    it('fails closed when the authoritative source assets are absent', () => {
        const root = mkdtempSync(join(tmpdir(), 'nova-dashboard-assets-missing-'))
        expect(() => copyDashboardAssets(root)).toThrow('Dashboard assets are missing')
    })
})
