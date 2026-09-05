let ready = false
let generation = 0
let resolveReady: (() => void) | null = null
let readyPromise = new Promise<void>(resolve => { resolveReady = resolve })

export function isRuntimeReady(): boolean {
    return ready
}

export function markRuntimeReady(): void {
    if (ready) return
    ready = true
    resolveReady?.()
    resolveReady = null
    console.log(`[RuntimeReady] ✅ Runtime generation ${generation} ready`)
}

export function markRuntimeNotReady(): void {
    generation++
    ready = false
    readyPromise = new Promise<void>(resolve => { resolveReady = resolve })
}

export async function awaitRuntimeReady(timeoutMs = 180_000): Promise<void> {
    if (ready) return
    await Promise.race([
        readyPromise,
        new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error(`Runtime did not become ready within ${timeoutMs}ms`)),
            timeoutMs,
        )),
    ])
}

