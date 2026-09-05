import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const layersDir = join(root, 'src', 'layers')
const coreRuntimeModules = [
    'core/channel-gateway.ts',
    'core/intent-dispatcher.ts',
    'core/focused-worker.ts',
    'core/execution-kernel.ts',
    'core/result-validator.ts',
    'memory/memory-curator.ts',
    'memory/memory-governance.ts',
    'core/health-contract.ts',
    'runtime/service-runtime.ts',
]

process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
process.env.NOVA_NO_SIDE_EFFECTS = '1'

const files = readdirSync(layersDir)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'))
    .sort()

const failures: Array<{ file: string; error: string }> = []

for (const moduleName of coreRuntimeModules) {
    const full = join(root, 'src', moduleName)
    try {
        const mod = await import(pathToFileURL(full).href)
        console.log(`[check:runtime] ok ${relative(root, full)} (${Object.keys(mod).length} exports)`)
    } catch (err) {
        failures.push({ file: relative(root, full), error: err instanceof Error ? err.message : String(err) })
    }
}

for (const file of files) {
    const full = join(layersDir, file)
    try {
        const mod = await import(pathToFileURL(full).href)
        const exportCount = Object.keys(mod).length
        console.log(`[check:layers] ok ${relative(root, full)} (${exportCount} exports)`)
    } catch (err) {
        failures.push({
            file: relative(root, full),
            error: err instanceof Error ? err.message : String(err),
        })
        console.error(`[check:layers] failed ${relative(root, full)}: ${failures[failures.length - 1].error}`)
    }
}

if (failures.length > 0) {
    console.error(`[check:layers] ${failures.length}/${files.length} layer modules failed.`)
    process.exit(1)
}

console.log(`[check:runtime] ${coreRuntimeModules.length} core modules and ${files.length} service modules loaded successfully.`)
