/** Share one pending lifecycle operation per runtime, including error cleanup. */
export function createSingleFlight<T extends object>() {
    const pending = new WeakMap<T, Promise<void>>()
    return (key: T, operation: () => Promise<void>): Promise<void> => {
        const existing = pending.get(key)
        if (existing) return existing
        const running = Promise.resolve().then(operation).finally(() => {
            if (pending.get(key) === running) pending.delete(key)
        })
        pending.set(key, running)
        return running
    }
}
