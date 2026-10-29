import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 2.90.1 (Codekarte D5): after the vault move providers.minimax carries only an apiKeyRef. getMiniMaxKey read
// the plaintext field and MINIMAX_API_KEY only, so TTS/image/video found no key although the LLM (cloudProviderKey)
// did. The MiniMax tools read the one LLM key resolver.
const resolver = vi.hoisted(() => ({ calls: [] as Array<{ name: string; section: any }> }))
vi.mock('../core/llm-factory.js', async importOriginal => ({
    ...(await importOriginal<object>()),
    cloudProviderKey: (name: string, section?: any) => { resolver.calls.push({ name, section }); return section?.apiKeyRef ? 'from-vault' : '' },
}))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resolver.calls.length = 0 })

describe('MiniMax tools find the key in the vault', () => {
    it('a vault reference alone is enough', async () => {
        const root = mkdtempSync(join(tmpdir(), 'minimax-key-'))
        writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify({ providers: { minimax: { apiKeyRef: 'auth:provider-minimax' } } }))
        vi.spyOn(process, 'cwd').mockReturnValue(root)
        vi.stubEnv('MINIMAX_API_KEY', '')
        const { hasMiniMaxKey } = await import('./minimax-tools.js')
        expect(hasMiniMaxKey(Date.now() + 10 * 60_000)).toBe(true)
        expect(resolver.calls.some(call => call.name === 'minimax')).toBe(true)
    })
})
