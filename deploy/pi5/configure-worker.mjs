import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) throw new Error('usage: configure-worker.mjs <nova.config.json>')

const config = JSON.parse(readFileSync(path, 'utf8'))
config.server = { ...(config.server || {}), host: '127.0.0.1' }
config.voice = { ...(config.voice || {}), enabled: false, autoInstallDeps: false }
config.telemetry = {
    ...(config.telemetry || {}),
    enabled: true,
    endpoint: process.env.NOVA_OTEL_ENDPOINT || 'http://100.64.0.12:4318',
    serviceName: 'nova',
    exportIntervalMs: 15_000,
}
config.providers = config.providers || {}
config.providers.local = {
    ...(config.providers.local || {}),
    baseUrl: 'http://100.64.0.10:8000/v1',
    name: 'Spark vLLM (remote)',
}
config.mesh = config.mesh || {}
config.mesh.direct = {
    ...(config.mesh.direct || {}),
    listenHost: '100.64.0.21',
    port: 9091,
}
config.nodes = [
    {
        name: 'gpu-main',
        host: 'xaventra@100.64.0.10',
        platform: 'linux-arm64',
        services: { vllm: 'http://100.64.0.10:8000' },
    },
]

const temporary = `${path}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
renameSync(temporary, path)
chmodSync(path, 0o600)
