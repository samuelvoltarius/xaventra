import { describe, expect, it } from 'vitest'

// 2.89: process_list is on the read-only automation list, so it must only read —
// the filter used to be pasted into a shell pipe (… | grep -i "<filter>").
describe('process_list only reads the process table', () => {
    it('a filter with shell syntax is matched as text, never run', async () => {
        const { getToolRegistry } = await import('./complete-registry.js')
        const tool = getToolRegistry().get('process_list') as any
        const marker = 'XV_INJECTED_' + 'x'.repeat(8)
        const result = await tool.handler({ filter: `zz"; echo ${marker}; echo "` })
        expect(result.success).toBe(true)
        expect(String(result.output)).not.toContain(marker)
    }, 20_000)
    it('without a filter it lists processes (Gegenprobe)', async () => {
        const { getToolRegistry } = await import('./complete-registry.js')
        const result = await (getToolRegistry().get('process_list') as any).handler({})
        expect(result.success).toBe(true)
        expect(String(result.output).length).toBeGreaterThan(0)
    }, 20_000)
})
