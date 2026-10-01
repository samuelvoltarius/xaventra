/**
 * Public planner API (Phase 1). For the card layer (`/gedanken`, buttons,
 * live status) and the Main's channel wiring:
 *
 *   import { listThoughts, setThoughtStatus, setPlannerDeliveryPort } from '../planner/index.js'
 *
 * Thoughts are file based (<data>/thoughts/thoughts.json), so reading works
 * on any node and without a running planner; only the planner tick on the
 * fenced Main announces them. Formats: docs/AUTONOMY_GUIDE.md "Planer".
 */

import { getNovaDataDir } from '../core/data-root.js'
import { getPlannerRuntime } from './runtime.js'
import { createThoughtStore, type NewThought, type Thought, type ThoughtListFilter, type ThoughtStatus, type ThoughtStore } from './thoughts.js'

export { getPlannerDeliveryPort, setPlannerDeliveryPort } from './delivery-port.js'
export type { DeliveryPort, DeliveryReceipt, DeliveryStatus, OutgoingKind, PlannerOutgoing } from './delivery-port.js'
export type { JobSchedule, PlannerJob } from './planner.js'
export { getPlannerRuntime, parsePlannerSettings, startPlannerRuntime, stopPlannerRuntime } from './runtime.js'
export type { Thought, ThoughtImportance, ThoughtNotice, ThoughtPermission, ThoughtStatus } from './thoughts.js'
export { formatThoughtText, isOpenThought, THOUGHT_ID_PATTERN } from './thoughts.js'

/** The running planner's store, or a file store on the default data dir. */
export function getThoughtStore(dataDir?: string): ThoughtStore {
    const runtime = getPlannerRuntime()
    if (runtime && !dataDir) return runtime.thoughts
    return createThoughtStore({ dataDir: dataDir ?? getNovaDataDir(), settings: runtime?.settings.thoughts })
}

export function addThought(input: NewThought): { thought: Thought; deduped: boolean } {
    return getThoughtStore().add(input)
}

export function listThoughts(filter?: ThoughtListFilter): Thought[] {
    return getThoughtStore().list(filter)
}

export function getThought(id: string): Thought | null {
    return getThoughtStore().get(id)
}

/** Status change by code (card button handler, owner command). `by` is a
 * short actor label such as `owner:<id>` or `karte`, never free model text. */
export function setThoughtStatus(id: string, status: ThoughtStatus, by: string): Thought | null {
    return getThoughtStore().setStatus(id, status, by)
}
