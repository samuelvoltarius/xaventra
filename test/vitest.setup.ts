import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = process.cwd()
const runtimeRoot = mkdtempSync(join(tmpdir(), 'nova-core-vitest-'))

process.env.NOVA_TEST_MODE = '1'
process.env.NOVA_NO_SIDE_EFFECTS = '1'
process.env.NOVA_SKIP_MODEL_RESOLVER_INIT = '1'
process.env.NOVA_PROJECT_ROOT = projectRoot
process.env.NOVA_RUNTIME_ROOT = runtimeRoot
mkdirSync(join(runtimeRoot, '.nova-data'), { recursive: true })
mkdirSync(join(runtimeRoot, '.nova-learning'), { recursive: true })
mkdirSync(join(runtimeRoot, '.nova-test-tmp'), { recursive: true })

// Tests must never depend on or copy production secrets. The checked-in example
// is the canonical inert fixture and every write remains inside runtimeRoot.
const configFixture = join(projectRoot, 'nova.config.example.json')
if (!existsSync(configFixture)) throw new Error('nova.config.example.json test fixture is missing')
copyFileSync(configFixture, join(runtimeRoot, 'nova.config.json'))
const fixtures = join(projectRoot, 'test', 'fixtures')
if (existsSync(fixtures)) {
    mkdirSync(join(runtimeRoot, 'test'), { recursive: true })
    cpSync(fixtures, join(runtimeRoot, 'test', 'fixtures'), { recursive: true })
}

process.chdir(runtimeRoot)
process.once('exit', () => {
    try { rmSync(runtimeRoot, { recursive: true, force: true }) } catch { /* best effort */ }
})
