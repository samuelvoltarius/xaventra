import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { probeCodexContinuity, type CodexContinuityProbe, type CodexRoutingConfig } from './codex-runtime.js'

const HA_SCOPE = 'codex-continuity'
const HA_RECORD_ID = 'codex-continuity:owner'
const DEFAULT_STATE_FILE = join(process.cwd(), '.nova-data', 'codex-continuity.json')

export interface CodexContinuityState {
    version: 1
    available: boolean
    activeNodeId?: string
    lastKnownNodeId?: string
    fallbackFingerprint?: string
    updatedAt: string
}

export interface CodexContinuityNotice {
    severity: 'info' | 'warning'
    dedupeKey: string
    content: string
}

function fallbackFingerprint(probe: CodexContinuityProbe): string | undefined {
    return probe.fallback ? `${probe.fallback.nodeId}:${probe.fallback.model}:${probe.fallback.endpoint}` : undefined
}

export function stateFromCodexProbe(probe: CodexContinuityProbe, previous?: CodexContinuityState | null): CodexContinuityState {
    return {
        version: 1,
        available: probe.available,
        activeNodeId: probe.activeNodeId,
        lastKnownNodeId: probe.activeNodeId || previous?.activeNodeId || previous?.lastKnownNodeId || probe.knownNodeIds[0],
        fallbackFingerprint: fallbackFingerprint(probe),
        updatedAt: probe.checkedAt,
    }
}

function fallbackText(probe: CodexContinuityProbe): string {
    if (!probe.fallback) return 'Es wurde kein verifizierter Ersatz gefunden; der Auftrag bleibt fail-closed.'
    let endpointHost: string | undefined
    try { endpointHost = new URL(probe.fallback.endpoint).hostname }
    catch { /* retain the verified graph identity */ }
    const node = probe.fallback.hostname || endpointHost || probe.fallback.nodeId
    return `Nova nutzt automatisch vLLM \`${probe.fallback.model}\` auf \`${node}\`.`
}

export function decideCodexContinuityNotice(
    previous: CodexContinuityState | null,
    probe: CodexContinuityProbe,
): CodexContinuityNotice | null {
    const next = stateFromCodexProbe(probe, previous)
    if (probe.available) {
        if (!previous || previous.available) return null
        return {
            severity: 'info',
            dedupeKey: `codex:restored:${probe.activeNodeId || 'unknown'}`,
            content: `✅ Codex ist auf \`${probe.activeNodeId || 'einem Mesh-Node'}\` wieder verfügbar und für diesen Benutzer verifiziert. Geeignete Aufgaben werden wieder dorthin geroutet.`,
        }
    }

    // Once an outage is known, changes to an equivalent fallback's alias,
    // endpoint spelling, or discovered hostname update state silently. Only a
    // real Codex recovery creates another transition notice.
    if (previous && !previous.available) return null
    const previousNode = previous?.activeNodeId || previous?.lastKnownNodeId
    const previousStillKnown = previousNode
        && (probe.knownNodeIds.includes(previousNode) || probe.localStatus.nodeId === previousNode)
    const affected = (previousStillKnown ? previousNode : undefined)
        || probe.knownNodeIds[0]
    const cause = affected
        ? `Codex auf \`${affected}\` ist für diesen Benutzer nicht erreichbar oder nicht mehr angemeldet.`
        : 'Codex ist auf keinem erreichbaren Node für diesen Benutzer verfügbar.'
    const login = probe.localStatus.available
        ? `Für Codex auf \`${probe.localStatus.nodeId}\`: \`/codex login\`.`
        : 'Für Codex: Sage „Installiere Codex auf dem aktuellen Main“; Nova führt den Auftrag durch den Execution Kernel aus. Danach `/codex login`. Bis dahin bleibt vLLM aktiv.'
    return {
        severity: 'warning',
        dedupeKey: `codex:unavailable:${affected || 'mesh'}:${probe.fallback?.nodeId || 'none'}:${probe.fallback?.model || 'none'}`,
        content: `⚠️ ${cause}\n\n${fallbackText(probe)}\n\n${login}\nDie OAuth-Anmeldung bleibt ausschließlich User × Node; Nova kopiert keine Tokens ins Mesh.`,
    }
}

function readLocalState(path: string): CodexContinuityState | null {
    try {
        if (!existsSync(path)) return null
        const value = JSON.parse(readFileSync(path, 'utf8')) as CodexContinuityState
        return value.version === 1 && typeof value.available === 'boolean' ? value : null
    } catch {
        return null
    }
}

async function readSharedState(): Promise<CodexContinuityState | null> {
    try {
        const { readHaRecords } = await import('../core/ha-state.js')
        return (await readHaRecords<CodexContinuityState>(HA_SCOPE, 20))
            .filter(record => record.payload.version === 1)
            .sort((a, b) => b.timestamp - a.timestamp)[0]?.payload || null
    } catch {
        return null
    }
}

async function persistState(state: CodexContinuityState, path: string): Promise<void> {
    atomicWriteJsonSync(path, state)
    try {
        const { writeHaRecord } = await import('../core/ha-state.js')
        await writeHaRecord(HA_SCOPE, HA_RECORD_ID, state, { available: state.available, activeNodeId: state.activeNodeId })
    } catch { /* local continuity remains available without shared HA storage */ }
}

function stateChanged(previous: CodexContinuityState | null, next: CodexContinuityState): boolean {
    return !previous
        || previous.available !== next.available
        || previous.activeNodeId !== next.activeNodeId
        || previous.lastKnownNodeId !== next.lastKnownNodeId
        || previous.fallbackFingerprint !== next.fallbackFingerprint
}

export interface CodexContinuityMonitorOptions {
    principalId: string
    config: CodexRoutingConfig
    send: (content: string, severity: 'info' | 'warning', dedupeKey: string) => Promise<boolean>
    intervalMs?: number
    stateFile?: string
}

let timer: ReturnType<typeof setInterval> | null = null
let checking = false
let currentState: CodexContinuityState | null = null

export async function checkCodexContinuityOnce(options: CodexContinuityMonitorOptions): Promise<CodexContinuityNotice | null> {
    if (checking) return null
    checking = true
    try {
        const stateFile = options.stateFile || DEFAULT_STATE_FILE
        if (!currentState) {
            const local = readLocalState(stateFile)
            const shared = await readSharedState()
            currentState = [local, shared].filter(Boolean).sort((a, b) =>
                Date.parse((b as CodexContinuityState).updatedAt) - Date.parse((a as CodexContinuityState).updatedAt))[0] as CodexContinuityState | undefined || null
        }
        const probe = await probeCodexContinuity(options.principalId, options.config)
        const notice = decideCodexContinuityNotice(currentState, probe)
        const nextState = stateFromCodexProbe(probe, currentState)
        if (stateChanged(currentState, nextState)) await persistState(nextState, stateFile)
        currentState = nextState
        if (notice) await options.send(notice.content, notice.severity, notice.dedupeKey)
        return notice
    } finally {
        checking = false
    }
}

export function startCodexContinuityMonitor(options: CodexContinuityMonitorOptions): void {
    if (timer) return
    const run = () => { void checkCodexContinuityOnce(options).catch(error => console.log(`[CodexContinuity] Probe failed: ${error}`)) }
    run()
    timer = setInterval(run, Math.max(15_000, options.intervalMs || 30_000))
    timer.unref?.()
}

export function stopCodexContinuityMonitor(): void {
    if (timer) clearInterval(timer)
    timer = null
    checking = false
}

export async function reportCodexRuntimeFallback(event: {
    failedNodeId?: string
    reason: string
    fallbackRoute: string
    fallbackNodeId?: string
    fallbackModel?: string
}): Promise<boolean> {
    const send = (globalThis as any).__novaState?.sendGovernedProactive
    if (typeof send !== 'function') return false
    const failed = event.failedNodeId || 'Codex-Route'
    const fallback = event.fallbackRoute === 'local-vllm'
        ? `vLLM \`${event.fallbackModel || 'auto'}\` auf \`${event.fallbackNodeId || 'dem besten verfügbaren Node'}\``
        : `den Provider \`${event.fallbackRoute}\``
    return send(
        `⚠️ Codex auf \`${failed}\` ist während eines Auftrags ausgefallen. Nova arbeitet automatisch über ${fallback} weiter.\n\nFür Codex: Node prüfen und dort \`/codex login\` ausführen. Die Anmeldung bleibt User × Node.`,
        'codex-continuity',
        'warning',
        0.99,
        `codex:unavailable:${failed}:${event.fallbackNodeId || event.fallbackRoute}:${event.fallbackModel || 'auto'}`,
    )
}
