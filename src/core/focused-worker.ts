import type { DispatchPlan } from './intent-dispatcher.js'
import { getToolRegistry } from '../tools/complete-registry.js'

/** The only component that converts a dispatch allow-list into executable
 * tool definitions. It cannot widen the contract during a task. */
export class FocusedWorker {
    constructor(readonly plan: DispatchPlan) {}

    getTools() {
        const allowed = new Set(this.plan.allowedTools)
        return Object.freeze(getToolRegistry().getAll().filter(tool => allowed.has(tool.name)))
    }
}
