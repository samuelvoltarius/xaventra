import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const configPath = args.shift()
const selfIndex = args.indexOf('--self')
const selfNodeId = selfIndex >= 0 ? args[selfIndex + 1] : undefined
if (selfIndex >= 0) args.splice(selfIndex, 2)
if (!configPath || args.length < 2) {
    throw new Error('usage: register-workers.mjs <xaventra.config.json> <public-identity.json>... [--self <node-id>]')
}

const config = JSON.parse(readFileSync(configPath, 'utf8'))
const identities = args.map(path => JSON.parse(readFileSync(path, 'utf8')))
const peerDefinitions = [
    { nodeId: 'nova-spark', name: 'gpu-main', host: '100.64.0.10' },
    { nodeId: 'nova-pi5', name: 'pi5', host: '100.64.0.21' },
    { nodeId: 'xaventra-worker-a', name: 'worker-a', host: '100.64.0.11' },
    { nodeId: 'xaventra-worker-b', name: 'worker-b', host: '100.64.0.12' },
]
const workerDefinitions = peerDefinitions.filter(definition => ['nova-worker-a', 'nova-worker-b'].includes(definition.nodeId))

// Every eligible node must evaluate the same deterministic strength policy.
// Ineligible infra/Home workers still advertise that fact separately and can
// never win the Main lease.
if (config.mesh) config.mesh.preferStrongestMain = true

for (const definition of peerDefinitions.filter(item => item.nodeId !== selfNodeId)) {
    const identity = identities.find(item => item.nodeId === definition.nodeId)
    if (!identity?.publicKey || identity.nodeId !== definition.nodeId) {
        throw new Error(`missing or invalid public identity for ${definition.nodeId}`)
    }
}

function upsert(items, value, key = 'nodeId') {
    const index = items.findIndex(item => item?.[key] === value[key])
    if (index >= 0) items[index] = { ...items[index], ...value }
    else items.push(value)
}

if (config.mesh?.direct) {
    config.mesh.direct.peers = Array.isArray(config.mesh.direct.peers) ? config.mesh.direct.peers : []
    const allowedTools = config.mesh?.security?.allowedTools
    for (const definition of peerDefinitions) {
        if (definition.nodeId === selfNodeId) continue
        const identity = identities.find(item => item.nodeId === definition.nodeId)
        upsert(config.mesh.direct.peers, {
            nodeId: definition.nodeId,
            url: `ws://${definition.host}:9091`,
            publicKey: identity.publicKey,
            roles: ['system', 'worker'],
            ...(Array.isArray(allowedTools) ? { allowedTools } : {}),
        })
    }
    config.mesh.direct.peers = config.mesh.direct.peers.filter(peer => peer.nodeId !== selfNodeId)
}

if (config.mesh?.update?.enabled === true) {
    config.mesh.update.nodes = Array.isArray(config.mesh.update.nodes) ? config.mesh.update.nodes : []
    for (const definition of workerDefinitions) {
        upsert(config.mesh.update.nodes, {
            nodeId: definition.nodeId,
            name: definition.name,
            host: definition.host,
            user: 'root',
            port: 22,
            path: '/opt/nova-worker',
            runtime: 'docker-compose',
            service: 'nova-worker',
            composePath: '/opt/nova-worker',
            image: 'nova-worker:current',
            healthTimeoutSeconds: 240,
            minFreeDiskGb: 12,
            scpLegacy: true,
        })
    }
}

const originalMode = statSync(configPath).mode & 0o777
const temporary = `${configPath}.tmp`
writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: originalMode })
renameSync(temporary, configPath)
chmodSync(configPath, originalMode)
process.stdout.write(JSON.stringify({
    configPath,
    peers: config.mesh?.direct?.peers?.map(peer => peer.nodeId) || [],
    updateNodes: config.mesh?.update?.nodes?.map(node => node.nodeId) || [],
}, null, 2))
