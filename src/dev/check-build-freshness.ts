import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function newestSourceMtime(dir: string): number {
    let newest = 0
    const scan = (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name)
            if (entry.isDirectory()) {
                scan(full)
                continue
            }
            if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                newest = Math.max(newest, statSync(full).mtimeMs)
            }
        }
    }
    scan(dir)
    return newest
}

const root = process.cwd()
const distEntry = join(root, 'dist', 'daemon.js')

if (!existsSync(distEntry)) {
    console.error('[check:build] dist/daemon.js is missing. Run npm run build.')
    process.exit(1)
}

const newestSrc = newestSourceMtime(join(root, 'src'))
const distMtime = statSync(distEntry).mtimeMs
const staleSec = Math.round((newestSrc - distMtime) / 1000)

if (staleSec > 10) {
    console.error(`[check:build] dist is ${staleSec}s behind src. Run npm run build.`)
    process.exit(1)
}

console.log('[check:build] dist is current.')
