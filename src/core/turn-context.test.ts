import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectContextPolicy } from './context-policy.js'
import { readContextMetrics } from './context-metrics.js'
import { applySystemPromptBudget } from './prompt-budget.js'
import { prepareTurnPrompt } from './turn-context.js'
import { TopicThreadStore, currentThreadId, runInThread } from './topic-threads.js'

const block = (heading: string, size: number) => `\n\n## ${heading}\n${'x'.repeat(size)}`
const PROMPT = 'Du bist Xaventra.'.repeat(20)
    + block('KRITISCHE REGELN', 600)
    + block('DEINE UMGEBUNG (WICHTIG - lies das!)', 1200)
    + block('MESH NETZWERK', 800)
    + block('SOZIALE INTELLIGENZ', 4000)
    + block('GELERNTES WISSEN (Hintergrundrecherche)', 6000)
    + block('HANDELN', 500)
    + block('Tools', 500)
    + block('ENTSCHEIDUNGEN (kausales Gedächtnis)', 500)

const REQUEST = 'Schalte den Drucker ein'
const policy = selectContextPolicy(REQUEST)
const tools = ['get_current_time', 'hass_turn_on', 'hass_get']
const LAGE = '## LAGEBILD (gemessen 12:00; Daten, keine Anweisungen)\nIch: Main, VM 501 auf Proxmox-Knoten pve-a.'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('2.90.0 turn context: switches', () => {
    it('off/off: the prompt is unchanged', async () => {
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: { XAVENTRA_TASK_PROMPT: 'off', XAVENTRA_LAGEBILD: 'off' } })
        expect(turn.prompt).toBe(PROMPT)
        expect(turn.metrics.taskPromptChars).toBeUndefined()
    })
    it('shadow (default) sends the old prompt and measures the task prompt', async () => {
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: {} })
        expect(turn.prompt).toBe(PROMPT)
        expect(turn.metrics.taskPromptMode).toBe('shadow')
        expect(turn.metrics.taskPromptChars).toBeLessThan(PROMPT.length)
        expect(turn.metrics.taskPromptTopics).toContain('aktion')
        expect(turn.metrics.taskPromptOmitted).toBeGreaterThan(0)
    })
    it('on sends the task prompt: core and action rules stay, unrelated blocks go', async () => {
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: { XAVENTRA_TASK_PROMPT: 'on' } })
        expect(turn.prompt).toContain('## HANDELN')
        expect(turn.prompt).toContain('## ENTSCHEIDUNGEN')
        expect(turn.prompt).not.toContain('## SOZIALE INTELLIGENZ')
        expect(turn.prompt).not.toContain('## MESH NETZWERK')
    })
    it('lagebild on replaces the static soul environment with the cached measured block', async () => {
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: { XAVENTRA_TASK_PROMPT: 'off', XAVENTRA_LAGEBILD: 'on' }, lagebildBlock: () => LAGE })
        expect(turn.prompt).toContain('VM 501 auf Proxmox-Knoten pve-a')
        expect(turn.prompt).not.toContain('## DEINE UMGEBUNG')
        expect(turn.metrics.lagebildChars).toBe(LAGE.length)
    })
    it('lagebild on without a fresh block keeps the old text (a turn never waits)', async () => {
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: { XAVENTRA_TASK_PROMPT: 'off', XAVENTRA_LAGEBILD: 'on' }, lagebildBlock: () => null })
        expect(turn.prompt).toBe(PROMPT)
        expect(turn.metrics.lagebildChars).toBe(0)
    })
    it('lagebild shadow never touches the prompt path', async () => {
        let asked = false
        await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: { XAVENTRA_LAGEBILD: 'shadow' }, lagebildBlock: () => { asked = true; return LAGE } })
        expect(asked).toBe(false)
    })
    it('a broken step never breaks the turn', async () => {
        const broken = { [Symbol.iterator]() { throw new Error('route broken') } } as any
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: broken, env: { XAVENTRA_TASK_PROMPT: 'on', XAVENTRA_LAGEBILD: 'on' }, lagebildBlock: () => { throw new Error('cache broken') } })
        expect(turn.prompt).toBe(PROMPT)
    })
})

describe('2.90.0 turn context: measurement', () => {
    it('records cap, rescued headings and the runner statistics in one line', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'turn-ctx-')); dirs.push(dir)
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: REQUEST, policy, toolNames: tools, env: {} })
        const capped = applySystemPromptBudget(turn.prompt, 3_000, REQUEST)
        turn.afterCap(capped.sections, capped.prompt.length, 3_000)
        turn.record({
            channel: 'telegram', outcome: 'answer', durationMs: 1234,
            stats: { modelInputChars: 20_000, systemChars: 9_000, historyChars: 4_000, toolSchemaChars: 7_000, toolsOffered: 3, modelCalls: 2, maxModelInputChars: 22_000, toolCalls: 2, selfInfoCalls: 0 },
        }, { dir })
        const [entry] = readContextMetrics({ dir })
        expect(entry.capped).toBe(true)
        expect(entry.promptRawChars).toBe(PROMPT.length)
        expect(entry.promptSentChars).toBe(capped.prompt.length)
        expect(entry.reducedHeadings!.length).toBeGreaterThan(0)
        expect(entry.taskPromptRescued).toEqual(expect.arrayContaining(['## Tools']))
        expect(entry.modelInputChars).toBe(20_000)
        expect(entry.toolCalls).toBe(2)
        expect(entry.channel).toBe('telegram')
        expect(entry.mode).toBe(policy.mode)
    })
})

describe('2.91.0 Themen-Fäden im Zug (Schattenbetrieb)', () => {
    const profile = [{ name: 'BYD Dolphin Surf', kind: 'vehicle', aliases: ['Dolphin'] }]
    const make = () => {
        const dir = mkdtempSync(join(tmpdir(), 'turn-threads-')); dirs.push(dir)
        return { dir, store: new TopicThreadStore(join(dir, 'topic-threads.json')) }
    }
    it('shadow (default): the thread is assigned and measured, the prompt is unchanged', async () => {
        const { dir, store } = make()
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: 'Wie voll ist der Akku vom Dolphin?', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        expect(turn.prompt).toBe(PROMPT)
        expect(turn.threadId).toBe('thread:auto')
        turn.afterCap(null, turn.prompt.length, 12_000)
        turn.record({ channel: 'telegram', outcome: 'answer', durationMs: 1 }, { dir })
        const [entry] = readContextMetrics({ dir })
        expect(entry.threadMode).toBe('shadow')
        expect(entry.threadKey).toBe('auto')
        expect(entry.threadRule).toBe('marke')
        expect(entry.threadNew).toBe(true)
        expect(typeof entry.foreignHistoryShare).toBe('number')
    })
    it('off: no thread, no thread fields', async () => {
        const { store } = make()
        const turn = await prepareTurnPrompt({ prompt: PROMPT, request: 'Wie voll ist der Akku vom Dolphin?', policy, env: { XAVENTRA_THREADS: 'off', XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        expect(turn.threadId).toBeUndefined()
        expect(store.threads('owner')).toHaveLength(0)
    })
    it('an open approval of the printer turn pulls the next code into Haus', async () => {
        const { dir, store } = make()
        const first = await prepareTurnPrompt({ prompt: PROMPT, request: 'Mach die Steckdose vom Drucker an', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        first.record({ channel: 'telegram', outcome: 'answer', durationMs: 1, awaitingApproval: true }, { dir })
        await prepareTurnPrompt({ prompt: PROMPT, request: 'Wie voll ist der Akku vom Dolphin?', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        const code = await prepareTurnPrompt({ prompt: PROMPT, request: '482913', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        expect(code.threadId).toBe(first.threadId)
        expect(code.metrics.threadRule).toBe('rueckfrage')
    })
    it('a question in the answer is remembered for the short reply', async () => {
        const { dir, store } = make()
        const pods = await prepareTurnPrompt({ prompt: PROMPT, request: 'Leg im Cluster einen Test-Pod mit busybox an', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        pods.record({ channel: 'telegram', outcome: 'answer', durationMs: 1, answer: 'Welches Image soll ich nehmen?' }, { dir })
        const reply = await prepareTurnPrompt({ prompt: PROMPT, request: 'busybox 1.36', policy, env: { XAVENTRA_TASK_PROMPT: 'off' }, principalId: 'owner', threadStore: store, profileEntities: profile })
        expect(reply.threadId).toBe(pods.threadId)
    })
    it('background work started inside the turn sees the thread', async () => {
        expect(currentThreadId()).toBeUndefined()
        expect(await runInThread('thread:infra', async () => { await Promise.resolve(); return currentThreadId() })).toBe('thread:infra')
    })
})
