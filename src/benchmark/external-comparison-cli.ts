import 'dotenv/config'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calculateBenchmarkMetrics, getBenchmarkScenarios } from './benchmark-lab.js'
import { getExternalAgentAdapters, type ExternalAgentName } from './external-agent-adapters.js'

const nameArg = process.argv.find(arg => arg.startsWith('--agents='))?.split('=')[1]
const names = nameArg ? nameArg.split(',').map(value => value.trim() as ExternalAgentName) : undefined
const limit = Math.max(1, Math.min(100, Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || 10)))
const scenarios = getBenchmarkScenarios().slice(0, limit)
const results = []

for (const adapter of getExternalAgentAdapters(names)) {
    const runs = []
    for (const scenario of scenarios) runs.push(await adapter.execute(scenario))
    const available = runs.some(run => run.available)
    results.push({ agent: runs[0]?.agent, available, metrics: available ? calculateBenchmarkMetrics(runs) : undefined, runs })
}

const report = { version: 1, createdAt: new Date().toISOString(), contract: 'artifact-verified-v1', scenarios: scenarios.length, agents: results }
const outputDir = join(process.cwd(), '.nova-data', 'benchmarks', 'external-comparisons')
if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
const outputFile = join(outputDir, `${Date.now()}.json`)
writeFileSync(outputFile, JSON.stringify(report, null, 2))
process.stdout.write(`${JSON.stringify({ outputFile, agents: results.map(result => ({ agent: result.agent, available: result.available, metrics: result.metrics })) }, null, 2)}\n`, () => process.exit(0))
