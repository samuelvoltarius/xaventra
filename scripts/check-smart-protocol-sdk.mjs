// Runs in an exact built image with no network, private state or credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs'
const native = await import('/app/dist/sensing/smart-native-worker.js')
assert.equal(typeof native.readTuyaSdk, 'function')
const create = () => ({ connect: async () => {}, disconnect() {}, health: () => ({ encrypted: true }), deviceInfo: () => ({ name: 'fixture' }), getEntitiesWithIds: () => [] })
assert.deepEqual(await native.readEspHomeSdk({ host: '192.0.2.1', port: 6053, identity: 'fixture', psk: Buffer.alloc(32).toString('base64') }, create), [])
const wire = await import('/app/dist/sensing/matter-wire.js')
for (const on of [true, false]) {
    const { invoke, read } = await wire.matterSwitchRequests(1, on)
    assert.equal(invoke.invokeRequests[0].commandPath.clusterId, 6)
    assert.equal(invoke.invokeRequests[0].commandPath.commandId, on ? 1 : 0)
    assert.equal(read.attributeRequests[0].clusterId, 6)
    assert.equal(read.attributeRequests[0].attributeId, 0)
}
assert(Array.isArray((await wire.matterRefreshRequest()).attributeRequests))
console.log(JSON.stringify({ version: JSON.parse(fs.readFileSync('/app/package.json', 'utf8')).version, arch: process.arch, node: process.version, passed: true, sdkTransport: true, matterWire: true, network: 'none', hardwareActions: 'none', hardwareAcceptance: false }))
