import { describe, expect, it, vi } from 'vitest'

const approve = vi.hoisted(() => vi.fn(() => ({ ok: true, message: 'Gerät wird überwacht.' })))
const decline = vi.hoisted(() => vi.fn(() => ({ ok: true, message: 'Gerät abgelehnt.' })))
const decisions = vi.hoisted(() => vi.fn((..._args: unknown[]) => true))
vi.mock('../sensing/runtime.js', () => ({ approveSensingDevice: approve, declineSensingDevice: decline }))
vi.mock('../thinking/thinking-runtime.js', () => ({ getThinkingSettings: () => ({ enabled: true, learning: { enabled: true } }) }))
vi.mock('./decisions.js', () => ({ recordThoughtAnswer: decisions }))

const { listThoughts } = await import('../planner/index.js')
const { createSensingThoughtSink, createThinkingThoughtSink, createSelfUpdateThoughtSink, dispatchThoughtAnswer } = await import('./thought-hub.js')

const sensingThought = (over: Record<string, unknown> = {}) => ({
    schema: 'xaventra.sensing.thought/1', id: 'st_1', at: new Date().toISOString(), source: 'discovery',
    title: 'Drucker Voron gefunden (Moonraker, 192.168.0.50)', summary: 'Port 7125 antwortet', evidence: { port: 7125 },
    importance: 'hoch', proposal: 'Überwachen?', level: 'fragen', status: 'neu',
    action: { kind: 'approveDevice', deviceId: 'dev_voron' }, delivery: { notify: true, reason: 'ok' },
    origin: { nodeId: 'xaventra-spark', role: 'main' }, dedupeKey: 'device:dev_voron', ...over,
}) as any

describe('Gedanken-Hub: Phase 2/3/4 → Planer-Gedanken → Knopf → Aktion', () => {
    it('a sensing discovery becomes a planner thought with permission fragen; Ja approves exactly that device', async () => {
        await createSensingThoughtSink().writeThought(sensingThought())
        const thought = listThoughts().find(item => item.title.includes('Voron'))!
        expect(thought.permission).toBe('fragen')
        expect(thought.title).toContain('Voron')
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1413797900' })
        expect(result.ok).toBe(true)
        expect(approve).toHaveBeenCalledWith('dev_voron', { principalId: '1413797900', permission: 'owner' })
    })

    it('Nein on a device thought approves nothing', async () => {
        approve.mockClear()
        await createSensingThoughtSink().writeThought(sensingThought({ title: 'Anderer Drucker gefunden', dedupeKey: 'device:dev_other', action: { kind: 'approveDevice', deviceId: 'dev_other' } }))
        const thought = listThoughts().find(item => item.title.includes('Anderer'))!
        await dispatchThoughtAnswer(thought.id, 'nein', { userId: '1413797900' })
        expect(approve).not.toHaveBeenCalled()
        expect(decline).toHaveBeenCalledWith('dev_other', { principalId: '1413797900', permission: 'owner' }, undefined)
    })

    it('preserves the concrete device fingerprint through thought storage and approval dispatch', async () => {
        const fingerprint = 'a'.repeat(64)
        createSensingThoughtSink().writeThought(sensingThought({ title: 'Identitätsgebundene Steckdose', dedupeKey: 'device:bound', action: { kind: 'approveDevice', deviceId: 'dev_bound', fingerprint } }))
        const thought = listThoughts().find(item => item.title.includes('Identitätsgebundene'))!
        await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1413797900' })
        expect(approve).toHaveBeenCalledWith('dev_bound', { principalId: '1413797900', permission: 'owner' }, fingerprint)
    })

    it('a model-chosen action never reaches a thought (only known action kinds are kept)', async () => {
        approve.mockClear()
        await createSensingThoughtSink().writeThought(sensingThought({ title: 'Böse Aktion gefunden', dedupeKey: 'device:evil', action: { kind: 'runCommand', cmd: 'rm -rf /' } }))
        const thought = listThoughts().find(item => item.title.includes('Böse'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1413797900' })
        expect(approve).not.toHaveBeenCalled()
        expect(result.message).not.toContain('rm -rf')
    })

    it('every answer on a thinking idea feeds the learning (ja and nein)', async () => {
        await createThinkingThoughtSink().emit({ id: 'i1', createdAt: new Date().toISOString(), source: 'ideen-lauf', kind: 'idee:werkzeug-langsam', title: 'web_search 3× langsamer', text: 'p95 4,1 s statt 1,3 s', evidence: [{ metric: 'p95', value: 4.1, unit: 's', source: 'traces' }], target: 'p95 < 1,5 s', importance: 0.9, proposal: { action: 'cache-einschalten', autoExecute: false }, stufe: 'fragen', status: 'neu', dedupeKey: 'idee:web_search' } as any)
        const thought = listThoughts().find(item => item.title.includes('web_search'))!
        // 2.86 Punkt 5: an unknown action (cache-einschalten) has no executor → no question, only an idea.
        expect(thought.permission).toBe('selbst')
        await dispatchThoughtAnswer(thought.id, 'nein', { userId: '1413797900' })
        expect(decisions).toHaveBeenCalledWith('idee:werkzeug-langsam', 'nein')
    })

    it('a self-update proposal is recorded but never activates anything from a button (no executor yet)', async () => {
        await createSelfUpdateThoughtSink().emit({ schema: 1, id: 'u1', at: new Date().toISOString(), source: 'self-update', kind: 'update-proposal', title: '2.81.0 verfügbar, geprüft', text: 'Installieren?', evidence: ['Signatur ok'], importance: 'hoch', permission: 'fragen', proposal: { action: 'self-update.activate', params: {} }, dedupeKey: 'update:2.81.0' } as any)
        const thought = listThoughts().find(item => item.title.includes('verfügbar, geprüft'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', { userId: '1413797900' })
        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/vermerkt/i)
    })
})

describe('ganze Kette: Fund → Gedanke → Karte → Owner drückt Ja → Aktion', () => {
    it('automatic connection and login thoughts reach the existing owner question-card path', async () => {
        const { createConnectionThought, hasThoughtAction } = await import('./thought-hub.js')
        const { createPlannerTelegramPort } = await import('./planner-card-bridge.js')
        const { listApprovalCards } = await import('./approval-cards.js')
        for (const kind of ['connect', 'login'] as const) {
            const title = `Automatischer HA ${kind}`
            createConnectionThought({ kind, connectorId: 'home-assistant', connectionId: 'c-home-assistant', title,
                text: 'Bestätigte Zentrale gefunden', proposal: 'Verbinden beziehungsweise anmelden?', dedupeKey: `test-ha-${kind}` })
            const thought = listThoughts().find(t => t.title === title)!
            expect(await hasThoughtAction(thought.id)).toBe(true)
            const sendApprovalCard = vi.fn(async () => 1)
            await createPlannerTelegramPort({ hasCardAuthority: async () => true, getOwnerChatIds: () => ['1413797900'], sendApprovalCard }).deliver({
                id: `out-ha-${kind}`, kind: 'gedanke', title, text: thought.evidence, permission: 'fragen', thoughtId: thought.id,
                createdAt: new Date().toISOString(), urgency: 'normal' })
            expect(listApprovalCards({ status: 'offen' }).some(c => c.aktion.ref === thought.id)).toBe(true)
        }
    })
    it('a discovered printer ends up approved only after the owner presses Ja on the card', async () => {
        approve.mockClear()
        const { getThought } = await import('../planner/index.js')
        const { createPlannerTelegramPort } = await import('./planner-card-bridge.js')
        const { answerApprovalCard, listApprovalCards } = await import('./approval-cards.js')
        await createSensingThoughtSink().writeThought(sensingThought({ title: 'Kette Drucker Prusa gefunden', dedupeKey: 'device:dev_prusa', action: { kind: 'approveDevice', deviceId: 'dev_prusa' } }))
        const thought = listThoughts().find(item => item.title.includes('Kette Drucker Prusa'))!
        const tg = { hasCardAuthority: async () => true, getOwnerChatIds: () => ['1413797900'], sendApprovalCard: async () => 1 }
        await createPlannerTelegramPort(tg).deliver({ id: 'out-0000000000e2', kind: 'gedanke', title: thought.title, text: 'Port 7125', permission: 'fragen', thoughtId: thought.id, createdAt: new Date().toISOString(), urgency: 'normal' })
        expect(approve).not.toHaveBeenCalled()
        const card = listApprovalCards({ status: 'offen' }).find(item => item.aktion.ref === thought.id)!
        const pressed = await answerApprovalCard(`ac:${card.buttons[0].token}`, { userId: '1413797900', ownerIds: ['1413797900'] })
        expect(pressed.ok).toBe(true)
        expect(approve).toHaveBeenCalledWith('dev_prusa', { principalId: '1413797900', permission: 'owner' })
        expect(getThought(thought.id)?.status).toBe('erledigt')
    })
})
