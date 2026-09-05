import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
const endpoint = process.argv[3] || process.env.NOVA_OTEL_ENDPOINT || 'http://100.64.0.12:4318'
if (!path) throw new Error('usage: configure-telemetry.mjs <xaventra.config.json> [otlp-http-endpoint]')

const config = JSON.parse(readFileSync(path, 'utf8'))
config.telemetry = {
    ...(config.telemetry || {}),
    enabled: true,
    endpoint,
    serviceName: 'nova',
    exportIntervalMs: 15_000,
}
delete config.telemetry.serviceVersion

const temporary = `${path}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
renameSync(temporary, path)
chmodSync(path, 0o600)
