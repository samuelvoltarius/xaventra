/**
 * Nova Mesh Release Updater
 *
 * A release is built and tested once on Main, signed with Main's mesh identity,
 * then rolled out sequentially. Workers verify every file before activation.
 * A fresh registry heartbeat is required; otherwise the previous dist/image is
 * restored. Only typed systemd and Docker Compose profiles are accepted.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { getNovaDataDir } from './data-root.js'
import { getLocalNodeId, discoverNodes } from '../mesh/mesh-registry.js'
import { getServiceFencingToken, MAIN_SERVICE } from '../mesh/leader-election.js'
import { MeshIdentity } from '../mesh/mesh-identity.js'
import {
    listReleaseFiles, releaseTreeHash,
    type NovaReleaseManifest, type SignedReleaseManifest,
} from './release-verifier.js'

const execFileAsync = promisify(execFile)
const STATE_FILE = join(getNovaDataDir(), 'mesh-update-state.json')
const RELEASE_MARKER = join(process.cwd(), 'dist', '.nova-release.json')

export type UpdateRuntime = 'systemd' | 'docker-compose'

export interface UpdateNodeConfig {
    nodeId: string
    name: string
    host: string
    user: string
    path: string
    port?: number
    runtime: UpdateRuntime
    service: string
    useSudo?: boolean
    composePath?: string
    image?: string
    healthTimeoutSeconds?: number
    /** Minimum free disk space required before a Docker image build starts. */
    minFreeDiskGb?: number
    /** Use OpenSSH legacy SCP protocol for hosts without an SFTP subsystem. */
    scpLegacy?: boolean
}

export interface UpdateConfig {
    enabled: boolean
    checkIntervalHours?: number
    checkIntervalMinutes?: number
    notifyOnly: boolean
    autoDeployOnVersionChange?: boolean
    canaryCount?: number
    trustedReleaseKeys?: Array<{ nodeId: string; publicKey: string }>
    nodes: UpdateNodeConfig[]
}

export interface NodeUpdateReceipt {
    nodeId: string
    node: string
    releaseId: string
    runtime: UpdateRuntime
    status: 'verified' | 'rolled_back' | 'failed' | 'skipped'
    startedAt: string
    finishedAt: string
    error?: string
}

export interface UpdateStatus {
    currentVersion: string
    currentRelease?: string
    lastCheck: string
    lastUpdate: string | null
    pendingUpdate: boolean
    running: boolean
    updateLog: string[]
    receipts: NodeUpdateReceipt[]
}

export interface PersistedUpdateState {
    observedVersion?: string
    lastRelease?: string
    lastUpdate?: string
    receipts: NodeUpdateReceipt[]
    lastNotificationKey?: string
    lastNotificationAt?: string
    activeDeployment?: {
        releaseId: string
        version: string
        phase: 'prepared' | 'deploying' | 'completed' | 'failed'
        nextNodeIndex: number
        startedAt: string
        receipts: NodeUpdateReceipt[]
        mainLeaseEpoch: number
        sourceNode: string
    }
}

export function derivePersistedUpdateStatus(
    currentVersion: string,
    state: PersistedUpdateState,
    targetNodeIds: string[] = [],
): Pick<UpdateStatus, 'currentRelease' | 'lastUpdate' | 'pendingUpdate' | 'running' | 'receipts'> {
    const receipts = state.receipts || []
    const currentReleaseReceipts = state.lastRelease
        ? receipts.filter(receipt => receipt.releaseId === state.lastRelease)
        : []
    const verifiedNodeIds = new Set(currentReleaseReceipts
        .filter(receipt => receipt.status === 'verified')
        .map(receipt => receipt.nodeId))
    const allTargetsVerified = targetNodeIds.length > 0
        ? targetNodeIds.every(nodeId => verifiedNodeIds.has(nodeId))
        : currentReleaseReceipts.length > 0 && currentReleaseReceipts.every(receipt => receipt.status === 'verified')
    const activeForCurrent = state.activeDeployment?.version === currentVersion
        && ['prepared', 'deploying'].includes(state.activeDeployment.phase)
    const failedForCurrent = state.activeDeployment?.version === currentVersion
        && state.activeDeployment.phase === 'failed'
    const versionChanged = Boolean(state.observedVersion) && state.observedVersion !== currentVersion
    const inferredLastUpdate = allTargetsVerified
        ? currentReleaseReceipts
            .map(receipt => receipt.finishedAt)
            .filter(Boolean)
            .sort()
            .at(-1)
        : undefined

    return {
        currentRelease: state.lastRelease,
        lastUpdate: state.lastUpdate || inferredLastUpdate || null,
        pendingUpdate: Boolean(activeForCurrent || failedForCurrent || versionChanged),
        running: Boolean(activeForCurrent),
        receipts,
    }
}

let updateInterval: ReturnType<typeof setInterval> | null = null
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null
let deploymentPromise: Promise<boolean> | null = null
let updaterConfig: UpdateConfig | null = null
let updaterNotify: ((message: string) => void) | undefined
let updateStatus: UpdateStatus = {
    currentVersion: '0.0.0', lastCheck: '', lastUpdate: null,
    pendingUpdate: false, running: false, updateLog: [], receipts: [],
}

function packageVersion(): string {
    try { return String(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0') }
    catch { return '0.0.0' }
}

function loadState(): PersistedUpdateState {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedUpdateState }
    catch { return { receipts: [] } }
}

function refreshStatusFromState(config = updaterConfig): PersistedUpdateState {
    const state = loadState()
    const currentVersion = packageVersion()
    const derived = derivePersistedUpdateStatus(
        currentVersion,
        state,
        config?.nodes.map(node => node.nodeId) || [],
    )
    updateStatus = {
        ...updateStatus,
        ...derived,
        currentVersion,
        running: Boolean(deploymentPromise) || derived.running,
    }
    return state
}

function saveState(patch: Partial<PersistedUpdateState>): void {
    const next = { ...loadState(), ...patch }
    if (!existsSync(getNovaDataDir())) mkdirSync(getNovaDataDir(), { recursive: true })
    const temporary = `${STATE_FILE}.tmp`
    writeFileSync(temporary, JSON.stringify(next, null, 2))
    renameSync(temporary, STATE_FILE)
}

export function failedReleaseNotificationKey(
    currentVersion: string,
    lastRelease: string | undefined,
    receipts: NodeUpdateReceipt[],
): string | undefined {
    if (!lastRelease) return undefined
    const failures = receipts
        .filter(receipt => receipt.releaseId === lastRelease && receipt.status !== 'verified')
        .map(receipt => `${receipt.nodeId}:${receipt.status}`)
        .sort()
    return failures.length ? `release-failed:${currentVersion}:${lastRelease}:${failures.join(',')}` : undefined
}

function notifyOnce(key: string, message: string, notifyFn?: (message: string) => void): void {
    if (!notifyFn) return
    const state = loadState()
    if (state.lastNotificationKey === key) return
    notifyFn(message)
    saveState({ lastNotificationKey: key, lastNotificationAt: new Date().toISOString() })
}

function readLocalReleaseId(): string | undefined {
    try {
        const envelope = JSON.parse(readFileSync(RELEASE_MARKER, 'utf8')) as SignedReleaseManifest
        return envelope.payload?.releaseId
    } catch { return undefined }
}

export function canResumeReleaseCheckpoint(
    checkpoint: PersistedUpdateState['activeDeployment'] | undefined,
    localReleaseId: string | undefined,
): boolean {
    return Boolean(checkpoint
        && checkpoint.phase !== 'completed'
        && checkpoint.releaseId
        && checkpoint.releaseId === localReleaseId)
}

async function publishUpdateState(state = loadState()): Promise<boolean> {
    try {
        const { pushSharedMemory } = await import('../memory/shared-memory.js')
        const { getLocalNodeId } = await import('../mesh/mesh-registry.js')
        return pushSharedMemory({
            id: 'mesh-release-checkpoint', userId: 'nova-system', role: 'system',
            scope: 'mesh-release-checkpoint', sourceNode: getLocalNodeId(), timestamp: Date.now(),
            content: JSON.stringify(state),
            metadata: { format: 'nova-mesh-release-checkpoint-v1', releaseId: state.lastRelease || null },
        })
    } catch { return false }
}

export async function hydrateUpdateCheckpointFromMesh(): Promise<boolean> {
    try {
        const { pullSharedMemory } = await import('../memory/shared-memory.js')
        const entries = await pullSharedMemory({ scope: 'mesh-release-checkpoint', limit: 20 })
        for (const entry of entries.sort((a, b) => b.timestamp - a.timestamp)) {
            if (entry.metadata?.format !== 'nova-mesh-release-checkpoint-v1') continue
            const remote = JSON.parse(entry.content) as PersistedUpdateState
            if (!canResumeReleaseCheckpoint(remote.activeDeployment, readLocalReleaseId())) continue
            saveState(remote)
            updateStatus.currentRelease = remote.lastRelease
            updateStatus.receipts = remote.receipts || []
            updateStatus.pendingUpdate = true
            return true
        }
    } catch { /* fail closed; local state remains authoritative */ }
    return false
}

function requireReleaseAuthority(expectedEpoch?: number): { epoch: number; token: string } {
    const fence = getServiceFencingToken(MAIN_SERVICE)
    if (!fence || (expectedEpoch !== undefined && fence.epoch !== expectedEpoch)) {
        throw new Error('release authority requires the current fenced nova-main lease')
    }
    return fence
}

function log(message: string): void {
    const line = `${new Date().toISOString()} ${message}`
    updateStatus.updateLog = [...updateStatus.updateLog.slice(-99), line]
    console.log(`[MeshUpdate] ${message}`)
}

function formatExecError(error: unknown, limit = 4000): string {
    const value = error as { message?: string; stderr?: string | Buffer; stdout?: string | Buffer }
    const message = value?.message || String(error)
    const stderr = value?.stderr ? String(value.stderr).trim() : ''
    const stdout = value?.stdout ? String(value.stdout).trim() : ''
    const diagnostic = [message, stderr && `stderr:\n${stderr}`, stdout && !stderr && `stdout:\n${stdout}`]
        .filter(Boolean).join('\n')
    // Preserve the end: Docker/npm/SSH normally print the actionable cause
    // after the echoed command, not at its beginning.
    return diagnostic.length > limit ? `...${diagnostic.slice(-(limit - 3))}` : diagnostic
}

function npmCommand(args: string[]): { program: string; args: string[] } {
    if (process.platform !== 'win32') return { program: 'npm', args }
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) throw new Error(`npm CLI not found at ${npmCli}`)
    return { program: process.execPath, args: [npmCli, ...args] }
}

async function runLocalChecks(): Promise<void> {
    for (const [npmArgs, timeout] of [
        [['run', 'typecheck'], 180_000],
        [['test'], 240_000],
        [['run', 'build'], 180_000],
        [['run', 'check:build'], 60_000],
        [['run', 'benchmark:regression'], 60_000],
    ] as Array<[string[], number]>) {
        const { program, args } = npmCommand(npmArgs)
        log(`Preflight: ${program} ${args.join(' ')}`)
        await execFileAsync(program, args, { cwd: process.cwd(), timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
    }
}

export function validateUpdateNode(node: UpdateNodeConfig): string[] {
    const errors: string[] = []
    const safeName = /^[A-Za-z0-9._-]+$/
    const safeHost = /^[A-Za-z0-9.:[\]-]+$/
    const safePath = /^\/[A-Za-z0-9._/-]+$/
    if (!safeName.test(node.nodeId)) errors.push('invalid nodeId')
    if (!safeName.test(node.name)) errors.push('invalid name')
    if (!safeHost.test(node.host)) errors.push('invalid host')
    if (!safeName.test(node.user)) errors.push('invalid user')
    if (!safePath.test(node.path) || node.path.includes('..')) errors.push('invalid path')
    if (!safeName.test(node.service)) errors.push('invalid service')
    if (node.useSudo !== undefined && typeof node.useSudo !== 'boolean') errors.push('invalid useSudo')
    if (node.scpLegacy !== undefined && typeof node.scpLegacy !== 'boolean') errors.push('invalid scpLegacy')
    if (node.minFreeDiskGb !== undefined
        && (!Number.isFinite(node.minFreeDiskGb) || node.minFreeDiskGb < 1 || node.minFreeDiskGb > 1024)) {
        errors.push('invalid minFreeDiskGb')
    }
    if (!Number.isInteger(node.port || 22) || (node.port || 22) < 1 || (node.port || 22) > 65535) errors.push('invalid port')
    if (node.runtime === 'docker-compose') {
        if (!node.composePath || !safePath.test(node.composePath) || node.composePath.includes('..')) errors.push('invalid composePath')
        if (!node.image || !/^[A-Za-z0-9._/:@-]+$/.test(node.image)) errors.push('invalid image')
    }
    return errors
}

export function obsoleteDockerReleaseTags(
    image: string,
    releaseId: string,
    tags: string[],
): string[] {
    const keep = new Set([
        image,
        `${image}-candidate-${releaseId}`,
        `${image}-rollback-${releaseId}`,
    ])
    const managedPrefix = [`${image}-candidate-`, `${image}-rollback-`]
    return [...new Set(tags)]
        .filter(tag => managedPrefix.some(prefix => tag.startsWith(prefix)))
        .filter(tag => !keep.has(tag))
        .filter(tag => /^[A-Za-z0-9._/:@-]+$/.test(tag))
        .sort()
}

function systemctl(node: UpdateNodeConfig, command: string): string {
    return `${node.useSudo ? 'sudo ' : ''}systemctl ${command}`
}

export function createSignedReleaseManifest(): SignedReleaseManifest {
    if (!existsSync(join(process.cwd(), 'dist', 'daemon.js'))) throw new Error('dist/daemon.js is missing; build first')
    const files = listReleaseFiles(join(process.cwd(), 'dist'))
    const treeHash = releaseTreeHash(files)
    const sourceNode = getLocalNodeId()
    const version = packageVersion()
    if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error('package version is unsafe for a release id')
    const manifest: NovaReleaseManifest = {
        schemaVersion: 1,
        releaseId: `${version}-${treeHash.slice(0, 16)}`,
        version,
        createdAt: new Date().toISOString(),
        sourceNode,
        files,
        treeHash,
    }
    const identity = new MeshIdentity(sourceNode)
    const envelope = identity.create({
        kind: 'update.release', targetNode: '*', payload: manifest,
        principal: { id: `node:${sourceNode}`, role: 'system', channel: 'mesh-update' },
        ttlMs: 7 * 24 * 60 * 60_000,
    })
    writeFileSync(RELEASE_MARKER, JSON.stringify(envelope, null, 2))
    return envelope
}

function sshArgs(node: UpdateNodeConfig): string[] {
    return [
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
        '-o', 'ConnectTimeout=15', '-p', String(node.port || 22), `${node.user}@${node.host}`,
    ]
}

async function ssh(node: UpdateNodeConfig, remoteCommand: string, timeout = 120_000): Promise<string> {
    const { stdout } = await execFileAsync('ssh', [...sshArgs(node), remoteCommand], {
        cwd: process.cwd(), timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024,
    })
    return String(stdout).trim()
}

async function scp(node: UpdateNodeConfig, sources: string[], target: string, timeout = 180_000): Promise<void> {
    const args = buildScpArgs(node, sources, target)
    await execFileAsync('scp', args, { cwd: process.cwd(), timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 })
}

export function buildScpArgs(node: UpdateNodeConfig, sources: string[], target: string): string[] {
    return [
        ...(node.scpLegacy ? ['-O'] : []),
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
        '-P', String(node.port || 22), '-r', ...sources, `${node.user}@${node.host}:${target}`,
    ]
}

function releasePaths(node: UpdateNodeConfig, releaseId: string): { stage: string; backup: string } {
    return {
        stage: `/tmp/nova-release-${releaseId}`,
        backup: `${node.path}/.nova-update/${releaseId}`,
    }
}

export function recoverConfiguredDockerImageCommand(node: UpdateNodeConfig): string {
    return `docker image inspect '${node.image}' >/dev/null 2>&1 || { current_image=$(docker inspect -f '{{.Image}}' '${node.service}'); docker image inspect "$current_image" >/dev/null; docker tag "$current_image" '${node.image}'; }`
}

async function stageRelease(node: UpdateNodeConfig, release: SignedReleaseManifest): Promise<void> {
    const { stage } = releasePaths(node, release.payload.releaseId)
    const releaseDir = join(getNovaDataDir(), 'release-artifacts')
    if (!existsSync(releaseDir)) mkdirSync(releaseDir, { recursive: true })
    const archive = join(releaseDir, `${release.payload.releaseId}.tar.gz`)
    if (!existsSync(archive)) {
        await execFileAsync('tar', ['-czf', archive, 'dist', 'package.json', 'package-lock.json'], {
            cwd: process.cwd(), timeout: 180_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024,
        })
    }
    const archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
    await ssh(node, `set -eu; rm -rf '${stage}'; mkdir -p '${stage}'`)
    await scp(node, [archive], `${stage}/release.tar.gz`)
    await ssh(node, `set -eu; echo '${archiveSha256}  ${stage}/release.tar.gz' | sha256sum -c -; tar -xzf '${stage}/release.tar.gz' -C '${stage}'; rm '${stage}/release.tar.gz'`, 180_000)
    const configPath = node.runtime === 'docker-compose' ? `${node.composePath}/nova.config.json` : `${node.path}/nova.config.json`
    const verifyCommand = node.runtime === 'docker-compose'
        ? `docker run --rm --network none -v '${stage}:/release:ro' -v '${configPath}:/nova.config.json:ro' node:22-bookworm-slim node /release/dist/core/release-verifier.js /release/dist/.nova-release.json /release/dist /nova.config.json`
        : `node '${stage}/dist/core/release-verifier.js' '${stage}/dist/.nova-release.json' '${stage}/dist' '${configPath}'`
    await ssh(node, verifyCommand, 180_000)
}

async function activateSystemd(node: UpdateNodeConfig, releaseId: string): Promise<void> {
    const { stage, backup } = releasePaths(node, releaseId)
    await ssh(node, [
        'set -eu',
        `mkdir -p '${backup}'`,
        `test ! -e '${backup}/dist'`,
        `mv '${node.path}/dist' '${backup}/dist'`,
        `mv '${stage}/dist' '${node.path}/dist'`,
        `cp '${stage}/package.json' '${node.path}/package.json'`,
        `cp '${stage}/package-lock.json' '${node.path}/package-lock.json'`,
        systemctl(node, `restart '${node.service}.service'`),
    ].join('; '), 180_000)
}

async function activateDocker(node: UpdateNodeConfig, releaseId: string): Promise<void> {
    const { stage, backup } = releasePaths(node, releaseId)
    const candidate = `${node.image}-candidate-${releaseId}`
    const rollback = `${node.image}-rollback-${releaseId}`
    await ssh(node, [
        'set -eu',
        // A running Compose service can legitimately reference an untagged image
        // after an earlier release cleanup. Recover the configured base tag from
        // the container's immutable image id before creating the rollback tag.
        recoverConfiguredDockerImageCommand(node),
        `mkdir -p '${backup}'`,
        `test ! -e '${backup}/dist'`,
        `mv '${node.path}/dist' '${backup}/dist'`,
        `mv '${stage}/dist' '${node.path}/dist'`,
        `cp '${stage}/package.json' '${node.path}/package.json'`,
        `cp '${stage}/package-lock.json' '${node.path}/package-lock.json'`,
        `docker image inspect '${node.image}' >/dev/null`,
        `docker tag '${node.image}' '${rollback}'`,
        `docker build -t '${candidate}' '${node.path}'`,
        `docker tag '${candidate}' '${node.image}'`,
        `cd '${node.composePath}'`,
        `docker compose up -d --force-recreate '${node.service}'`,
    ].join('; '), 10 * 60_000)
}

async function assertDockerDiskHeadroom(node: UpdateNodeConfig): Promise<void> {
    if (node.runtime !== 'docker-compose') return
    const minimumGb = node.minFreeDiskGb ?? 12
    const output = await ssh(node, `df -Pk '${node.composePath}' | awk 'NR == 2 { print $4 }'`)
    const freeKb = Number(output.trim().split(/\s+/).at(-1))
    if (!Number.isFinite(freeKb)) throw new Error(`could not determine free disk space on ${node.name}`)
    const freeGb = freeKb / 1024 / 1024
    if (freeGb < minimumGb) {
        throw new Error(`Docker release blocked: ${node.name} has ${freeGb.toFixed(1)} GB free; ${minimumGb} GB required`)
    }
}

async function cleanupDockerReleaseImages(node: UpdateNodeConfig, releaseId: string): Promise<void> {
    if (node.runtime !== 'docker-compose' || !node.image) return
    const output = await ssh(node, `docker image ls --format '{{.Repository}}:{{.Tag}}'`)
    const obsolete = obsoleteDockerReleaseTags(node.image, releaseId, output.split(/\r?\n/))
    if (!obsolete.length) return
    await ssh(node, `docker image rm ${obsolete.map(tag => `'${tag}'`).join(' ')}`, 180_000)
    log(`${node.name}: removed ${obsolete.length} obsolete Docker release tag(s); active release and direct rollback retained`)
}

async function verifyRemoteRuntime(node: UpdateNodeConfig, releaseId: string): Promise<void> {
    if (node.runtime === 'docker-compose') {
        const output = await ssh(node, `set -eu; test \"$(docker inspect -f '{{.State.Running}}' '${node.service}')\" = true; docker exec '${node.service}' grep -q '${releaseId}' /app/dist/.nova-release.json; echo verified`)
        if (!output.includes('verified')) throw new Error('Docker runtime did not expose the new release marker')
    } else {
        const output = await ssh(node, `set -eu; ${systemctl(node, `is-active --quiet '${node.service}.service'`)}; grep -q '${releaseId}' '${node.path}/dist/.nova-release.json'; echo verified`)
        if (!output.includes('verified')) throw new Error('systemd runtime did not expose the new release marker')
    }
}

async function verifyFreshHeartbeat(node: UpdateNodeConfig, startedAt: number): Promise<void> {
    const deadline = Date.now() + Math.max(30, node.healthTimeoutSeconds || 180) * 1000
    while (Date.now() < deadline) {
        const registered = (await discoverNodes({ includeHistorical: true })).find(item => item.node_id === node.nodeId)
        if (registered?.lifecycle_state === 'active' && Date.parse(registered.last_heartbeat) > startedAt) return
        try {
            const peerStates = JSON.parse(readFileSync(join(getNovaDataDir(), 'mesh-peer-state.json'), 'utf8')) as Record<string, { lastSeen?: number; status?: string }>
            const direct = peerStates[node.nodeId]
            if (direct?.status === 'online' && Number(direct.lastSeen || 0) > startedAt) return
        } catch { /* Direct Mesh may not be configured; registry remains authoritative. */ }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 5000))
    }
    throw new Error('no fresh active registry or signed Direct Mesh heartbeat after update')
}

export async function restartManagedNode(node: UpdateNodeConfig): Promise<void> {
    const errors = validateUpdateNode(node)
    if (errors.length) throw new Error(errors.join(', '))
    const startedAt = Date.now()
    if (node.runtime === 'docker-compose') {
        await ssh(node, `set -eu; cd '${node.composePath}'; docker compose restart '${node.service}'`, 180_000)
    } else {
        await ssh(node, systemctl(node, `restart '${node.service}.service'`), 180_000)
    }
    await verifyFreshHeartbeat(node, startedAt)
}

async function rollback(node: UpdateNodeConfig, releaseId: string): Promise<void> {
    const { backup } = releasePaths(node, releaseId)
    const failed = `${node.path}/.nova-update/failed-${releaseId}`
    const commands = [
        'set -eu',
        `test -d '${backup}/dist'`,
        `mv '${node.path}/dist' '${failed}'`,
        `mv '${backup}/dist' '${node.path}/dist'`,
    ]
    if (node.runtime === 'docker-compose') {
        const rollbackImage = `${node.image}-rollback-${releaseId}`
        commands.push(`docker tag '${rollbackImage}' '${node.image}'`, `cd '${node.composePath}'`, `docker compose up -d --force-recreate '${node.service}'`)
    } else commands.push(systemctl(node, `restart '${node.service}.service'`))
    await ssh(node, commands.join('; '), 180_000)
}

async function deployNode(node: UpdateNodeConfig, release: SignedReleaseManifest): Promise<NodeUpdateReceipt> {
    const started = Date.now()
    const receipt: NodeUpdateReceipt = {
        nodeId: node.nodeId, node: node.name, releaseId: release.payload.releaseId,
        runtime: node.runtime, status: 'failed', startedAt: new Date(started).toISOString(), finishedAt: '',
    }
    let activationStarted = false
    try {
        const errors = validateUpdateNode(node)
        if (errors.length) throw new Error(errors.join(', '))
        await assertDockerDiskHeadroom(node)
        log(`${node.name}: staging and signature verification`)
        await stageRelease(node, release)
        log(`${node.name}: activating ${node.runtime} release`)
        activationStarted = true
        if (node.runtime === 'docker-compose') await activateDocker(node, release.payload.releaseId)
        else await activateSystemd(node, release.payload.releaseId)
        await verifyRemoteRuntime(node, release.payload.releaseId)
        await verifyFreshHeartbeat(node, started)
        receipt.status = 'verified'
        log(`${node.name}: release verified by runtime marker and fresh mesh heartbeat`)
        if (node.runtime === 'docker-compose') {
            try {
                await cleanupDockerReleaseImages(node, release.payload.releaseId)
            } catch (cleanupError) {
                log(`${node.name}: Docker retention warning — ${formatExecError(cleanupError, 1000)}`)
            }
        }
    } catch (error) {
        receipt.error = formatExecError(error)
        if (!activationStarted) {
            log(`${node.name}: staging failed before activation; current runtime remains untouched — ${receipt.error}`)
            receipt.status = 'failed'
            receipt.finishedAt = new Date().toISOString()
            return receipt
        }
        log(`${node.name}: update failed; rollback starting — ${receipt.error}`)
        try {
            await rollback(node, release.payload.releaseId)
            receipt.status = 'rolled_back'
            log(`${node.name}: rollback completed`)
        } catch (rollbackError) {
            receipt.error += ` | rollback failed: ${formatExecError(rollbackError, 1000)}`
            receipt.status = 'failed'
        }
    }
    receipt.finishedAt = new Date().toISOString()
    return receipt
}

export async function deployUpdateToAllNodes(config: UpdateConfig, notifyFn?: (message: string) => void): Promise<boolean> {
    if (deploymentPromise) return deploymentPromise
    deploymentPromise = (async () => {
        updateStatus.running = true
        updateStatus.pendingUpdate = true
        updateStatus.updateLog = []
        try {
            const mainFence = requireReleaseAuthority()
            if (!config.enabled) throw new Error('mesh updater is disabled')
            if (!config.nodes.length) throw new Error('no update nodes configured')
            await runLocalChecks()
            const release = createSignedReleaseManifest()
            const previousState = loadState()
            updateStatus.currentRelease = release.payload.releaseId
            notifyFn?.(`📦 Signiertes Nova-Release ${release.payload.releaseId} wird ausgerollt.`)

            const receipts: NodeUpdateReceipt[] = []
            const activeDeployment: NonNullable<PersistedUpdateState['activeDeployment']> = {
                releaseId: release.payload.releaseId,
                version: release.payload.version,
                phase: 'prepared',
                nextNodeIndex: 0,
                startedAt: new Date().toISOString(),
                receipts,
                mainLeaseEpoch: mainFence.epoch,
                sourceNode: getLocalNodeId(),
            }
            saveState({ lastRelease: release.payload.releaseId, activeDeployment, receipts })
            await publishUpdateState()
            const canaryCount = Math.max(1, Math.min(config.nodes.length, config.canaryCount || 1))
            for (let index = 0; index < config.nodes.length; index++) {
                requireReleaseAuthority(mainFence.epoch)
                if (index === canaryCount && receipts.slice(0, canaryCount).some(receipt => receipt.status !== 'verified')) {
                    log('Canary failed; remaining rollout aborted')
                    break
                }
                const node = config.nodes[index]
                const previouslyVerified = previousState.receipts?.find(receipt =>
                    receipt.nodeId === node.nodeId
                    && receipt.releaseId === release.payload.releaseId
                    && receipt.status === 'verified',
                )
                let receipt: NodeUpdateReceipt
                if (previouslyVerified) {
                    const startedAt = new Date().toISOString()
                    try {
                        await verifyRemoteRuntime(node, release.payload.releaseId)
                        receipt = { ...previouslyVerified, startedAt, finishedAt: new Date().toISOString(), error: undefined }
                        log(`${node.name}: identical release is already verified; deployment skipped safely`)
                    } catch (error) {
                        receipt = {
                            nodeId: node.nodeId,
                            node: node.name,
                            releaseId: release.payload.releaseId,
                            runtime: node.runtime,
                            status: 'failed',
                            startedAt,
                            finishedAt: new Date().toISOString(),
                            error: `previous verification is stale; deploy a new version instead of overwriting the same backup: ${formatExecError(error, 1000)}`,
                        }
                        log(`${node.name}: identical verified release is no longer healthy; same-release overwrite blocked`)
                    }
                } else {
                    receipt = await deployNode(node, release)
                }
                receipts.push(receipt)
                updateStatus.receipts = receipts
                activeDeployment.phase = 'deploying'
                activeDeployment.nextNodeIndex = index + 1
                activeDeployment.receipts = [...receipts]
                saveState({ receipts: [...receipts], activeDeployment })
                await publishUpdateState()
            }
            const allVerified = receipts.length === config.nodes.length && receipts.every(receipt => receipt.status === 'verified')
            updateStatus.lastUpdate = new Date().toISOString()
            updateStatus.pendingUpdate = !allVerified
            const notificationKey = allVerified
                ? undefined
                : failedReleaseNotificationKey(release.payload.version, release.payload.releaseId, receipts)
            saveState({
                lastRelease: release.payload.releaseId,
                lastUpdate: updateStatus.lastUpdate,
                ...(allVerified ? { observedVersion: release.payload.version } : {}),
                receipts,
                lastNotificationKey: notificationKey,
                lastNotificationAt: notificationKey ? new Date().toISOString() : undefined,
                activeDeployment: allVerified ? undefined : { ...activeDeployment, phase: 'failed', receipts: [...receipts] },
            })
            await publishUpdateState()
            notifyFn?.(`${allVerified ? '✅' : '⚠️'} Release ${release.payload.releaseId}: ${receipts.filter(item => item.status === 'verified').length}/${config.nodes.length} Nodes verifiziert.`)
            return allVerified
        } catch (error) {
            log(`Release aborted: ${String(error)}`)
            updateStatus.pendingUpdate = true
            return false
        } finally {
            updateStatus.running = false
            deploymentPromise = null
        }
    })()
    return deploymentPromise
}

export function startUpdateChecker(config: UpdateConfig, notifyFn?: (message: string) => void): void {
    updaterConfig = config
    updaterNotify = notifyFn
    if (updateInterval) clearInterval(updateInterval)
    const state = refreshStatusFromState(config)
    if (!state.observedVersion) saveState({ observedVersion: updateStatus.currentVersion })
    if (!config.enabled) return
    const check = (): void => {
        updateStatus.lastCheck = new Date().toISOString()
        const persisted = refreshStatusFromState(config)
        const current = updateStatus.currentVersion
        if (persisted.observedVersion && persisted.observedVersion !== current) {
            const activeForCurrent = persisted.activeDeployment?.version === current
                && ['prepared', 'deploying'].includes(persisted.activeDeployment.phase)
            if (activeForCurrent) return
            const failedReleaseNeedsOperator = Boolean(persisted.lastRelease) && (persisted.receipts || []).some(
                receipt => receipt.releaseId === persisted.lastRelease
                    && receipt.status !== 'verified'
                    && persisted.lastRelease?.startsWith(`${current}-`),
            )
            if (config.autoDeployOnVersionChange && !config.notifyOnly && !deploymentPromise && !failedReleaseNeedsOperator) {
                void deployUpdateToAllNodes(config, notifyFn)
            } else if (failedReleaseNeedsOperator) {
                const key = failedReleaseNotificationKey(current, persisted.lastRelease, persisted.receipts || [])
                if (key) notifyOnce(key, `⚠️ Nova ${current}: automatischer Rollout nach Fehlschlag gesperrt. /update deploy startet einen manuellen Retry. Diese Meldung wird für denselben Fehler nicht wiederholt.`, notifyFn)
            } else {
                notifyOnce(`release-ready:${current}`, `📦 Nova ${current} ist bereit. /update deploy startet den signierten Mesh-Rollout.`, notifyFn)
            }
        }
    }
    const intervalMs = Math.max(1, config.checkIntervalMinutes || (config.checkIntervalHours || 6) * 60) * 60_000
    updateInterval = setInterval(check, intervalMs)
    if (updateInterval.unref) updateInterval.unref()
    initialCheckTimer = setTimeout(check, 1000)
    if (initialCheckTimer.unref) initialCheckTimer.unref()
    log(`release checker active every ${Math.round(intervalMs / 60_000)}min (${config.notifyOnly ? 'notify-only' : 'auto rollout'})`)
}

export function stopUpdateChecker(): void {
    if (updateInterval) clearInterval(updateInterval)
    if (initialCheckTimer) clearTimeout(initialCheckTimer)
    updateInterval = null
    initialCheckTimer = null
    updaterConfig = null
    updaterNotify = undefined
}

export async function deployConfiguredUpdate(): Promise<boolean> {
    if (!updaterConfig) throw new Error('mesh updater is not configured')
    return deployUpdateToAllNodes(updaterConfig, updaterNotify)
}

export function getUpdateStatus(): UpdateStatus {
    refreshStatusFromState()
    return { ...updateStatus, updateLog: [...updateStatus.updateLog], receipts: [...updateStatus.receipts] }
}

export default { deployUpdateToAllNodes, deployConfiguredUpdate, restartManagedNode, startUpdateChecker, stopUpdateChecker, getUpdateStatus }
