/**
 * Nova Autonomous Executor — Mission Engine
 * 
 * Transforms Nova from reactive to proactive:
 * 1. DECOMPOSE: User gives a big goal → LLM breaks into subtasks
 * 2. EXECUTE: Each subtask is injected into the pipeline as a self-message
 * 3. EVALUATE: Check result of each subtask
 * 4. CHAIN: Advance to next subtask, retry, or adjust plan on failure
 * 5. REPORT: Notify user on progress/completion
 * 
 * This is the engine that makes Nova autonomous overnight.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-storage.js'
import { detectActionIntent } from './action-intent.js'
import { createTaskContract, validateTaskCompletion, type TaskContract } from './task-contract.js'
import { getOutcomeLedger } from './outcome-ledger.js'
import { getGoalManager } from './goal-manager.js'

// ============================================
// Types
// ============================================

export interface MissionStep {
    id: number
    description: string
    command: string              // The actual message to inject into pipeline
    status: 'pending' | 'active' | 'done' | 'failed' | 'skipped'
    result?: string
    error?: string
    startedAt?: number
    finishedAt?: number
    retries: number
    executionKey?: string
    outcomeRunId?: string
    goalId?: string
}

export interface Mission {
    id: string
    goal: string                 // Original user request
    summary: string              // LLM-generated summary
    steps: MissionStep[]
    currentStep: number
    status: 'planning' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled'
    createdBy: string            // userId
    channel: string
    createdAt: number
    finishedAt?: number
    totalDuration?: number
    progressUpdates: string[]    // Log of what happened
    ownerNode?: string
    leaseEpoch?: number
    fencingToken?: string
    checkpointAt?: number
    contract?: TaskContract
    completedIdempotencyKeys?: string[]
    pendingActions?: string[]
    compensationActions?: string[]
    rootGoalId?: string
}

export interface MissionConfig {
    maxRetries: number           // Per subtask (default: 2)
    maxSteps: number             // Max subtasks per mission (default: 20)
    maxContinuations: number     // How many times a mission can auto-continue (default: 3)
    delayBetweenSteps: number    // ms between subtasks (default: 3000)
    notifyEveryNSteps: number    // Progress update frequency (default: 3)
    timeoutPerStep: number       // ms timeout per step (default: 120000)
    enabled: boolean
}

// ============================================
// State
// ============================================

const DATA_DIR = join(process.cwd(), '.nova-data')
const MISSIONS_FILE = join(DATA_DIR, 'missions.json')
const MISSION_CONFIG_FILE = join(DATA_DIR, 'mission-config.json')

const DEFAULT_CONFIG: MissionConfig = {
    maxRetries: 2,
    maxSteps: 20,
    maxContinuations: 1,
    delayBetweenSteps: 3000,
    notifyEveryNSteps: 3,
    timeoutPerStep: 120_000,
    enabled: true,
}

let config: MissionConfig = { ...DEFAULT_CONFIG }
let activeMission: Mission | null = null
let missionQueue: { goal: string, userId: string, channel: string }[] = []
let missionHistory: Mission[] = []
let isExecuting = false
let missionRecoveryTimer: NodeJS.Timeout | null = null

// Injected dependencies
let pipelineHandler: ((channel: string, from: string, content: string, replyFn: (msg: string) => Promise<void>, state: any) => Promise<void>) | null = null
let notifyUser: ((msg: string) => Promise<void>) | null = null
let llmClient: any = null
let daemonState: any = null

// ============================================
// Initialization
// ============================================

export function initMissionEngine(deps: {
    handleMessage: (channel: string, from: string, content: string, replyFn: (msg: string) => Promise<void>, state: any) => Promise<void>
    notifyFn: (msg: string) => Promise<void>
    llm: any
    state: any
}): void {
    pipelineHandler = deps.handleMessage
    notifyUser = deps.notifyFn
    llmClient = deps.llm
    daemonState = deps.state

    // Load config from disk
    try {
        if (existsSync(MISSION_CONFIG_FILE)) {
            const savedConfig = JSON.parse(readFileSync(MISSION_CONFIG_FILE, 'utf-8'))
            config = { ...DEFAULT_CONFIG, ...savedConfig }
            console.log(`[Mission] Config loaded: continuations=${config.maxContinuations}, steps=${config.maxSteps}, timeout=${config.timeoutPerStep}ms`)
        }
    } catch { /* use defaults */ }

    // Load history
    try {
        if (existsSync(MISSIONS_FILE)) {
            const data = JSON.parse(readFileSync(MISSIONS_FILE, 'utf-8'))
            missionHistory = data.history || []
            // Resume active mission if process restarted
            if (data.active && data.active.status === 'active') {
                activeMission = data.active
                console.log(`[Mission] 🔄 Resuming mission: "${activeMission!.goal.slice(0, 60)}..."`)
                // Resume is fail-closed: no step may execute until this node
                // owns a fresh distributed mission fence.
                setTimeout(async () => {
                    if (!activeMission) return
                    try {
                        const { acquireMissionOwnership } = await import('../mesh/mesh-registry.js')
                        const ownership = await acquireMissionOwnership(activeMission.id)
                        if (!ownership) {
                            activeMission.status = 'paused'
                            activeMission.progressUpdates.push('⏸️ Wiederaufnahme blockiert: keine gültige Mission-Lease')
                            saveMissions()
                            return
                        }
                        Object.assign(activeMission, ownership)
                        saveMissions()
                    } catch {
                        activeMission.status = 'paused'
                        activeMission.progressUpdates.push('⏸️ Wiederaufnahme blockiert: Koordination nicht erreichbar')
                        saveMissions()
                        return
                    }
                    void executeNextStep()
                }, 5000)
            }
            // Restore queue
            if (data.queue && Array.isArray(data.queue)) {
                missionQueue = data.queue
                if (missionQueue.length > 0) {
                    console.log(`[Mission] 📋 ${missionQueue.length} queued mission(s) waiting`)
                }
            }
        }
    } catch { /* fresh start */ }

    console.log(`[Mission] ✅ Autonomous Executor initialized (history: ${missionHistory.length} missions)`)
}

// ============================================
// Mission Decomposition (LLM-powered)
// ============================================

async function decomposeMission(goal: string): Promise<MissionStep[]> {
    if (!llmClient) {
        return createFallbackSteps(goal)
    }

    try {
        const response = await llmClient.complete([
            {
                role: 'system',
                content: `Du bist Nova's Mission Planner. Zerlege das Ziel in konkrete, ausführbare Sub-Aufgaben.

REGELN:
- Jeder Schritt muss eine klare, eigenständige Anweisung sein die Nova direkt ausführen kann
- Nutze Nova's vorhandene Tools (create_file, run_command, read_file, web_search, etc.)
- Maximal ${config.maxSteps} Schritte
- Jeder Schritt-Befehl muss so formuliert sein, als würde der User Nova darum bitten
- Schritt 1 sollte immer Vorbereitung/Recherche sein
- Letzter Schritt sollte Zusammenfassung/Verifikation sein

Antworte NUR mit einem JSON-Array in folgendem Format:
[
  {"description": "Was dieser Schritt tut", "command": "Die genaue Anweisung an Nova"},
  ...
]

Kein Text vor oder nach dem JSON.`
            },
            {
                role: 'user',
                content: `Zerlege dieses Ziel in Sub-Aufgaben:\n\n${goal}`
            }
        ])

        const content = response.content || ''

        // Extract JSON array from response
        const jsonMatch = content.match(/\[[\s\S]*\]/)
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.slice(0, config.maxSteps).map((step: any, i: number) => ({
                    id: i + 1,
                    description: step.description || `Schritt ${i + 1}`,
                    command: step.command || step.description,
                    status: 'pending' as const,
                    retries: 0,
                }))
            }
        }
    } catch (err) {
        console.error(`[Mission] ❌ LLM decomposition failed: ${err}`)
    }

    return createFallbackSteps(goal)
}

function createFallbackSteps(goal: string): MissionStep[] {
    return [
        {
            id: 1,
            description: 'Anforderungen analysieren',
            command: `Analysiere folgende Anforderung und erstelle einen Plan: ${goal}`,
            status: 'pending',
            retries: 0,
        },
        {
            id: 2,
            description: 'Aufgabe ausführen',
            command: goal,
            status: 'pending',
            retries: 0,
        },
        {
            id: 3,
            description: 'Ergebnis prüfen',
            command: `Prüfe ob das Ziel erreicht wurde: ${goal.slice(0, 100)}`,
            status: 'pending',
            retries: 0,
        },
    ]
}

// ============================================
// Mission Lifecycle
// ============================================

export async function startMission(goal: string, userId: string, channel: string): Promise<Mission> {
    if (activeMission && activeMission.status === 'active') {
        // Queue the mission instead of erroring
        missionQueue.push({ goal, userId, channel })
        saveMissions()
        console.log(`[Mission] 📋 Queued: "${goal.slice(0, 60)}..." (${missionQueue.length} in queue)`)

        if (notifyUser) {
            await notifyUser(`📋 *Mission in Warteschlange* (Position ${missionQueue.length})\n\n"${goal.slice(0, 100)}"\n\n_Wird automatisch gestartet wenn die aktuelle Mission fertig ist._`).catch(() => { })
        }

        // Return a placeholder for the queued mission
        return {
            id: `q_${Date.now()}`,
            goal,
            summary: goal.slice(0, 150),
            steps: [],
            currentStep: 0,
            status: 'planning' as const,
            createdBy: userId,
            channel,
            createdAt: Date.now(),
            progressUpdates: ['📋 In Warteschlange'],
        }
    }

    console.log(`[Mission] 🚀 Starting mission: "${goal.slice(0, 80)}..."`)

    // Decompose goal into steps
    const steps = await decomposeMission(goal)

    const mission: Mission = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        goal,
        summary: goal.slice(0, 150),
        steps,
        currentStep: 0,
        status: 'active',
        createdBy: userId,
        channel,
        createdAt: Date.now(),
        completedIdempotencyKeys: [],
        pendingActions: steps.map(step => step.command),
        compensationActions: [],
        progressUpdates: [`🚀 Mission gestartet: ${goal.slice(0, 100)}`],
    }

    const goalPlan = getGoalManager().createMissionPlan({
        missionId: mission.id,
        userId,
        goal,
        steps: steps.map(step => ({ title: step.description, nextAction: step.command })),
    })
    mission.rootGoalId = goalPlan.root.id
    for (let index = 0; index < mission.steps.length; index++) mission.steps[index].goalId = goalPlan.steps[index]?.id

    mission.contract = createTaskContract(goal, detectActionIntent(goal), [], {
        id: mission.id,
        budget: { timeoutMs: Math.max(config.timeoutPerStep, config.timeoutPerStep * steps.length), maxToolCalls: Math.max(24, steps.length * 8) },
        allowedChanges: { externalSideEffects: true },
        approvalPolicy: { mode: 'risky_tools', patchGateRequired: true },
    })

    activeMission = mission
    try {
        const { acquireMissionOwnership } = await import('../mesh/mesh-registry.js')
        const ownership = await acquireMissionOwnership(mission.id)
        if (!ownership) throw new Error('keine gültige Mission-Lease')
        Object.assign(mission, ownership)
    } catch (error) {
        activeMission = null
        throw new Error(`Mission start fail-closed: ${error}`)
    }
    saveMissions()
    const missionLedger = getOutcomeLedger()
    missionLedger.start(mission.contract, { channel, userId, backend: 'native-mission' })
    missionLedger.recordPlan(mission.id, {
        steps: steps.map(step => ({ id: step.id, description: step.description })),
        ownerNode: mission.ownerNode,
        leaseEpoch: mission.leaseEpoch,
    })

    // Notify user about the plan
    const planMsg = formatMissionPlan(mission)
    if (notifyUser) {
        await notifyUser(planMsg)
    }

    // Start executing
    setTimeout(() => executeNextStep(), config.delayBetweenSteps)

    return mission
}

export function cancelMission(): string {
    if (!activeMission) return '❌ Keine aktive Mission.'

    activeMission.status = 'cancelled'
    if (activeMission.rootGoalId) getGoalManager().update(activeMission.rootGoalId, { status: 'cancelled' })
    activeMission.finishedAt = Date.now()
    activeMission.totalDuration = activeMission.finishedAt - activeMission.createdAt
    activeMission.progressUpdates.push('🛑 Mission vom Benutzer abgebrochen')

    const cancelledMission = activeMission
    void import('../mesh/leader-election.js').then(({ stopLeaseRenewal }) => stopLeaseRenewal(`mission:${cancelledMission.id}`))
    missionHistory.push(cancelledMission)
    void import('../mesh/mesh-registry.js')
        .then(({ publishMissionCheckpoint }) => publishMissionCheckpoint(cancelledMission as any))
        .catch(() => false)
    const summary = `🛑 Mission abgebrochen: "${activeMission.goal.slice(0, 60)}"\n` +
        `Fortschritt: ${activeMission.steps.filter(s => s.status === 'done').length}/${activeMission.steps.length} Schritte`
    activeMission = null
    isExecuting = false
    saveMissions()
    return summary
}

export function pauseMission(): string {
    if (!activeMission) return '❌ Keine aktive Mission.'
    activeMission.status = 'paused'
    activeMission.progressUpdates.push('⏸️ Mission pausiert')
    saveMissions()
    return `⏸️ Mission pausiert: "${activeMission.goal.slice(0, 60)}"\nFortsetzen mit: /mission resume`
}

export function resumeMission(): string {
    if (!activeMission) return '❌ Keine pausierte Mission.'
    if (activeMission.status !== 'paused') return '❌ Mission ist nicht pausiert.'
    const mission = activeMission
    mission.progressUpdates.push('⏳ Mission-Fencing wird vor dem Fortsetzen erneuert')
    saveMissions()
    setTimeout(async () => {
        const { acquireMissionOwnership } = await import('../mesh/mesh-registry.js')
        const ownership = await acquireMissionOwnership(mission.id)
        if (!ownership || activeMission?.id !== mission.id) {
            mission.progressUpdates.push('⏸️ Fortsetzen abgelehnt: keine gültige Mission-Lease')
            saveMissions()
            return
        }
        Object.assign(mission, ownership)
        mission.status = 'active'
        if (mission.rootGoalId) getGoalManager().update(mission.rootGoalId, { status: 'active' })
        mission.progressUpdates.push('▶️ Mission mit neuer Lease fortgesetzt')
        saveMissions()
        void executeNextStep()
    }, 0)
    return `⏳ Mission wird nach erfolgreicher Lease-Prüfung fortgesetzt: "${activeMission.goal.slice(0, 60)}"`
}

// ============================================
// Step Execution (The Core Engine)
// ============================================

async function executeNextStep(): Promise<void> {
    if (!activeMission || activeMission.status !== 'active') return
    if (isExecuting) return  // Prevent parallel execution
    if (!pipelineHandler || !daemonState) {
        console.error('[Mission] ❌ Pipeline handler not initialized')
        return
    }

    const stepIndex = activeMission.currentStep
    if (stepIndex >= activeMission.steps.length) {
        // All steps done!
        await completeMission()
        return
    }

    const step = activeMission.steps[stepIndex]
    const missionService = `mission:${activeMission.id}`
    const { getServiceFencingToken } = await import('../mesh/leader-election.js')
    let fence = getServiceFencingToken(missionService)
    if (!fence || fence.token !== activeMission.fencingToken || fence.epoch !== activeMission.leaseEpoch) {
        const { acquireMissionOwnership } = await import('../mesh/mesh-registry.js')
        const ownership = await acquireMissionOwnership(activeMission.id)
        if (ownership) {
            Object.assign(activeMission, ownership)
            fence = getServiceFencingToken(missionService)
        }
    }
    if (!fence || fence.token !== activeMission.fencingToken || fence.epoch !== activeMission.leaseEpoch) {
        activeMission.status = 'paused'
        activeMission.progressUpdates.push('⏸️ Ausführung gestoppt: Mission-Fencing ist nicht mehr gültig')
        saveMissions()
        return
    }
    isExecuting = true
    step.status = 'active'
    step.startedAt = Date.now()
    saveMissions()

    console.log(`[Mission] ▶️ Step ${step.id}/${activeMission.steps.length}: ${step.description}`)

    // Capture the response from the pipeline
    let stepResult = ''
    const captureReply = async (msg: string) => {
        stepResult += msg + '\n'
    }

    try {
        step.executionKey ||= `${activeMission.id}:step:${step.id}`
        const missionMarker = `[NOVA_MISSION_KEY:${step.executionKey}]`
        const fenceMarker = `[NOVA_MISSION_FENCE:${activeMission.id}:${activeMission.leaseEpoch}:${activeMission.fencingToken}]`
        // Inject the subtask as a synthetic message into the pipeline
        // We use 'mission' as a special channel marker
        await Promise.race([
            pipelineHandler(
                activeMission.channel,
                activeMission.createdBy,
                `${missionMarker} ${fenceMarker} [MISSION Schritt ${step.id}/${activeMission.steps.length}] ${step.command}`,
                captureReply,
                daemonState
            ),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Step timeout')), config.timeoutPerStep)
            ),
        ])

        // Capture result and require the independent Outcome Ledger validator.
        step.result = stepResult.slice(0, 2000)
        step.finishedAt = Date.now()
        const { getOutcomeLedger } = await import('./outcome-ledger.js')
        const outcome = getOutcomeLedger().listRuns(200).find(run =>
            String(run.contract?.goal || '').includes(missionMarker))
        step.outcomeRunId = outcome?.runId
        const verified = outcome?.status === 'completed' && outcome.validation?.success === true

        if (!verified) {
            step.status = 'failed'
            if (step.goalId) {
                getGoalManager().update(step.goalId, { status: 'failed' }, outcome?.runId
                    ? { runId: outcome.runId, ref: `outcome:${outcome.runId}` }
                    : undefined)
            }
            step.error = outcome
                ? `Outcome ${outcome.runId} not independently validated (${outcome.status})`
                : 'No Outcome Ledger evidence found for mission step'
            activeMission.progressUpdates.push(
                `⚠️ [${step.id}/${activeMission.steps.length}] ${step.description} — nicht verifiziert (${formatDuration(step.finishedAt - step.startedAt!)})`
            )
            console.log(`[Mission] ⚠️ Step ${step.id} has no successful independent validation`)
        } else {
            step.status = 'done'
            if (step.goalId) getGoalManager().update(step.goalId, { status: 'completed' }, { runId: outcome!.runId, ref: `outcome:${outcome!.runId}` })
            activeMission.completedIdempotencyKeys ||= []
            if (step.executionKey && !activeMission.completedIdempotencyKeys.includes(step.executionKey)) {
                activeMission.completedIdempotencyKeys.push(step.executionKey)
            }
            activeMission.pendingActions = activeMission.steps
                .filter(candidate => candidate.status === 'pending' || candidate.status === 'active')
                .map(candidate => candidate.command)
            activeMission.progressUpdates.push(
                `✅ [${step.id}/${activeMission.steps.length}] ${step.description} (${formatDuration(step.finishedAt - step.startedAt!)})`
            )
        }

        console.log(`[Mission] ✅ Step ${step.id} done (${formatDuration(step.finishedAt - step.startedAt!)})`)

    } catch (err) {
        step.retries++
        const errMsg = String(err)
        console.error(`[Mission] ❌ Step ${step.id} failed (retry ${step.retries}/${config.maxRetries}): ${errMsg}`)

        if (step.retries <= config.maxRetries) {
            // Retry
            step.status = 'pending'
            activeMission.progressUpdates.push(
                `🔄 [${step.id}] Retry ${step.retries}/${config.maxRetries}: ${errMsg.slice(0, 100)}`
            )
            isExecuting = false
            setTimeout(() => executeNextStep(), config.delayBetweenSteps * 2)
            saveMissions()
            return
        } else {
            // Max retries exceeded — mark as failed and skip
            step.status = 'failed'
            step.error = errMsg.slice(0, 500)
            if (step.goalId) getGoalManager().update(step.goalId, { status: 'failed' })
            step.finishedAt = Date.now()
            activeMission.progressUpdates.push(
                `❌ [${step.id}] Fehlgeschlagen nach ${config.maxRetries} Versuchen: ${errMsg.slice(0, 100)}`
            )
        }
    }

    isExecuting = false

    // Check if mission was cancelled/paused while step was executing
    // (status may have been changed externally by cancelMission/pauseMission)
    if (!activeMission) {
        console.log('[Mission] 🛑 Mission was cancelled during step execution')
        return
    }
    const currentStatus = activeMission.status as string
    if (currentStatus === 'cancelled' || currentStatus === 'paused') {
        console.log(`[Mission] ${currentStatus === 'cancelled' ? '🛑' : '⏸️'} Mission ${currentStatus} — stopping execution loop`)
        saveMissions()
        return
    }

    // Advance to next step
    activeMission.currentStep++
    saveMissions()

    // Notify user periodically
    if (activeMission.currentStep % config.notifyEveryNSteps === 0 && notifyUser) {
        const progress = formatMissionProgress(activeMission)
        try {
            await notifyUser(progress)
        } catch { /* notification non-critical */ }
    }

    // Continue with next step after delay
    if (activeMission.status === 'active') {
        setTimeout(() => executeNextStep(), config.delayBetweenSteps)
    }
}

async function completeMission(): Promise<void> {
    if (!activeMission) return

    activeMission.finishedAt = Date.now()
    activeMission.totalDuration = activeMission.finishedAt - activeMission.createdAt

    const doneCount = activeMission.steps.filter(s => s.status === 'done').length
    const failedCount = activeMission.steps.filter(s => s.status === 'failed').length
    const totalSteps = activeMission.steps.length

    // Determine mission status based on step results — NOT blindly 'done'
    // Every planned step must cross its own independent validator. A majority
    // of successful steps is progress, not mission completion.
    activeMission.status = failedCount === 0 && doneCount === totalSteps ? 'done' : 'failed'

    const missionLedger = getOutcomeLedger()
    if (activeMission.contract) {
        const verifiedStepRuns = activeMission.steps
            .filter(step => step.status === 'done' && step.outcomeRunId)
            .map(step => step.outcomeRunId!)
        const validation = validateTaskCompletion(activeMission.contract, {
            response: doneCount === totalSteps ? `All ${totalSteps} mission steps completed.` : '',
            verifiedTools: verifiedStepRuns,
            durationMs: activeMission.totalDuration,
            toolCalls: verifiedStepRuns.length,
        })
        if (doneCount !== totalSteps) {
            validation.success = false
            validation.violations.push(`mission incomplete: ${doneCount}/${totalSteps} steps independently validated`)
        }
        missionLedger.recordValidation(activeMission.id, validation)
        if (validation.success) missionLedger.complete(activeMission.id, { success: true, durationMs: activeMission.totalDuration, completedSteps: doneCount })
        else missionLedger.fail(activeMission.id, { success: false, durationMs: activeMission.totalDuration, completedSteps: doneCount, failedSteps: failedCount })
        activeMission.status = validation.success ? 'done' : 'failed'
    }
    if (activeMission.rootGoalId) {
        getGoalManager().update(activeMission.rootGoalId, {
            status: activeMission.status === 'done' ? 'completed' : 'failed',
        }, { runId: activeMission.id, ref: `outcome:${activeMission.id}` })
    }

    const statusIcon = activeMission.status === 'done' ? '🏁' : '❌'
    const statusWord = activeMission.status === 'done' ? 'abgeschlossen' : 'FEHLGESCHLAGEN'
    activeMission.progressUpdates.push(
        `${statusIcon} Mission ${statusWord}: ${doneCount}/${totalSteps} erfolgreich` +
        (failedCount > 0 ? `, ${failedCount} fehlgeschlagen` : '')
    )

    console.log(`[Mission] ${statusIcon} Mission ${statusWord}: "${activeMission.goal.slice(0, 60)}" in ${formatDuration(activeMission.totalDuration)} (${doneCount}/${totalSteps} OK, ${failedCount} failed)`)

    // Send completion report to user
    if (notifyUser) {
        try {
            await notifyUser(formatMissionReport(activeMission))
        } catch { /* non-critical */ }
    }

    // === CONTINUATION CHECK ===
    // Ask LLM if the goal was truly achieved, and if not, auto-start follow-up
    const completedMission = activeMission
    const { stopLeaseRenewal } = await import('../mesh/leader-election.js')
    stopLeaseRenewal(`mission:${completedMission.id}`)
    const continuationCount = (completedMission as any)._continuationCount || 0

    missionHistory.push(completedMission)
    await import('../mesh/mesh-registry.js')
        .then(({ publishMissionCheckpoint }) => publishMissionCheckpoint(completedMission as any))
        .catch(() => false)
    activeMission = null
    isExecuting = false
    saveMissions()

    // Max continuations from config (prevents infinite loops)
    if (continuationCount < config.maxContinuations && llmClient) {
        try {
            const remainingWork = await checkGoalCompletion(completedMission)
            if (remainingWork) {
                console.log(`[Mission] 🔄 Goal not fully achieved. Starting continuation ${continuationCount + 1}/3...`)
                if (notifyUser) {
                    await notifyUser(`🔄 *Ziel noch nicht vollständig erreicht.* Starte Folge-Mission...\n\n_${remainingWork.slice(0, 200)}_`).catch(() => { })
                }

                // Strip any existing "Fortführung:" prefix nesting from the original goal
                const cleanGoal = completedMission.goal.replace(/^(Fortführung:\s*)+/i, '').trim()
                const followUp = await startMission(
                    `Fortführung: ${cleanGoal}\n\nNoch zu tun: ${remainingWork}`,
                    completedMission.createdBy,
                    completedMission.channel
                );
                (followUp as any)._continuationCount = continuationCount + 1
                saveMissions()
            } else {
                console.log(`[Mission] ✅ Goal fully achieved. No continuation needed.`)
                // Ask user what's next
                if (notifyUser) {
                    await notifyUser(`✅ *Ziel vollständig erreicht!*\n\nWas soll ich als Nächstes tun? Du kannst mir ein neues Ziel geben oder /mission [ziel] nutzen.`).catch(() => { })
                }

                // Check queue for next mission
                await startNextQueuedMission()
            }
        } catch (err) {
            console.error(`[Mission] Continuation check failed: ${err}`)
        }
    }

    // If no continuation started, check queue
    if (!activeMission && missionQueue.length > 0) {
        await startNextQueuedMission()
    }
}

async function startNextQueuedMission(): Promise<void> {
    if (missionQueue.length === 0) return
    if (activeMission) return  // Something already started (continuation)

    const next = missionQueue.shift()!
    saveMissions()

    console.log(`[Mission] ▶️ Starting queued mission: "${next.goal.slice(0, 60)}..." (${missionQueue.length} remaining)`)
    if (notifyUser) {
        await notifyUser(`▶️ *Nächste Mission aus Warteschlange:*\n\n"${next.goal.slice(0, 150)}"\n\n_${missionQueue.length} weitere in der Queue._`).catch(() => { })
    }

    try {
        await startMission(next.goal, next.userId, next.channel)
    } catch (err) {
        console.error(`[Mission] Failed to start queued mission: ${err}`)
    }
}

async function checkGoalCompletion(mission: Mission): Promise<string | null> {
    if (!llmClient) return null

    try {
        const stepSummary = mission.steps.map(s => {
            const icon = s.status === 'done' ? '✅' : '❌'
            return `${icon} ${s.description}: ${(s.result || s.error || 'kein Ergebnis').slice(0, 150)}`
        }).join('\n')

        const response = await llmClient.complete([
            {
                role: 'system',
                content: `Du bist Nova's Missions-Evaluator. Prüfe ob ein Ziel WIRKLICH erreicht wurde.

REGELN:
- Prüfe ob die erledigten Schritte das Ziel TATSÄCHLICH erfüllen
- "Recherche" oder "Planung" alleine bedeutet NICHT dass das Ziel erreicht ist
- Wenn Code geschrieben werden sollte, prüfe ob auch tatsächlich Code erstellt wurde
- Wenn eine App gebaut werden sollte, prüfe ob lauffähige Dateien existieren

Antworte mit GENAU einem der folgenden Formate:
- "DONE" — wenn das Ziel vollständig erreicht ist
- "REMAINING: [was noch fehlt]" — wenn noch Arbeit nötig ist`
            },
            {
                role: 'user',
                content: `Ziel: ${mission.goal}\n\nAbgeschlossene Schritte:\n${stepSummary}\n\nIst das Ziel vollständig erreicht?`
            }
        ])

        const content = (response.content || '').trim()
        if (content.startsWith('DONE')) return null
        if (content.startsWith('REMAINING:')) return content.slice(10).trim()

        // If unclear, check if it looks like remaining work
        if (content.length > 20 && !content.toLowerCase().includes('vollständig')) {
            return content
        }
    } catch (err) {
        console.error(`[Mission] Goal evaluation failed: ${err}`)
    }

    return null  // Assume done if we can't evaluate
}

// ============================================
// Formatting
// ============================================

function formatMissionPlan(mission: Mission): string {
    let msg = `🎯 *Nova Mission gestartet*\n\n`
    msg += `*Ziel:* ${mission.goal.slice(0, 200)}\n\n`
    msg += `*Plan (${mission.steps.length} Schritte):*\n`

    for (const step of mission.steps) {
        msg += `  ${step.id}. ${step.description}\n`
    }

    msg += `\n_Ich arbeite jetzt autonom. Fortschritt alle ${config.notifyEveryNSteps} Schritte._\n`
    msg += `_Stoppen: /mission stop | Pause: /mission pause_`
    return msg
}

function formatMissionProgress(mission: Mission): string {
    const done = mission.steps.filter(s => s.status === 'done').length
    const failed = mission.steps.filter(s => s.status === 'failed').length
    const total = mission.steps.length
    const pct = Math.round((done / total) * 100)

    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))

    let msg = `📊 *Mission Progress* [${bar}] ${pct}%\n\n`
    msg += `✅ ${done} | ❌ ${failed} | ⏳ ${total - done - failed} von ${total}\n\n`

    // Show last 3 updates
    const recent = mission.progressUpdates.slice(-3)
    for (const update of recent) {
        msg += `${update}\n`
    }

    const current = mission.steps[mission.currentStep]
    if (current) {
        msg += `\n_Aktuell: ${current.description}_`
    }

    return msg
}

function formatMissionReport(mission: Mission): string {
    const done = mission.steps.filter(s => s.status === 'done').length
    const failed = mission.steps.filter(s => s.status === 'failed').length
    const duration = formatDuration(mission.totalDuration || 0)

    let msg = `🏁 *Mission Abgeschlossen!*\n\n`
    msg += `*Ziel:* ${mission.goal.slice(0, 200)}\n`
    msg += `*Ergebnis:* ${done}/${mission.steps.length} erfolgreich`
    if (failed > 0) msg += ` (${failed} fehlgeschlagen)`
    msg += `\n*Dauer:* ${duration}\n\n`

    msg += `*Schritte:*\n`
    for (const step of mission.steps) {
        const icon = step.status === 'done' ? '✅' : step.status === 'failed' ? '❌' : '⏭️'
        msg += `${icon} ${step.description}\n`
    }

    msg += `\n_Nova hat autonom gearbeitet. Prüfe die Ergebnisse und sag mir ob ich weitermachen soll!_\n`
    msg += `_Neues Ziel: /mission [ziel] | Status: /mission status_`
    return msg
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    if (ms < 3600000) return `${Math.round(ms / 60000)}min`
    return `${(ms / 3600000).toFixed(1)}h`
}

// ============================================
// Status & Query
// ============================================

export function getMissionStatus(): string {
    if (!activeMission) {
        if (missionHistory.length === 0) return '📋 Keine Missionen. Starte eine mit: /mission [ziel]'

        const last = missionHistory[missionHistory.length - 1]
        const icon = last.status === 'done' ? '✅' : last.status === 'cancelled' ? '🛑' : '❌'
        return `📋 Keine aktive Mission.\n\n` +
            `Letzte: ${icon} "${last.goal.slice(0, 60)}"\n` +
            `Neue starten: /mission [ziel]`
    }

    let status = formatMissionProgress(activeMission)
    if (missionQueue.length > 0) {
        status += '\n\n📋 *Warteschlange (' + missionQueue.length + '):*'
        for (const q of missionQueue.slice(0, 3)) {
            status += '\n  • ' + q.goal.slice(0, 60)
        }
        if (missionQueue.length > 3) status += '\n  ... +' + (missionQueue.length - 3) + ' weitere'
    }
    return status
}

export function getMissionHistory(count = 5): string {
    if (missionHistory.length === 0) return '📋 Keine Mission-Historie.'

    let msg = `📋 *Mission-Historie* (letzte ${Math.min(count, missionHistory.length)}):\n\n`
    const recent = missionHistory.slice(-count).reverse()

    for (const m of recent) {
        const icon = m.status === 'done' ? '✅' : m.status === 'cancelled' ? '🛑' : '❌'
        const duration = m.totalDuration ? formatDuration(m.totalDuration) : '?'
        const done = m.steps.filter(s => s.status === 'done').length
        msg += `${icon} "${m.goal.slice(0, 60)}"\n`
        msg += `   ${done}/${m.steps.length} Schritte | ${duration}\n\n`
    }

    return msg
}

export function getActiveMission(): Mission | null {
    return activeMission
}

export function getMissionQueue(): typeof missionQueue {
    return missionQueue
}

export function getMissionData(): { active: Mission | null, history: Mission[] } {
    return { active: activeMission, history: missionHistory }
}

export function shouldRecoverMission(active: Mission | null): boolean {
    return active === null
}

/** Accept a checkpoint only after the mesh worker has obtained a fresh fence. */
export function acceptMissionHandoff(serialized: string, ownership: { ownerNode: string; leaseEpoch?: number; fencingToken?: string }): boolean {
    try {
        const mission = JSON.parse(serialized) as Mission
        if (!mission?.id || !Array.isArray(mission.steps)) return false
        if (activeMission && activeMission.id !== mission.id) return false
        activeMission = {
            ...mission,
            status: mission.status === 'paused' ? 'paused' : 'active',
            ownerNode: ownership.ownerNode,
            leaseEpoch: ownership.leaseEpoch,
            fencingToken: ownership.fencingToken,
            checkpointAt: Date.now(),
        }
        isExecuting = false
        saveMissions()
        if (activeMission.status === 'active') setTimeout(() => { void executeNextStep() }, 1000)
        return true
    } catch { return false }
}

/** Recover the newest durable active checkpoint after this node became Main.
 * Mission-specific lease acquisition prevents two nodes from resuming it. */
export async function recoverMissionFromMesh(): Promise<boolean> {
    // A paused local mission is already reconstructed state. Re-importing the
    // same checkpoint can restart watchers and duplicate progress entries.
    if (!shouldRecoverMission(activeMission)) return false
    const { listRecoverableMissionCheckpoints, acquireMissionOwnership } = await import('../mesh/mesh-registry.js')
    const candidates = await listRecoverableMissionCheckpoints()
    if (candidates.length) {
        console.log(`[Mission] Recovery scan found ${candidates.length} durable checkpoint(s)`)
    }
    for (const candidate of candidates) {
        const ownership = await acquireMissionOwnership(candidate.missionId)
        if (!ownership) {
            console.log(`[Mission] Recovery waiting for fence: ${candidate.missionId}`)
            continue
        }
        if (acceptMissionHandoff(candidate.checkpoint, ownership)) {
            console.log(`[Mission] Recovered ${candidate.missionId} on ${ownership.ownerNode} with epoch ${ownership.leaseEpoch}`)
            return true
        }
    }
    return false
}

/** Retry durable recovery while the promoted Main waits for the previous
 * mission-specific lease to expire. Both leases must be valid before work. */
export function startMissionRecoveryWatcher(intervalMs = 15_000): void {
    if (missionRecoveryTimer) return
    const recover = async () => {
        if (activeMission?.status === 'active') {
            stopMissionRecoveryWatcher()
            return
        }
        if (await recoverMissionFromMesh()) stopMissionRecoveryWatcher()
    }
    void recover().catch(() => false)
    missionRecoveryTimer = setInterval(() => { void recover().catch(() => false) }, Math.max(5_000, intervalMs))
    missionRecoveryTimer.unref?.()
    console.log(`[Mission] Recovery watcher started (every ${Math.max(5_000, intervalMs)}ms)`)
}

export function stopMissionRecoveryWatcher(): void {
    if (missionRecoveryTimer) clearInterval(missionRecoveryTimer)
    missionRecoveryTimer = null
}

export function suspendMissionForLeadershipLoss(): void {
    stopMissionRecoveryWatcher()
    if (!activeMission || activeMission.status !== 'active') return
    activeMission.status = 'paused'
    if (activeMission.rootGoalId) getGoalManager().update(activeMission.rootGoalId, { status: 'blocked' })
    activeMission.progressUpdates.push('⏸️ Mission pausiert: Main-Lease verloren')
    saveMissions()
}

// ============================================
// Persistence
// ============================================

function saveMissions(): void {
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        if (activeMission?.fencingToken) activeMission.checkpointAt = Date.now()
        atomicWriteJsonSync(MISSIONS_FILE, {
            active: activeMission,
            queue: missionQueue,
            history: missionHistory.slice(-50),  // Keep last 50
        })
        if (activeMission?.fencingToken) {
            void import('../mesh/mesh-registry.js')
                .then(({ publishMissionCheckpoint }) => publishMissionCheckpoint(activeMission as any))
                .catch(() => false)
        }
    } catch (err) {
        console.error(`[Mission] Save failed: ${err}`)
    }
}

// ============================================
// Config
// ============================================

export function updateMissionConfig(updates: Partial<MissionConfig>): void {
    config = { ...config, ...updates }
    // Persist to disk
    try {
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(MISSION_CONFIG_FILE, JSON.stringify(config, null, 2))
    } catch { /* non-critical */ }
    console.log(`[Mission] Config updated: continuations=${config.maxContinuations}, steps=${config.maxSteps}, timeout=${config.timeoutPerStep}ms`)
}

export function getMissionConfig(): MissionConfig {
    return { ...config }
}

export function formatMissionConfig(): string {
    const c = config
    let msg = `⚙️ *Mission-Konfiguration*\n\n`
    msg += `🔄 *Continuations:* ${c.maxContinuations}\n`
    msg += `   _Wie oft Nova nach Abschluss weitermacht_\n\n`
    msg += `📝 *Steps:* ${c.maxSteps}\n`
    msg += `   _Max. Teilaufgaben pro Mission_\n\n`
    msg += `🔁 *Retries:* ${c.maxRetries}\n`
    msg += `   _Wiederholungen bei Fehler pro Step_\n\n`
    msg += `⏱️ *Timeout:* ${Math.round(c.timeoutPerStep / 1000)}s\n`
    msg += `   _Max. Zeit pro Teilaufgabe_\n\n`
    msg += `⏳ *Delay:* ${Math.round(c.delayBetweenSteps / 1000)}s\n`
    msg += `   _Pause zwischen Steps_\n\n`
    msg += `📊 *Notify:* alle ${c.notifyEveryNSteps} Steps\n`
    msg += `   _Fortschritts-Updates_\n\n`
    msg += `✅ *Enabled:* ${c.enabled}`
    return msg
}

// ============================================
// Export
// ============================================

export default {
    initMissionEngine,
    startMission,
    cancelMission,
    pauseMission,
    resumeMission,
    getMissionStatus,
    getMissionHistory,
    getActiveMission,
    getMissionData,
    acceptMissionHandoff,
    recoverMissionFromMesh,
    startMissionRecoveryWatcher,
    stopMissionRecoveryWatcher,
    suspendMissionForLeadershipLoss,
    updateMissionConfig,
    getMissionConfig,
    formatMissionConfig,
}
