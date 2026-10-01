import { readFileSync, statSync, chmodSync } from 'node:fs'
import { createDockerHostAgent, hostDockerEngine } from './docker-agent.js'
import { createHostInstaller } from './install-agent.js'
import { createHostVllmSwitcher } from './vllm-agent.js'
import { getInstallCatalog, verifyInstallCatalogSignature } from '../install/install-catalog.js'

const path = process.argv[2]
if (!path) throw Error('Usage: node dist/host/agent-main.js <operator-config.json>')
if (process.platform !== 'win32' && (statSync(path).mode & 0o022)) throw Error('Operator configuration must not be group/world writable')
const c = JSON.parse(readFileSync(path, 'utf8'))
if (!c.socketPath || !c.tokenFile || !c.stateDir) throw Error('Explicit local socket, token file and state directory required')
// Stufe 2: catalog installs only when the operator configured them explicitly.
let installer
if (c.install) {
    const i = c.install
    if (!i.ticketPublicKeyFile) throw Error('install.ticketPublicKeyFile required for catalog installs')
    const catalog = getInstallCatalog()
    if (catalog.rejected.length) throw Error('Install catalog contains rejected entries; refusing to start installs')
    let catalogSigned = false
    if (i.catalogSignatureFile || i.catalogPublicKeyFile) {
        if (!i.catalogSignatureFile || !i.catalogPublicKeyFile) throw Error('Catalog signature and public key must be configured together')
        if (!verifyInstallCatalogSignature(catalog, readFileSync(i.catalogSignatureFile, 'utf8').trim(), readFileSync(i.catalogPublicKeyFile, 'utf8'))) throw Error('Install catalog signature invalid')
        catalogSigned = true
    }
    installer = createHostInstaller({
        nodeId: c.nodeId, clientId: c.clientId, stateDir: c.stateDir, catalog, catalogSigned,
        ticketPublicKey: readFileSync(i.ticketPublicKeyFile, 'utf8'),
        receiptPrivateKey: i.receiptPrivateKeyFile ? readFileSync(i.receiptPrivateKeyFile, 'utf8') : undefined,
        paths: i.paths, serviceUser: i.serviceUser, gpuVendor: i.gpuVendor, modelOnly: i.modelOnly === true, diskPath: i.diskPath,
    })
}
// Phase 8: vLLM model switch only when the operator configured it explicitly (docs/VLLM_SWITCH.md).
let vllm
const engine = hostDockerEngine(c.dockerSocket, c.dockerApiVersion)
if (c.vllm) {
    const v = c.vllm
    if (!v.ticketPublicKeyFile || !v.user) throw Error('vllm.ticketPublicKeyFile and vllm.user required for the vLLM switch')
    vllm = createHostVllmSwitcher({
        nodeId: c.nodeId, clientId: c.clientId, stateDir: c.stateDir, ticketPublicKey: readFileSync(v.ticketPublicKeyFile, 'utf8'),
        user: v.user, script: v.script, targets: v.targets, files: v.files,
    }, undefined, engine)
}
const server = createDockerHostAgent({ ...c, token: readFileSync(c.tokenFile, 'utf8').trim(),
    approvalPublicKey: c.approvalPublicKeyFile ? readFileSync(c.approvalPublicKeyFile, 'utf8') : undefined }, engine, installer, vllm)
// Never unlink an existing socket; a second service must fail rather than steal it.
server.listen(c.socketPath, () => { if (process.platform !== 'win32') chmodSync(c.socketPath, 0o660); console.log(`Xaventra host agent ready (local authenticated socket${installer ? ', catalog installs enabled' : ''}${vllm ? ', vLLM switch enabled' : ''})`) })
server.on('error', () => { console.error('Host agent socket startup failed'); process.exitCode = 1 })
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
