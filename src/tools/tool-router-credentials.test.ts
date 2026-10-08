import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.resetModules(); vi.doUnmock('./minimax-tools.js') })

describe('2.89.3: tools without a configured key are not offered', () => {
    it('minimax_vision stays out of a picture request when no MiniMax key exists, analyze_image stays in', async () => {
        vi.resetModules()
        const real = await vi.importActual<typeof import('./minimax-tools.js')>('./minimax-tools.js')
        vi.doMock('./minimax-tools.js', () => ({ ...real, hasMiniMaxKey: () => false }))
        const { getRelevantTools } = await import('./tool-router.js')
        const names = getRelevantTools('was siehst du auf diesem Bild? analysiere das Foto').map(tool => tool.name)
        expect(names).toContain('analyze_image')
        expect(names.filter(name => name.startsWith('minimax_'))).toEqual([])
    })

    it('with a key the MiniMax tools are routed as before', async () => {
        vi.resetModules()
        const real = await vi.importActual<typeof import('./minimax-tools.js')>('./minimax-tools.js')
        vi.doMock('./minimax-tools.js', () => ({ ...real, hasMiniMaxKey: () => true }))
        const { getRelevantTools } = await import('./tool-router.js')
        const names = getRelevantTools('was siehst du auf diesem Bild? analysiere das Foto').map(tool => tool.name)
        expect(names).toContain('minimax_vision')
    })
})
