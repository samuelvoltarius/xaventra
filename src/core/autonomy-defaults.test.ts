import { describe, expect, it } from 'vitest'
import { defaultOn, isAutonomyWorker } from './autonomy-defaults.js'
import { parseDelegationConfig } from './delegation.js'
import { readReleaseButtonSettings } from './release-button.js'
import { parseResponsibilitySettings } from './responsibility-runtime.js'
import { parsePlannerSettings } from '../planner/runtime.js'
import { parseAutoReminderSettings } from '../planner/auto-reminders.js'
import { parseSensingConfig } from '../sensing/config.js'
import { parseThinkingSettings } from '../thinking/ports.js'
import { parseSoftwareScoutSettings } from '../install/software-scout.js'

// P8 „Standard: selbstständig“ (Alfred 01.10.2026): every autonomy module runs
// at the Main without a config entry; `enabled: false` switches it off; a mesh
// worker never gets a module from a missing entry.

const MAIN = {} as NodeJS.ProcessEnv
const WORKER = { NOVA_NODE_ONLY: 'true' } as NodeJS.ProcessEnv

function modules(autonomy: any, env: NodeJS.ProcessEnv): Record<string, boolean> {
    const planner = parsePlannerSettings(autonomy, env)
    const sensing = parseSensingConfig(autonomy?.sensing, env)
    const thinking = parseThinkingSettings(autonomy?.thinking, env)
    return {
        planer: planner.enabled,
        bericht: planner.briefing.enabled,
        wahrnehmen: sensing.enabled,
        geraeteSuche: sensing.discovery.enabled,
        drucker: sensing.adapters.printer.enabled,
        denken: thinking.enabled,
        ideen: thinking.ideas.enabled,
        scout: thinking.scout.enabled,
        bugFinder: thinking.bugFinder.enabled,
        verantwortungen: parseResponsibilitySettings(autonomy, env).enabled,
        delegation: parseDelegationConfig(autonomy, env).enabled,
        autoErinnerungen: parseAutoReminderSettings(autonomy, undefined, env).enabled,
        softwareScout: parseSoftwareScoutSettings(autonomy?.softwareScout, env).enabled,
        releaseKnopf: readReleaseButtonSettings({ autonomy }, env).enabled,
    }
}

describe('P8: Standard selbstständig', () => {
    it('defaultOn: fehlt = an am Main, aus am Worker; false/„aus“ = aus; true = an', () => {
        expect(defaultOn(undefined, MAIN)).toBe(true)
        expect(defaultOn(undefined, WORKER)).toBe(false)
        expect(defaultOn(null, MAIN)).toBe(true)
        expect(defaultOn(false, MAIN)).toBe(false)
        expect(defaultOn('false', MAIN)).toBe(false)
        expect(defaultOn('aus', MAIN)).toBe(false)
        expect(defaultOn(true, MAIN)).toBe(true)
        expect(isAutonomyWorker(WORKER)).toBe(true)
        expect(isAutonomyWorker(MAIN)).toBe(false)
    })

    it('fehlende Config → alle Module an am Main', () => {
        for (const autonomy of [undefined, {}]) {
            const state = modules(autonomy, MAIN)
            expect(Object.entries(state).filter(([, on]) => !on).map(([name]) => name)).toEqual([])
        }
    })

    it('fehlende Config → alle Module aus am Worker', () => {
        const state = modules({}, WORKER)
        expect(Object.entries(state).filter(([, on]) => on).map(([name]) => name)).toEqual([])
    })

    it('ausdrücklich enabled:false schaltet jedes Modul ab', () => {
        const off = {
            planner: { enabled: false }, briefing: { enabled: false }, sensing: { enabled: false, discovery: { enabled: false }, adapters: { printer: { enabled: false } } },
            thinking: { enabled: false }, responsibilities: { enabled: false }, delegation: { enabled: false }, autoReminders: { enabled: false },
            softwareScout: { enabled: false }, releaseButton: { enabled: false },
        }
        const state = modules(off, MAIN)
        expect(Object.entries(state).filter(([, on]) => on).map(([name]) => name)).toEqual([])
        // Teile einzeln abschaltbar, Rest bleibt an
        const ideasOff = parseThinkingSettings({ ideas: { enabled: false } }, MAIN)
        expect([ideasOff.enabled, ideasOff.ideas.enabled, ideasOff.scout.enabled]).toEqual([true, false, true])
        // briefing:true alone still starts the planner (old behaviour), planner:false alone also stops the report
        expect(parsePlannerSettings({ planner: { enabled: false } }, MAIN)).toMatchObject({ enabled: false, briefing: { enabled: false } })
        expect(parsePlannerSettings({ planner: { enabled: false }, briefing: { enabled: true } }, MAIN)).toMatchObject({ enabled: true, briefing: { enabled: true } })
    })
})
