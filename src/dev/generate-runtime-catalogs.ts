import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = process.cwd()
const OUTPUT = join(ROOT, 'docs', 'generated')

function walk(root: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.nova')) continue
        const path = join(root, entry.name)
        if (entry.isDirectory()) files.push(...walk(path))
        else if (entry.isFile()) files.push(path)
    }
    return files
}

function stable(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

export function catalogContentMatches(current: string | undefined, expected: string): boolean {
    if (current === undefined) return false
    const normalizeEol = (value: string): string => value.replace(/\r\n?/g, '\n')
    return normalizeEol(current) === normalizeEol(expected)
}

function configShape(value: unknown): unknown {
    if (Array.isArray(value)) return { type: 'array', items: value.length ? configShape(value[0]) : 'unknown' }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, configShape(item)]))
    return typeof value
}

function moduleGraph(files: string[]): unknown[] {
    return files.filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).sort().map(file => {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false)
        const imports: string[] = []
        source.forEachChild(node => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
            if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
        })
        return { module: relative(ROOT, file).replace(/\\/g, '/'), imports: [...new Set(imports)].sort() }
    })
}

function persistenceCatalog(files: string[]): unknown[] {
    const entries: Array<{ owner: string; path: string }> = []
    const pattern = /['"](\.nova-(?:data|memory|learning|sessions|vector-memory)(?:\/[A-Za-z0-9._/-]+)?)['"]/g
    for (const file of files.filter(file => file.endsWith('.ts'))) {
        const text = readFileSync(file, 'utf8').replace(/\\/g, '/')
        for (const match of text.matchAll(pattern)) entries.push({ owner: relative(ROOT, file).replace(/\\/g, '/'), path: match[1] })
    }
    return [...new Map(entries.map(entry => [`${entry.owner}:${entry.path}`, entry])).values()].sort((a, b) => a.path.localeCompare(b.path) || a.owner.localeCompare(b.owner))
}

export async function generateRuntimeCatalogs(options: { check?: boolean } = {}): Promise<{ changed: string[]; mismatches: string[] }> {
    process.env.NOVA_NO_SIDE_EFFECTS = '1'
    process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
    const files = walk(join(ROOT, 'src'))
    const [{ ALL_TOOLS }, { listRuntimeProfiles, listRuntimeBundles }] = await Promise.all([
        import('../tools/complete-registry.js'), import('../runtime/runtime-profiles.js'),
    ])
    const toolCatalog = ALL_TOOLS.map(tool => ({
        name: tool.name, category: tool.category, description: tool.description,
        parameters: tool.parameters.map(parameter => ({ name: parameter.name, type: parameter.type, required: parameter.required === true })),
    })).sort((a, b) => a.name.localeCompare(b.name))
    const example = JSON.parse(readFileSync(join(ROOT, 'nova.config.example.json'), 'utf8'))
    const outputs: Record<string, string> = {
        'tools.json': stable({ version: 1, tools: toolCatalog }),
        'config.json': stable({ version: 1, shape: configShape(example) }),
        'persistence.json': stable({ version: 1, entries: persistenceCatalog(files) }),
        'modules.json': stable({ version: 1, modules: moduleGraph(files) }),
        'profiles.json': stable({ version: 1, profiles: listRuntimeProfiles(), bundles: listRuntimeBundles() }),
    }
    outputs['README.md'] = `# Nova generated runtime catalogs\n\nGenerated from authoritative source. Do not edit by hand.\n\n| Catalog | Entries | SHA-256 |\n|---|---:|---|\n${Object.entries(outputs).filter(([name]) => name.endsWith('.json')).map(([name, content]) => `| ${name} | ${(JSON.parse(content).tools || JSON.parse(content).entries || JSON.parse(content).modules || JSON.parse(content).profiles || []).length} | \`${hash(content)}\` |`).join('\n')}\n`

    const changed: string[] = []
    const mismatches: string[] = []
    for (const [name, content] of Object.entries(outputs)) {
        const path = join(OUTPUT, name)
        const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
        if (catalogContentMatches(current, content)) continue
        if (options.check) mismatches.push(relative(ROOT, path).replace(/\\/g, '/'))
        else {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, content)
            changed.push(relative(ROOT, path).replace(/\\/g, '/'))
        }
    }
    return { changed, mismatches }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check')
    const result = await generateRuntimeCatalogs({ check })
    if (result.mismatches.length) {
        console.error(`Runtime catalogs are stale: ${result.mismatches.join(', ')}`)
        process.exitCode = 1
    } else console.log(check ? 'Runtime catalogs are current.' : `Runtime catalogs generated: ${result.changed.length} changed.`)
}
