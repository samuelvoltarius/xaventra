import { runSecurityAssurance } from './assurance-gate.js'

const report = await runSecurityAssurance()
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
