import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


const cwd = process.cwd()
const issues: string[] = []
const warnings: string[] = []

try {
    const { generateRuntimeCatalogs } = await import('./generate-runtime-catalogs.js')
    const catalogs = await generateRuntimeCatalogs({ check: true })
    if (catalogs.mismatches.length) issues.push(`runtime catalogs are stale: ${catalogs.mismatches.join(', ')}`)
} catch (error) {
    issues.push(`runtime catalog verification unavailable: ${String(error)}`)
}

try {
    const { runSecurityAssurance } = await import('../security/assurance-gate.js')
    const assurance = await runSecurityAssurance()
    if (!assurance.passed) issues.push(...assurance.findings.filter(item => item.severity === 'blocking').map(item => `assurance: ${item.message}`))
    warnings.push(...assurance.findings.filter(item => item.severity === 'warning').map(item => `assurance: ${item.message}`))
} catch (error) {
    issues.push(`security assurance unavailable: ${String(error)}`)
}

if (!existsSync(resolveConfigPath(cwd))) issues.push('xaventra.config.json is missing')
const daemon = join(cwd, 'dist', 'daemon.js')
if (!existsSync(daemon)) issues.push('dist/daemon.js is missing; run npm run build')
else if (Date.now() - statSync(daemon).mtimeMs > 7 * 24 * 60 * 60 * 1000) warnings.push('dist/daemon.js is older than seven days')

try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    if (status.length) warnings.push(`working tree has ${status.length} changed/untracked entries`)
    const trackedRuntime = execFileSync('git', ['ls-files', '.nova-*', '*.pid', '*.err'], { cwd, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean)
    if (trackedRuntime.length) warnings.push(`${trackedRuntime.length} runtime artifacts are still tracked (ignore rules do not untrack existing files)`)
} catch (error) {
    warnings.push(`git readiness check unavailable: ${String(error)}`)
}

console.log(`Nova release readiness: ${issues.length ? 'BLOCKED' : 'READY WITH WARNINGS'}`)
for (const issue of issues) console.log(`ERROR: ${issue}`)
for (const warning of warnings) console.log(`WARN: ${warning}`)
if (issues.length) process.exitCode = 1
