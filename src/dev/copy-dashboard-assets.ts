import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function copyDashboardAssets(root = process.cwd()): { source: string; destination: string } {
    const source = join(root, 'src', 'dashboard', 'public')
    const destination = join(root, 'dist', 'dashboard', 'public')
    if (!existsSync(source)) throw new Error(`Dashboard assets are missing: ${source}`)
    mkdirSync(destination, { recursive: true })
    cpSync(source, destination, { recursive: true, force: true })
    return { source, destination }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = copyDashboardAssets()
    console.log(`[build] Dashboard assets copied: ${result.source} -> ${result.destination}`)
}
