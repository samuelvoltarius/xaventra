import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// docs/CODEKARTE.md is the one code map every session reads before a change.
// It must name every top-level directory under src/ and every registered tool,
// so a new area or tool cannot land without a place (and a duplicate check) in the map.

const ROOT = process.cwd()
export const CODEKARTE_PATH = join('docs', 'CODEKARTE.md')

export interface CodekarteGaps { missingDirs: string[]; missingTools: string[] }

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function codekarteGaps(karte: string, srcDirs: string[], toolNames: string[]): CodekarteGaps {
    const text = karte.replace(/\\/g, '/')
    const missingDirs = srcDirs.filter(dir => !new RegExp(`src/${escapeRegExp(dir)}(?![\\w-])`).test(text)).sort()
    const missingTools = toolNames.filter(name => !text.includes(`\`${name}\``)).sort()
    return { missingDirs, missingTools }
}

export function listSrcDirs(root = ROOT): string[] {
    return readdirSync(join(root, 'src'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

export async function checkCodekarte(root = ROOT): Promise<CodekarteGaps & { missingFile: boolean }> {
    process.env.NOVA_NO_SIDE_EFFECTS = '1'
    process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
    const path = join(root, CODEKARTE_PATH)
    if (!existsSync(path)) return { missingFile: true, missingDirs: [], missingTools: [] }
    const { ALL_TOOLS } = await import('../tools/complete-registry.js')
    const gaps = codekarteGaps(readFileSync(path, 'utf8'), listSrcDirs(root), ALL_TOOLS.map(tool => tool.name))
    return { missingFile: false, ...gaps }
}

export function formatCodekarteGaps(result: CodekarteGaps & { missingFile: boolean }): string | undefined {
    if (result.missingFile) return `${CODEKARTE_PATH} fehlt.`
    const lines: string[] = []
    if (result.missingDirs.length) lines.push(`Verzeichnisse ohne Eintrag in ${CODEKARTE_PATH}: ${result.missingDirs.map(dir => `src/${dir}`).join(', ')}`)
    if (result.missingTools.length) lines.push(`Werkzeuge ohne Eintrag in ${CODEKARTE_PATH}: ${result.missingTools.join(', ')}`)
    return lines.length ? `${lines.join('\n')}\nBereich zuordnen (und Doppelungen prüfen), dann im selben Commit eintragen.` : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const message = formatCodekarteGaps(await checkCodekarte())
    if (message) {
        console.error(message)
        process.exitCode = 1
    } else console.log('Codekarte ist vollständig.')
}
