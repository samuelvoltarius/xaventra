export type EffectDisposer = () => void | Promise<void>

/** Deterministic lifetime boundary for plugins and runtime capabilities. */
export class EffectScope {
    private readonly effects: Array<{ label: string; dispose: EffectDisposer }> = []
    private disposed = false
    private readonly controller = new AbortController()
    readonly signal: AbortSignal = this.controller.signal

    constructor(readonly id: string) {}

    get active(): boolean { return !this.disposed }

    effect(dispose: EffectDisposer, label = 'effect'): () => void {
        if (this.disposed) throw new Error(`Effect scope already disposed: ${this.id}`)
        const entry = { label, dispose }
        this.effects.push(entry)
        let released = false
        return () => {
            if (released) return
            released = true
            const index = this.effects.indexOf(entry)
            if (index >= 0) this.effects.splice(index, 1)
            void Promise.resolve(dispose()).catch(() => undefined)
        }
    }

    child(label: string): EffectScope {
        const child = new EffectScope(`${this.id}/${label}`)
        this.effect(() => child.dispose(), `child:${label}`)
        return child
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        this.controller.abort(new Error(`Effect scope disposed: ${this.id}`))
        const failures: Error[] = []
        for (const effect of this.effects.splice(0).reverse()) {
            try { await effect.dispose() }
            catch (error) { failures.push(error instanceof Error ? error : new Error(String(error))) }
        }
        if (failures.length) throw new AggregateError(failures, `Effect scope ${this.id} cleanup failed`)
    }

    describe(): { id: string; active: boolean; effects: string[] } {
        return { id: this.id, active: this.active, effects: this.effects.map(effect => effect.label) }
    }
}
