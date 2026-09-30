import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyScreenshotFallback, shouldRunScreenshotFallback } from './screenshot-delivery.js'

// Live 01.10.2026 00:13 (2.79.3): "Mach einen Screenshot und sag mir, was du
// siehst". qwen called nova_introspect, nova_capabilities and load_skill_pack
// ("system" does not exist), the run stopped, ActionLifecycle said failed, and
// the deterministic fallback stayed silent because it demanded no executed
// tools and no actionState. Alfred got no picture.
const liveRun = {
    toolsExecuted: ['nova_introspect', 'nova_capabilities', 'load_skill_pack'],
    toolExecutions: [
        { toolName: 'nova_introspect', success: true },
        { toolName: 'nova_capabilities', success: true },
        { toolName: 'load_skill_pack', success: false },
    ],
    actionState: { requiresTool: true, kind: 'screenshot', fulfilled: false, awaitingApproval: false, phase: 'failed' },
}

describe('screenshot fallback trigger', () => {
    it('runs after introspection and a failed discovery tool when no picture was taken', () => {
        expect(shouldRunScreenshotFallback({ isSystemMessage: false, intentKind: 'screenshot', screenshotDelivered: false, result: liveRun })).toBe(true)
    })

    it('never adds a second picture once the screenshot was delivered', () => {
        expect(shouldRunScreenshotFallback({ isSystemMessage: false, intentKind: 'screenshot', screenshotDelivered: true, result: liveRun })).toBe(false)
    })

    it('leaves a successful desktop_screenshot of this run to the normal delivery', () => {
        const captured = {
            toolsExecuted: ['nova_introspect', 'desktop_screenshot'],
            toolExecutions: [{ toolName: 'nova_introspect', success: true }, { toolName: 'desktop_screenshot', success: true }],
            screenshotPath: '/v/desktop_1.png',
        }
        expect(shouldRunScreenshotFallback({ isSystemMessage: false, intentKind: 'screenshot', screenshotDelivered: false, result: captured })).toBe(false)
    })

    it('stays off for other intents and system messages', () => {
        expect(shouldRunScreenshotFallback({ isSystemMessage: false, intentKind: 'none', screenshotDelivered: false, result: {} })).toBe(false)
        expect(shouldRunScreenshotFallback({ isSystemMessage: true, intentKind: 'screenshot', screenshotDelivered: false, result: {} })).toBe(false)
    })

    it('still runs for a provider that only acknowledged the request (old case)', () => {
        expect(shouldRunScreenshotFallback({ isSystemMessage: false, intentKind: 'screenshot', screenshotDelivered: false, result: { toolsExecuted: [] } })).toBe(true)
    })
})

describe('applying a delivered fallback screenshot', () => {
    it('keeps earlier tool evidence and marks the action fulfilled so the evidence gate keeps the success text', () => {
        const next = applyScreenshotFallback(structuredClone(liveRun), { path: '/v/desktop_2.png', size: 3 })
        expect(next.screenshotPath).toBe('/v/desktop_2.png')
        expect(next.screenshotDelivered).toBe(true)
        expect(next.toolsExecuted).toEqual(['nova_introspect', 'nova_capabilities', 'load_skill_pack', 'desktop_screenshot'])
        expect(next.toolExecutions.at(-1)).toMatchObject({ toolName: 'desktop_screenshot', success: true })
        expect(next.actionState).toMatchObject({ kind: 'screenshot', fulfilled: true, phase: 'verify' })
    })

    it('does not invent an actionState for runners without one', () => {
        expect(applyScreenshotFallback({}, { path: '/v/x.png' }).actionState).toBeUndefined()
    })
})

describe('pipeline wiring', () => {
    const source = readFileSync(new URL('./message-pipeline.ts', import.meta.url), 'utf8')
    it('uses the shared trigger instead of the old toolsExecuted.length === 0 condition', () => {
        expect(source).toContain('shouldRunScreenshotFallback({')
        expect(source).toContain('applyScreenshotFallback(result as any, captured)')
        expect(source).not.toMatch(/preGateIntent\.kind === 'screenshot' && !screenshotDelivered && \(result\.toolsExecuted \|\| \[\]\)\.length === 0/)
    })
})
