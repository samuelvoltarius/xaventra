import { describe, expect, it, vi } from 'vitest'

const exec = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async importOriginal => ({ ...(await importOriginal<object>()), exec }))
vi.mock('child_process', async importOriginal => ({ ...(await importOriginal<object>()), exec }))

import { executeRemote } from './mesh-router.js'

describe('mesh-router executeRemote (R2)', () => {
    it('refuses instead of building a shell string from registry data', async () => {
        const result = await executeRemote({ isLocal: false, host: 'x;id', sshUser: 'u', nodeId: 'n' } as any, 'id')
        expect(result.success).toBe(false)
        expect(result.output).toMatch(/signierten Mesh-Transport/)
        expect(exec).not.toHaveBeenCalled()
    })
})
