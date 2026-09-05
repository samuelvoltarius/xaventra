import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const [sourcePath, targetPath, nodeId, nodeName, tailscaleIp] = process.argv.slice(2)
if (!sourcePath || !targetPath || !nodeId || !nodeName || !tailscaleIp) {
    throw new Error('usage: configure-worker.mjs <source-config> <target-config> <node-id> <node-name> <tailscale-ip>')
}
if (!/^nova-[a-z0-9-]+$/.test(nodeId)) throw new Error('invalid worker node id')
if (!/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3}\.)\d{1,3}$/.test(tailscaleIp)) {
    throw new Error('worker listen address must be a Tailscale IPv4 address')
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
const direct = source.mesh?.direct || {}
const trustedReleaseKeys = Array.isArray(source.mesh?.update?.trustedReleaseKeys)
    ? source.mesh.update.trustedReleaseKeys
    : []

const config = {
    name: `Nova Worker ${nodeName}`,
    emoji: '✨',
    version: source.version || '1.0.0',
    provider: 'local',
    model: 'auto',
    internalModel: 'auto',
    learningModel: 'auto',
    repairModel: 'auto',
    doctorModel: 'off',
    fallbackModels: ['auto'],
    models: source.models || {},
    auth: {},
    apis: {},
    channels: {
        telegram: { enabled: false, allowFrom: [] },
        whatsapp: { enabled: false, allowFrom: [] },
        discord: { enabled: false },
        matrix: { enabled: false },
        signal: { enabled: false },
        slack: { enabled: false },
        voip: { enabled: false },
    },
    server: { enabled: false, host: tailscaleIp, port: 18789 },
    dashboard: { enabled: false },
    voice: { enabled: false, autoInstallDeps: false },
    memory: { enabled: true, dbPath: '.nova-memory', autoRecall: true, autoCapture: true },
    learning: { enabled: true, dataDir: '.nova-learning', autoLearnThreshold: 3 },
    resilience: source.resilience || { enabled: true, strictQuality: true, fallbackTimeout: 30000, healthCheckInterval: 30000 },
    performance: { preloadProfile: 'minimal', maxConcurrentRequests: 2, maxRequestQueue: 50 },
    providers: {
        local: {
            enabled: true,
            baseUrl: 'http://100.64.0.10:8000/v1',
            name: 'Spark vLLM (remote)',
        },
    },
    codex: {
        enabled: false,
        preferWhenAuthenticated: false,
        fallbackModel: source.codex?.fallbackModel || 'auto',
        fallbackEndpoint: 'http://100.64.0.10:8000',
    },
    telemetry: {
        enabled: true,
        endpoint: 'http://100.64.0.12:4318',
        serviceName: 'nova',
        exportIntervalMs: 15000,
    },
    mesh: {
        mode: 'ha',
        preferStrongestMain: true,
        direct: {
            enabled: true,
            listenHost: tailscaleIp,
            port: 9091,
            allowInsecureLan: false,
            peers: Array.isArray(direct.peers) ? direct.peers : [],
        },
        security: source.mesh?.security || { allowTofu: false },
        supabase: { table: source.mesh?.supabase?.table || 'nova_mesh_envelopes' },
        relay: { url: source.mesh?.relay?.url || 'http://100.64.0.12:3310' },
        coordination: source.mesh?.coordination || { mode: 'supabase', authorityService: 'nova-main', timeoutMs: 5000 },
        update: {
            enabled: false,
            notifyOnly: true,
            autoDeployOnVersionChange: false,
            trustedReleaseKeys,
            nodes: [],
        },
    },
    nodes: [
        {
            name: 'gpu-main',
            host: 'xaventra@100.64.0.10',
            platform: 'linux-arm64',
            services: { vllm: 'http://100.64.0.10:8000' },
        },
    ],
}

const temporary = `${targetPath}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
renameSync(temporary, targetPath)
chmodSync(targetPath, 0o600)
process.stdout.write(`configured:${nodeId}:${nodeName}:${tailscaleIp}\n`)
