/**
 * 2.89.4 (live 09.10. 00:51–00:53) over the REAL entry (createDaemonMessageEntry →
 * message-pipeline → runNovaAgent, Telegram input, scripted model): a workstation
 * action order after a DHL tracking request must offer and use desktop_control —
 * not only desktop_screenshot. A run that only looked gets one forced action retry
 * or an honest sentence. Only the model and the desktop_* handlers are fake.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { SCREEN_ONLY_ACTION_REPLY } from '../core/unverified-claims.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
const T = 90_000

/** Fake the workstation tools and unlock them for the Telegram owner (policy still runs). */
async function fakeDesktop(e2e: E2EHarness) {
    const { loadPolicy } = await e2e.module('tools/tool-policy.js')
    loadPolicy({
        toolPolicy: {
            rules: [
                { tool: 'desktop_*', action: 'allow' },
                { tool: 'screen_capture', action: 'allow' },
            ],
        },
    })
    const calls: Array<{ name: string; args: any }> = []
    const replace = async (name: string, result: any) => {
        const original = e2e.state.tools.get(name)
        expect(original, `tool ${name} must be registered`).toBeTruthy()
        e2e.state.tools.register({
            ...original,
            handler: async (args: any) => { calls.push({ name, args }); return result },
        })
    }
    await replace('desktop_screenshot', {
        success: true, screenshotPath: 'e2e-shot.png', size: 12, sha256: 'e2e',
        message: 'Leerer Desktop, kein Browserfenster geöffnet.',
    })
    await replace('desktop_control', { success: true, queued: true, commandId: 'e2e-cmd', action: 'navigate' })
    await replace('desktop_workspace', { success: true, kind: 'workspace_result', entries: [] })
    await replace('desktop_status', { success: true, commands: [] })
    await replace('desktop_input', { success: true, status: 'executed', executedNow: true })
    return calls
}

describe('2.89.4 Handlung am Arbeitsplatz (real entry)', () => {
    it('„mach es auf und versuch es nochmal“ after DHL — desktop_control offered and used, not only a screenshot', async () => {
        h = await createE2EHarness()
        const calls = await fakeDesktop(h)
        await h.telegram('Verfolge DHL 12345678', [
            { tool: 'parcel_track', args: { provider: 'dhl', tracking_number: '12345678' } },
            { text: 'Die Sendung ist unterwegs.' },
        ])
        const result = await h.telegram('Sie hat Computer-Use … dann mach es auf und versuch es nochmal', [
            { tools: [
                { name: 'desktop_control', arguments: { action: 'notify', message: 'Browser öffnen' } },
                { name: 'desktop_input', arguments: { action: JSON.stringify({ action: 'type', text: 'https://example.com/track/12345678' }), step: 'open-url' } },
            ] },
            { text: 'Ich habe den Browser geöffnet und die Sendungsverfolgung aufgerufen: Zustellung morgen.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.offeredTools).toContain('desktop_control')
        expect(result.offeredTools).toContain('desktop_workspace')
        expect(result.executedTools).toContain('desktop_control')
        expect(calls.some(call => call.name === 'desktop_control')).toBe(true)
        expect(result.final).toContain('Zustellung morgen')
        expect(result.final).not.toBe(SCREEN_ONLY_ACTION_REPLY)
        expect(result.final).not.toMatch(/kein Browserfenster/i)
    }, T)

    it('screenshot-only run gets one forced action retry and then reports the action', async () => {
        h = await createE2EHarness()
        const calls = await fakeDesktop(h)
        const result = await h.telegram('Sie hat Computer-Use … dann mach es auf und versuch es nochmal', [
            { tool: 'desktop_screenshot', args: {} },
            { text: 'Kein Browserfenster geöffnet — der Desktop ist leer.' },
            { tool: 'desktop_control', args: { action: 'notify', message: 'Browser öffnen' } },
            { text: 'Firefox ist offen und die Seite lädt.' },
        ])
        expect(result.error).toBeUndefined()
        expect(calls.filter(call => call.name === 'desktop_screenshot').length).toBeGreaterThan(0)
        expect(calls.some(call => call.name === 'desktop_control')).toBe(true)
        expect(result.final).toContain('Firefox ist offen')
        expect(result.final).not.toBe(SCREEN_ONLY_ACTION_REPLY)
    }, T)

    it('screenshot-only that still only looks ends in the honest sentence, not another screen description', async () => {
        h = await createE2EHarness()
        await fakeDesktop(h)
        const result = await h.telegram('Sie hat Computer-Use … dann mach es auf und versuch es nochmal', [
            { tool: 'desktop_screenshot', args: {} },
            { text: 'Kein Browserfenster geöffnet — der Desktop ist leer.' },
            { tool: 'desktop_screenshot', args: {} },
            { text: 'Ich sehe nur einen leeren Desktop.' },
        ])
        expect(result.error).toBeUndefined()
        expect(result.final).toBe(SCREEN_ONLY_ACTION_REPLY)
        expect(result.final).not.toMatch(/kein Browserfenster|leeren Desktop/i)
    }, T)
})
