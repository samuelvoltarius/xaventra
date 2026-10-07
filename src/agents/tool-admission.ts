/**
 * 2.89 „Jedes Werkzeug erreichbar“: tools that join a RUNNING request.
 *
 * The router offers a bounded set per request. Two ways add more while the
 * request runs, both through this one gate:
 * - load_skill_pack: the model loads a pack; its tools are offered from the
 *   next model step on.
 * - a call to a registered tool that was not offered: admitted instead of
 *   aborting the run.
 * A tool joins only when it is registered, not denied for this backend/bot,
 * not excluded by the route (e.g. send_file on a desktop capture), allowed for
 * the caller's role and not denied by the tool policy. The run must be a normal
 * user request: binding outer contracts, internal/benchmark/diagnostic runs and
 * sealed routes (node screenshots, direct URL checks) never expand. Everything
 * admitted still passes the Execution Kernel budgets and the per-call
 * authorization before any effect.
 */

export interface ToolAdmissionOptions {
    /** Names offered by the router for this request. */
    offered: readonly string[]
    /** Registered tools the request may load on demand. */
    registered: readonly string[]
    enabled: boolean
    denied?: Iterable<string>
    excluded?: Iterable<string>
    /** Role and policy check for the caller; false keeps the tool out. */
    allows: (name: string) => boolean
    /** Adds the tools to the running contract (ExecutionKernel.admitTools). */
    onAdmit?: (names: string[], reason: ToolAdmissionReason) => void
}

export type ToolAdmissionReason = 'load_skill_pack' | 'model-call'

export class ToolAdmission {
    private readonly active: Set<string>
    private readonly admissible: Set<string>
    readonly admitted: Array<{ name: string; reason: ToolAdmissionReason }> = []

    constructor(private readonly options: ToolAdmissionOptions) {
        this.active = new Set(options.offered)
        const blocked = new Set([...(options.denied || []), ...(options.excluded || [])])
        this.admissible = new Set(options.enabled
            ? options.registered.filter(name => !this.active.has(name) && !blocked.has(name))
            : [])
    }

    /** Tools the SDK agent carries beyond the offered ones. */
    candidates(): string[] { return [...this.admissible] }

    isOffered(name: string): boolean { return this.active.has(name) }

    admit(names: readonly string[], reason: ToolAdmissionReason): string[] {
        const added: string[] = []
        for (const name of new Set(names)) {
            if (this.active.has(name) || !this.admissible.has(name)) continue
            let allowed = false
            try { allowed = this.options.allows(name) } catch { allowed = false }
            if (!allowed) continue
            this.active.add(name)
            added.push(name)
            this.admitted.push({ name, reason })
        }
        if (added.length) {
            this.options.onAdmit?.(added, reason)
            console.log(`[ToolAdmission] +${added.length} (${reason}): ${added.join(', ')}`)
        }
        return added
    }
}
