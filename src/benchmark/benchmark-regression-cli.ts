import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateBenchmarkRegression } from './regression-gate.js'

const directory = join(process.cwd(), 'reports', 'benchmarks')
const files = existsSync(directory)
    ? readdirSync(directory).filter(file => /-full-.*\.json$/i.test(file)).sort((a, b) => {
        const aTime = JSON.parse(readFileSync(join(directory, a), 'utf8')).createdAt || ''
        const bTime = JSON.parse(readFileSync(join(directory, b), 'utf8')).createdAt || ''
        return String(bTime).localeCompare(String(aTime))
    })
    : []

if (files.length < 2) {
    console.error('Benchmark regression gate needs at least two full reports.')
    process.exitCode = 1
} else {
    const current = JSON.parse(readFileSync(join(directory, files[0]), 'utf8'))
    const baseline = JSON.parse(readFileSync(join(directory, files[1]), 'utf8'))
    const decision = evaluateBenchmarkRegression(current.metrics, baseline.metrics)
    console.log(`Benchmark regression gate: ${decision.pass ? 'PASS' : 'BLOCKED'}`)
    console.log(`Current: ${files[0]}`)
    console.log(`Baseline: ${files[1]}`)
    decision.improvements.forEach(message => console.log(`IMPROVED: ${message}`))
    decision.regressions.forEach(message => console.error(`REGRESSION: ${message}`))
    if (!decision.pass) process.exitCode = 1
}
