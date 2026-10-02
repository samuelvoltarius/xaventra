import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The one UI (desktop/renderer) is the only browser asset set; nothing else is copied. */
export const DASHBOARD_UI_FILES = Object.freeze(['index.html', 'bridge.js', 'onboarding.js', 'app.js', 'werkzeugkasten.js', 'styles.css'])

export function copyDashboardAssets(root = process.cwd()): { source: string; destination: string } {
    const source = join(root, 'desktop', 'renderer')
    const destination = join(root, 'dist', 'dashboard', 'public')
    for (const name of DASHBOARD_UI_FILES) {
        if (!existsSync(join(source, name))) throw new Error(`Dashboard assets are missing: ${join(source, name)}`)
    }
    mkdirSync(destination, { recursive: true })
    // Remove leftovers of the former dashboard page so only the shared UI is served.
    for (const name of readdirSync(destination)) if (!DASHBOARD_UI_FILES.includes(name)) rmSync(join(destination, name), { recursive: true, force: true })
    for (const name of DASHBOARD_UI_FILES) copyFileSync(join(source, name), join(destination, name))
    return { source, destination }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = copyDashboardAssets()
    console.log(`[build] Dashboard UI copied: ${result.source} -> ${result.destination}`)
}
