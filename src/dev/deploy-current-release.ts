import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deployUpdateToAllNodes, getUpdateStatus, type UpdateConfig } from '../core/auto-updater.js'
import { MAIN_SERVICE, shouldStartExclusiveService, stopLeaseRenewal } from '../mesh/leader-election.js'
import { selectReleaseTargets } from './release-targets.js'
import { resolveConfigPath } from '../config/config-path.js'


const configPath = process.env.NOVA_RELEASE_CONFIG_PATH || resolveConfigPath()
const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mesh?: { update?: UpdateConfig }
}
if (!config.mesh?.update?.enabled) throw new Error('mesh.update is not enabled')
const updateConfig = selectReleaseTargets(config.mesh.update, process.env.NOVA_RELEASE_TARGET_NODE_IDS)
if (!(await shouldStartExclusiveService(MAIN_SERVICE))) {
    throw new Error('release deployment denied: this node does not own the fenced Main lease')
}

try {
    const success = await deployUpdateToAllNodes(updateConfig, message => console.log(`[release] ${message}`))
    console.log(JSON.stringify({ success, receipts: getUpdateStatus().receipts }, null, 2))
    if (!success) process.exitCode = 1
} finally {
    // This one-shot process joined the same physical Main only to obtain a
    // local copy of its current fence. The daemon owns the durable renewal.
    stopLeaseRenewal(MAIN_SERVICE)
}
