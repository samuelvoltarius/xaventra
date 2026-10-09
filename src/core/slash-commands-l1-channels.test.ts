import { describe, expect, it } from 'vitest'

// 2.89.4 (live): `/layers` answered „L1 Unified Channels: ❌" while Telegram was
// running. The line read the never-assigned `state.channelRouter`. L1 is the
// real adapters in `state.channels`.

const { handleCommand, listRunningChannels } = await import('./slash-commands.js')

const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }

function state(channels: Record<string, unknown>): any {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null, ...channels },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {},
    }
}

describe('listRunningChannels reports the real adapters', () => {
    it('is empty when nothing started', () => {
        expect(listRunningChannels(state({}))).toEqual([])
        expect(listRunningChannels(null)).toEqual([])
        expect(listRunningChannels(undefined)).toEqual([])
    })

    it('names only the adapters that actually run', () => {
        expect(listRunningChannels(state({ telegram: { id: 'tg' } }))).toEqual(['Telegram'])
        expect(listRunningChannels(state({ telegram: { id: 'tg' }, whatsapp: { id: 'wa' } }))).toEqual(['Telegram', 'WhatsApp'])
        expect(listRunningChannels(state({ discord: { id: 'dc' } }))).toEqual(['Discord'])
    })
})

describe('/layers L1 Unified Channels comes from state.channels', () => {
    it('shows ✅ Telegram when the Telegram adapter is up (live: always ❌)', async () => {
        const text = String(await handleCommand('layers', '', 'owner-1', state({ telegram: { id: 'tg' } }), [], owner))
        expect(text).toMatch(/L1 Unified Channels: ✅ Telegram/)
        expect(text).not.toMatch(/L1 Unified Channels: ❌/)
    })

    it('lists every running adapter and stays ❌ when none run', async () => {
        const both = String(await handleCommand('layers', '', 'owner-1', state({ telegram: { id: 'tg' }, discord: { id: 'dc' } }), [], owner))
        expect(both).toMatch(/L1 Unified Channels: ✅ Telegram, Discord/)
        const none = String(await handleCommand('layers', '', 'owner-1', state({}), [], owner))
        expect(none).toMatch(/L1 Unified Channels: ❌/)
    })
})

describe('/status Channels and layer count use the same truth', () => {
    it('names the running channel and counts L1 as active', async () => {
        const text = String(await handleCommand('status', '', 'owner-1', state({ telegram: { id: 'tg' } }), [], owner))
        expect(text).toMatch(/\*Channels:\* Telegram/)
        expect(text).toMatch(/Layers aktiv: \d+\/\d+/)
        // L1 is one of the counted layers — with Telegram up it is active.
        const active = Number(text.match(/Layers aktiv: (\d+)\//)?.[1] || '0')
        const without = String(await handleCommand('status', '', 'owner-1', state({}), [], owner))
        const activeWithout = Number(without.match(/Layers aktiv: (\d+)\//)?.[1] || '0')
        expect(active).toBe(activeWithout + 1)
    })

    it('says „keine“ when no channel adapter is up', async () => {
        const text = String(await handleCommand('status', '', 'owner-1', state({}), [], owner))
        expect(text).toMatch(/\*Channels:\* keine/)
    })
})
