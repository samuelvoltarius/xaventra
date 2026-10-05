/** Exact local controls only; never route arbitrary slash requests around queues. */
export function isImmediateControl(content: string): boolean {
    return /^\/(?:log|status|cancel)\s*$/i.test(content.trim())
}
