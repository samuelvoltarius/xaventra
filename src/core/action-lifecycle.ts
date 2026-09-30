import { toolProvidesActionEvidence } from './action-intent.js'
import { FENCE_EXEMPT_READ_ONLY_TOOLS } from '../mesh/fence.js'

export type ActionPhase = 'discover' | 'resolve' | 'execute' | 'verify' | 'learn' | 'awaiting_approval' | 'failed'

export interface ActionLifecycleSnapshot {
    phase: ActionPhase
    discovered: string[]
    attempted: string[]
    verified: string[]
    failures: string[]
}

const DISCOVERY = new Set(['nova_capabilities', 'find_capability', 'load_skill_pack', 'list_custom_tools'])
const RESOLUTION = new Set(['resolve_capability', 'build_skill', 'create_skill', 'load_skills'])

/** A failed read-only lookup is data for the model, not a reason to stop the
 * run. Live 01.10.2026 load_skill_pack("system") (no such pack) stopped a
 * screenshot request before desktop_screenshot was ever called. Effects and
 * unknown tools still stop. */
export function readOnlyFailureContinues(toolName: string): boolean {
    return DISCOVERY.has(toolName) || FENCE_EXEMPT_READ_ONLY_TOOLS.has(toolName)
}

export class ActionLifecycle {
    private snapshot: ActionLifecycleSnapshot = {
        phase: 'discover', discovered: [], attempted: [], verified: [], failures: [],
    }

    record(toolName: string, success: boolean): void {
        if (DISCOVERY.has(toolName)) {
            this.snapshot.discovered.push(toolName)
            this.snapshot.phase = success ? 'resolve' : 'failed'
            if (!success) this.snapshot.failures.push(toolName)
            return
        }
        if (RESOLUTION.has(toolName)) {
            this.snapshot.attempted.push(toolName)
            this.snapshot.phase = success && (toolName === 'build_skill' || toolName === 'create_skill')
                ? 'awaiting_approval'
                : success ? 'resolve' : 'failed'
            if (!success) this.snapshot.failures.push(toolName)
            return
        }

        this.snapshot.attempted.push(toolName)
        this.snapshot.phase = 'execute'
        if (success && toolProvidesActionEvidence(toolName)) {
            this.snapshot.verified.push(toolName)
            this.snapshot.phase = 'verify'
        } else if (!success) {
            this.snapshot.failures.push(toolName)
            this.snapshot.phase = 'failed'
        }
    }

    canLearn(toolName: string, success: boolean): boolean {
        return success && this.snapshot.phase === 'verify' && this.snapshot.verified.includes(toolName)
    }

    markLearned(): void {
        if (this.snapshot.phase === 'verify') this.snapshot.phase = 'learn'
    }

    isFulfilled(): boolean {
        return this.snapshot.verified.length > 0
    }

    isAwaitingApproval(): boolean {
        return this.snapshot.phase === 'awaiting_approval'
    }

    getSnapshot(): Readonly<ActionLifecycleSnapshot> {
        return Object.freeze({
            ...this.snapshot,
            discovered: [...this.snapshot.discovered], attempted: [...this.snapshot.attempted],
            verified: [...this.snapshot.verified], failures: [...this.snapshot.failures],
        })
    }
}
