import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { verifyProductionTrace } from '../infra/trace-verifier.js'

function option(name: string): string | undefined {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
}

const novaTraceId = option('--trace') || process.env.NOVA_TRACE_ID
const tempoUrl = option('--tempo') || process.env.NOVA_TEMPO_URL || process.env.NOVA_OTEL_ENDPOINT || 'http://localhost:3200'

if (!novaTraceId) {
    console.error('Usage: npm run trace:verify -- --trace <nova-trace-id> [--tempo http://host:3200]')
    process.exit(2)
}

const result = await verifyProductionTrace({ novaTraceId, tempoUrl })
atomicWriteJsonSync(
    join(process.cwd(), '.nova-data', 'trace-verification', `${novaTraceId}.json`),
    result as unknown as Record<string, unknown>,
)
console.log(JSON.stringify(result, null, 2))
if (!result.complete) process.exitCode = 1
