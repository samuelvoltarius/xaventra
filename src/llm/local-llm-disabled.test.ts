import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLocalLLMs } from './local-llm.js'

// 2.90.1 (Peer-Test 29.10.): with providers.local.enabled = false the discovery still probed the presets and the
// host's Ollama landed in the router. Switched off means: no probe, no local model (as 2.89.14 for the fallback).
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const withConfig = (config: unknown) => {
    const root = mkdtempSync(join(tmpdir(), 'local-off-'))
    writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(config))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
}

describe('local model discovery respects providers.local.enabled', () => {
    it('probes nothing when the local provider is switched off', async () => {
        withConfig({ providers: { local: { enabled: false } } })
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        expect(await detectLocalLLMs()).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
