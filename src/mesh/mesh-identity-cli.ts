import 'dotenv/config'
import { MeshIdentity } from './mesh-identity.js'
import { getLocalNodeId } from './mesh-registry.js'

const identity = new MeshIdentity(getLocalNodeId())
console.log(JSON.stringify({
    nodeId: identity.nodeId,
    fingerprint: MeshIdentity.fingerprint(identity.publicKey),
    publicKey: identity.publicKey,
}, null, 2))
