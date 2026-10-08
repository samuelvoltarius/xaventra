import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// 2.89 Punkt 2: load_skill_pack loads for the RUNNING request and a call to a
// registered but not offered tool is admitted (role/policy permitting) instead
// of aborting the run. Driven through the real runner (runNovaAgent), the real
// registry and the real SDK loop; only the model is scripted.

const fixtures = vi.hoisted(() => ({ denied: new Set<string>() }))
vi.mock('../users/multi-user-middleware.js', async original => ({
    ...(await original<any>()),
    getUserPermission: () => 'owner',
    isToolAllowed: (_user: string, name: string) => !fixtures.denied.has(name),
}))

const { runNovaAgent, clearSession } = await import('./nova-runner.js')
const { getToolRegistry } = await import('../tools/complete-registry.js')
const { ToolAdmission } = await import('./tool-admission.js')

type Call = { name: string; arguments: Record<string, unknown> }
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }

function scriptedLlm(steps: Array<Call[] | string>, final?: { text?: string; fail?: boolean }, failAtTurn?: number) {
    const offered: string[][] = []
    let turn = 0
    const complete = vi.fn(async (_messages: unknown, tools: Array<{ name: string }> = []) => {
        offered.push(tools.map(tool => tool.name))
        // 2.89: the last-resort summary call carries no tools at all.
        if (final && tools.length === 0) {
            if (final.fail) throw new Error('Timeout: model request exceeded deadline')
            return { content: final.text || '', usage }
        }
        if (failAtTurn !== undefined && turn >= failAtTurn) throw new Error('Timeout: model request exceeded deadline')
        const step = steps[Math.min(turn++, steps.length - 1)]
        return typeof step === 'string'
            ? { content: step, usage }
            : { content: '', toolCalls: step.map((call, index) => ({ id: `call-${turn}-${index}`, ...call })), usage }
    })
    return { llm: { modelId: 'scripted-fixture', providerId: 'fixture', complete }, offered, complete }
}

const printerHandler = vi.fn(async () => ({ success: true, output: 'Drucker bereit, Bett 60 °C' }))
let originalPrinter: any

beforeAll(async () => {
    const registry = getToolRegistry()
    for (let i = 0; i < 50 && !registry.get('load_skill_pack'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    originalPrinter = registry.get('printer_status')
    registry.register({ ...originalPrinter, handler: printerHandler })
})
afterEach(() => { fixtures.denied.clear(); printerHandler.mockClear() })

let serial = 0
async function run(content: string, steps: Array<Call[] | string>, final?: { text?: string; fail?: boolean }, failAtTurn?: number, onStepUpdate?: (status: string) => Promise<void>) {
    const user = `admission-owner-${process.pid}-${serial++}`
    const scripted = scriptedLlm(steps, final, failAtTurn)
    clearSession(user, 'telegram')
    const result = await runNovaAgent({ userId: user, authUserId: user, channel: 'telegram', content, llm: scripted.llm as any, abortSignal: new AbortController().signal, onStepUpdate } as any)
    return { result, ...scripted }
}

describe('runner path: tools join the running request', () => {
    it('load_skill_pack really loads: the next model step gets the printer tools and the call runs', async () => {
        const { result, offered } = await run('Wie geht es meiner Werkstatt heute?', [
            [{ name: 'load_skill_pack', arguments: { pack_name: 'printer' } }],
            [{ name: 'printer_status', arguments: {} }],
            'Der Drucker ist bereit.',
        ])
        expect(offered[0]).not.toContain('printer_status')
        expect(offered[1]).toContain('printer_status')
        expect(printerHandler).toHaveBeenCalledOnce()
        expect(result.toolsExecuted).toEqual(expect.arrayContaining(['load_skill_pack', 'printer_status']))
        expect(result.content).toContain('Drucker ist bereit')
    }, 30_000)

    it('a registered but not offered tool is admitted instead of aborting the run', async () => {
        const { result, offered, complete } = await run('Wie geht es meiner Werkstatt heute?', [
            [{ name: 'printer_status', arguments: {} }],
            'Alles bereit.',
        ])
        expect(offered[0]).not.toContain('printer_status')
        expect(printerHandler).toHaveBeenCalledOnce()
        // No „replan with the offered tools“ correction round was needed.
        expect(complete).toHaveBeenCalledTimes(2)
        expect(result.content).toContain('Alles bereit')
    }, 30_000)

    it('Gegenprobe: the role check keeps a not-allowed tool out — nothing runs', async () => {
        fixtures.denied.add('printer_status')
        await run('Wie geht es meiner Werkstatt heute?', [
            [{ name: 'printer_status', arguments: {} }],
            [{ name: 'printer_status', arguments: {} }],
        ])
        expect(printerHandler).not.toHaveBeenCalled()
    }, 30_000)

    it('an unknown tool name stays an error and reaches the forge as „fehlt“', async () => {
        const { result } = await run('Wie geht es meiner Werkstatt heute?', [
            [{ name: 'zauberstab_schwingen', arguments: {} }],
            [{ name: 'zauberstab_schwingen', arguments: {} }],
        ])
        const missing = (result.toolExecutions || []).find((item: any) => item.toolName === 'zauberstab_schwingen')
        expect(missing).toMatchObject({ success: false, result: 'Tool nicht gefunden: zauberstab_schwingen' })
    }, 30_000)

    it('a node screenshot keeps its sealed contract: no tool is admitted', async () => {
        await run('send mir einen Screenshot von allen nodes', [
            [{ name: 'printer_status', arguments: {} }],
            [{ name: 'printer_status', arguments: {} }],
        ])
        expect(printerHandler).not.toHaveBeenCalled()
    }, 30_000)
})

describe('ToolAdmission gate', () => {
    it('admits only registered, allowed, not denied/excluded tools, once', () => {
        const added: string[][] = []
        const gate = new ToolAdmission({
            offered: ['get_current_time'], registered: ['get_current_time', 'hass_service', 'send_file', 'ssh_command', 'run_command'],
            enabled: true, denied: ['run_command'], excluded: ['send_file'], allows: name => name !== 'ssh_command',
            onAdmit: names => added.push(names),
        })
        expect(gate.admit(['hass_service', 'send_file', 'ssh_command', 'run_command', 'unknown_tool'], 'model-call')).toEqual(['hass_service'])
        expect(gate.admit(['hass_service'], 'load_skill_pack')).toEqual([])
        expect(gate.isOffered('hass_service')).toBe(true)
        expect(added).toEqual([['hass_service']])
    })
    it('a disabled gate (binding contract, internal run) admits nothing', () => {
        const gate = new ToolAdmission({ offered: [], registered: ['hass_service'], enabled: false, allows: () => true })
        expect(gate.candidates()).toEqual([])
        expect(gate.admit(['hass_service'], 'model-call')).toEqual([])
    })
})

describe('runner path: a run that hits the round limit says so (2.89 Punkt 4)', () => {
    afterEach(() => { delete process.env.NOVA_MAX_TOOL_ROUNDS })
    it('names the limit instead of a vague answer', async () => {
        process.env.NOVA_MAX_TOOL_ROUNDS = '2'
        const steps: Call[][] = [0, 1, 2, 3, 4].map(index => [{ name: 'printer_status', arguments: { printer: `p${index}` } }])
        const { result } = await run('Wie geht es meinem Drucker?', steps, { text: 'Der Drucker ist bereit (Bett 60 °C); weitere Prüfungen fehlen noch.' })
        expect(result.content).toContain('2 Arbeitsschritten angehalten')
        expect(result.content).toContain('Der Drucker ist bereit')
        expect(result.incompleteSynthesis).toBe(false)
    }, 30_000)

    it('when the last summary call fails too: one short honest sentence, no raw data, no internal words', async () => {
        process.env.NOVA_MAX_TOOL_ROUNDS = '2'
        const steps: Call[][] = [0, 1, 2, 3, 4].map(index => [{ name: 'printer_status', arguments: { printer: `p${index}` } }])
        const { result } = await run('Wie geht es meinem Drucker?', steps, { fail: true })
        expect(result.content).toContain('2 Arbeitsschritten angehalten')
        expect(result.content).toMatch(/noch nicht ganz fertig/)
        expect(result.content).not.toMatch(/Drucker bereit|Tool-Beobachtungen|ausgewertet/)
        expect(result.incompleteSynthesis).toBe(true)
        expect(result.incompleteAnswerReady).toBe(true)
    }, 30_000)
})

describe('runner path: five small checks in a row (live case 2.89)', () => {
    const five: Call[][] = [0, 1, 2, 3, 4].map(index => [{ name: 'printer_status', arguments: { printer: `woche-${index}` } }])

    it('the model times out on the summary round: a last tool-free call still produces the summary, not raw observations', async () => {
        const { result } = await run('Mach bitte nacheinander fünf kleine Prüfungen für meinen Wochenplan und fasse sie dann zusammen', five,
            { text: 'Zusammenfassung: alle fünf Prüfungen liefen, der Drucker ist bereit.' }, 5)
        expect(printerHandler).toHaveBeenCalledTimes(5)
        expect(result.content).toBe('Zusammenfassung: alle fünf Prüfungen liefen, der Drucker ist bereit.')
        expect(result.content).not.toMatch(/Tool-Beobachtungen|nicht vollständig ausgewertet/)
        expect(result.incompleteSynthesis).toBe(false)
    }, 30_000)

    it('Gegenprobe: all five steps run without early abort (no loop detection) and a normal summary needs no extra call', async () => {
        const { result, complete } = await run('Mach bitte nacheinander fünf kleine Prüfungen für meinen Wochenplan und fasse sie dann zusammen',
            [...five, 'Alles geprüft.'])
        expect(printerHandler).toHaveBeenCalledTimes(5)
        expect(complete).toHaveBeenCalledTimes(6)
        expect(result.content).toBe('Alles geprüft.')
    }, 30_000)

    it('the side channel gets a plain-words sign of life at EVERY tool start and while waiting for the model', async () => {
        const seen: string[] = []
        await run('Mach bitte nacheinander fünf kleine Prüfungen für meinen Wochenplan und fasse sie dann zusammen',
            [...five, 'Alles geprüft.'], undefined, undefined, async status => { seen.push(status) })
        expect(seen.filter(status => status === 'denke nach …').length).toBeGreaterThanOrEqual(6)
        expect(seen.filter(status => status !== 'denke nach …')).toHaveLength(5)
        expect(seen.join(' ')).not.toMatch(/printer_status|Schritt \d+\/\d+/)
    }, 30_000)
})

describe('runner path: one failed tool is an observation, not the end of the run (2.89)', () => {
    it('the model sees the failure and finishes with another step', async () => {
        printerHandler.mockResolvedValueOnce({ success: false, error: 'Drucker antwortet nicht (Zeitüberschreitung)' } as any)
        const { result, complete } = await run('Wie geht es meinem Drucker?', [
            [{ name: 'printer_status', arguments: { printer: 'werkstatt' } }],
            [{ name: 'printer_status', arguments: { printer: 'werkstatt-2' } }],
            'Der zweite Versuch hat geklappt: Drucker bereit.',
        ])
        expect(printerHandler).toHaveBeenCalledTimes(2)
        expect(complete).toHaveBeenCalledTimes(3)
        expect(result.content).toContain('Drucker bereit')
    }, 30_000)
})
