import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runAgentAcceptance } from './agent-acceptance.js'

const baseUrl = process.env.XAVENTRA_EVAL_BASE_URL
const model = process.env.XAVENTRA_EVAL_MODEL
if (!baseUrl || !model) throw new Error('Set XAVENTRA_EVAL_BASE_URL and XAVENTRA_EVAL_MODEL to an explicitly chosen local OpenAI-compatible model.')
const report = await runAgentAcceptance(baseUrl, model)
const directory = join(process.cwd(), '.nova-data', 'benchmarks', 'agent-acceptance')
mkdirSync(directory, { recursive: true })
const reportPath = join(directory, `${Date.now()}.json`)
writeFileSync(reportPath, JSON.stringify(report, null, 2))
process.stdout.write(`${JSON.stringify({ reportPath, ...report }, null, 2)}\n`, () => process.exit(report.passed ? 0 : 1))
