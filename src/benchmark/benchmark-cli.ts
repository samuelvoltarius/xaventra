import 'dotenv/config'
import { runNovaBenchmark, type NovaBenchmarkMode } from './nova-benchmark-runner.js'
import { benchmarkExitCode } from './benchmark-lab.js'

const mode: NovaBenchmarkMode = process.argv.includes('--full') ? 'full' : 'smoke'
const report = await runNovaBenchmark(mode)
const output = `${JSON.stringify({ evaluationKind: report.evaluationKind, autonomousTaskCompletionMeasured: report.autonomousTaskCompletionMeasured, metrics: report.metrics }, null, 2)}\n`
// Model discovery and mesh clients may keep diagnostic sockets/timers alive.
// This dedicated CLI has completed once the durable report is written, so it
// exits explicitly instead of looking hung for minutes after success.
process.stdout.write(output, () => process.exit(benchmarkExitCode(report.results)))
