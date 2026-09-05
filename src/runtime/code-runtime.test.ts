import { describe, expect, it } from 'vitest'
import { CodeRuntime, type CodeRuntimeProvider } from './code-runtime.js'

describe('CodeRuntime seam', () => {
    it('routes only to a provider supporting the requested language', async () => {
        const runtime = new CodeRuntime()
        const provider: CodeRuntimeProvider = {
            name: 'fake', languages: ['javascript'],
            execute: async () => ({ provider: 'fake', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
        }
        runtime.register(provider)
        await expect(runtime.execute({ language: 'javascript', code: '1' }, 'fake')).resolves.toMatchObject({ stdout: 'ok' })
        await expect(runtime.execute({ language: 'javascript', code: '1' }, 'missing')).rejects.toThrow(/unavailable/)
    })
})
