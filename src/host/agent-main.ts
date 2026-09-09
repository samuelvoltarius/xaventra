import { readFileSync, statSync, chmodSync } from 'node:fs'
import { createDockerHostAgent, hostDockerEngine } from './docker-agent.js'

const path = process.argv[2]
if (!path) throw Error('Usage: node dist/host/agent-main.js <operator-config.json>')
if (process.platform !== 'win32' && (statSync(path).mode & 0o022)) throw Error('Operator configuration must not be group/world writable')
const c = JSON.parse(readFileSync(path, 'utf8'))
if (!c.socketPath || !c.tokenFile || !c.stateDir) throw Error('Explicit local socket, token file and state directory required')
const server = createDockerHostAgent({ ...c, token: readFileSync(c.tokenFile, 'utf8').trim(),
    approvalPublicKey: c.approvalPublicKeyFile ? readFileSync(c.approvalPublicKeyFile, 'utf8') : undefined }, hostDockerEngine(c.dockerSocket, c.dockerApiVersion))
// Never unlink an existing socket; a second service must fail rather than steal it.
server.listen(c.socketPath, () => { if (process.platform !== 'win32') chmodSync(c.socketPath, 0o660); console.log('Xaventra host agent ready (local authenticated socket)') })
server.on('error', () => { console.error('Host agent socket startup failed'); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
