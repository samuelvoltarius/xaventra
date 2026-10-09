import { describe, expect, it, vi } from 'vitest'

// 2.89: slim containers (worker images, the repair sandbox) have no `ps`; process_list
// then reads /proc instead of failing — a failing read-only tool stops a self-goal run.
vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>()
    return {
        ...actual,
        execFileSync: (file: string, ...rest: any[]) => {
            if (file === 'ps') throw Object.assign(new Error('spawnSync ps ENOENT'), { code: 'ENOENT' })
            return (actual.execFileSync as any)(file, ...rest)
        },
    }
})

describe('process_list without ps', () => {
    it.runIf(process.platform === 'linux')('lists processes from /proc', async () => {
        const { getToolRegistry } = await import('./complete-registry.js')
        const result = await (getToolRegistry().get('process_list') as any).handler({})
        expect(result.success).toBe(true)
        expect(String(result.output)).toMatch(/^PID COMMAND/)
        // The unfiltered output is deliberately bounded; a busy CI runner can
        // place this process beyond that bound. Filtering happens before it.
        const own = await (getToolRegistry().get('process_list') as any).handler({ filter: `${process.pid} ` })
        expect(own.success).toBe(true)
        expect(String(own.output)).toMatch(new RegExp(`^${process.pid} .+`, 'm'))
    }, 20_000)
    it.runIf(process.platform !== 'linux' && process.platform !== 'win32')('elsewhere a missing ps stays an honest error', async () => {
        const { getToolRegistry } = await import('./complete-registry.js')
        const result = await (getToolRegistry().get('process_list') as any).handler({})
        expect(result.success).toBe(false)
    }, 20_000)
})
