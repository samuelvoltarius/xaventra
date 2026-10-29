/**
 * 2.90.0 one place for „Kontext je Aufgabe“ in a turn: Lagebild, task prompt
 * and the measurement line. The pipeline calls `prepareTurnPrompt` right
 * before the prompt budget and `record` after the agent run.
 *
 * Every step is optional and fails closed to the old prompt: a broken switch,
 * route or cache never changes or stops a turn.
 */
import type { PromptBudgetResult } from './prompt-budget.js'
import type { ContextPolicy } from './context-policy.js'
import { contextSwitch } from './context-switches.js'
import { recordContextMetrics, type ContextTurnMetrics } from './context-metrics.js'
import { taskPromptForRequest, type TaskPromptRouter } from './task-prompt.js'
import { cachedLagebildBlock, replaceStaticEnvironment } from './lagebild.js'
import { currentTraceId } from './request-tracer.js'

/** What the runner measured (AgentResponse.contextStats). */
export interface RunnerContextStats {
    modelInputChars: number
    systemChars: number
    historyChars: number
    toolSchemaChars: number
    toolsOffered: number
    modelCalls: number
    maxModelInputChars: number
    toolCalls: number
    selfInfoCalls: number
}

export interface TurnContext {
    prompt: string
    metrics: Partial<ContextTurnMetrics>
    afterCap(sections: PromptBudgetResult['sections'] | null, sentChars: number, cap: number): void
    record(input: { channel: string; outcome: ContextTurnMetrics['outcome']; durationMs: number; stats?: Partial<RunnerContextStats> }, options?: { dir?: string }): void
}

export async function prepareTurnPrompt(input: {
    prompt: string
    request: string
    policy: ContextPolicy
    toolNames?: readonly string[]
    env?: NodeJS.ProcessEnv
    lagebildBlock?: () => string | null
    /** Tests inject the router; live it is loaded here, inside the guarded step. */
    router?: TaskPromptRouter
}): Promise<TurnContext> {
    const raw = input.prompt
    let prompt = raw
    const metrics: Partial<ContextTurnMetrics> = { promptRawChars: raw.length, mode: input.policy?.mode, taskClass: input.policy?.taskClass }
    let taskKept: string[] = []

    const lagebild = contextSwitch('lagebild', { env: input.env })
    metrics.lagebildMode = lagebild
    if (lagebild === 'on') try {
        const block = (input.lagebildBlock ?? cachedLagebildBlock)()
        metrics.lagebildChars = block ? block.length : 0
        if (block) prompt = replaceStaticEnvironment(prompt, block)
    } catch (error) { console.debug('[TurnContext] Lagebild skipped:', error) }

    const taskMode = contextSwitch('taskPrompt', { env: input.env })
    if (taskMode !== 'off') try {
        const router = input.router ?? await import('../tools/tool-router.js')
        const task = taskPromptForRequest(prompt, input.request, { router, toolNames: input.toolNames, policy: input.policy })
        metrics.taskPromptMode = taskMode
        metrics.taskPromptChars = task.prompt.length
        metrics.taskPromptTopics = task.topics
        metrics.taskPromptOmitted = task.omitted.length
        metrics.taskPromptUntagged = task.untagged
        taskKept = task.kept
        if (taskMode === 'on') prompt = task.prompt
    } catch (error) {
        console.debug('[TurnContext] task prompt skipped:', error)
        metrics.taskPromptMode = taskMode
        metrics.taskPromptChars = undefined
    }

    return {
        prompt,
        metrics,
        afterCap(sections, sentChars, cap) {
            const reduced = sections?.reduced ?? []
            metrics.promptCap = cap
            metrics.promptSentChars = sentChars
            metrics.capped = reduced.length > 0 || sentChars < prompt.length
            metrics.cappedBlocks = reduced.length
            metrics.reducedHeadings = reduced
            if (typeof metrics.taskPromptChars === 'number') {
                metrics.taskPromptWouldCap = metrics.taskPromptChars > cap
                // In shadow: the blocks the cap cut that the task prompt would have kept.
                metrics.taskPromptRescued = metrics.taskPromptMode === 'shadow' ? reduced.filter(heading => taskKept.includes(heading)) : []
            }
        },
        record({ channel, outcome, durationMs, stats }, options = {}) {
            try {
                recordContextMetrics({
                    at: new Date().toISOString(),
                    traceId: currentTraceId(),
                    channel,
                    mode: String(metrics.mode ?? ''),
                    taskClass: metrics.taskClass,
                    promptRawChars: metrics.promptRawChars ?? raw.length,
                    promptSentChars: metrics.promptSentChars ?? prompt.length,
                    promptCap: metrics.promptCap ?? 0,
                    capped: metrics.capped ?? false,
                    cappedBlocks: metrics.cappedBlocks ?? 0,
                    reducedHeadings: metrics.reducedHeadings,
                    ...stats,
                    outcome,
                    durationMs,
                    taskPromptMode: metrics.taskPromptMode,
                    taskPromptChars: metrics.taskPromptChars,
                    taskPromptWouldCap: metrics.taskPromptWouldCap,
                    taskPromptTopics: metrics.taskPromptTopics,
                    taskPromptOmitted: metrics.taskPromptOmitted,
                    taskPromptRescued: metrics.taskPromptRescued,
                    taskPromptUntagged: metrics.taskPromptUntagged,
                    lagebildMode: metrics.lagebildMode,
                    lagebildChars: metrics.lagebildChars,
                }, { dir: options.dir })
            } catch (error) { console.debug('[TurnContext] metrics skipped:', error) }
        },
    }
}
