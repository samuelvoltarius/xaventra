import { detectActionIntent, type ActionIntent } from './action-intent.js'
import { getRelevantTools } from '../tools/tool-router.js'

export interface DispatchPlan {
    taskContext: string
    intent: ActionIntent
    allowedTools: readonly string[]
    createdAt: number
}

/** Pure dispatcher: it can inspect capability metadata, but owns no registry
 * executor and therefore cannot perform side effects. */
export class IntentDispatcher {
    dispatch(taskContext: string, routingContext = taskContext): DispatchPlan {
        const tools = getRelevantTools(routingContext, taskContext)
        return Object.freeze({
            taskContext,
            intent: detectActionIntent(taskContext),
            allowedTools: Object.freeze(tools.map(tool => tool.name)),
            createdAt: Date.now(),
        })
    }
}
