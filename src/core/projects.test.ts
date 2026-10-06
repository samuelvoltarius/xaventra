import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    ProjectCoordinator, assignMessage, detectProjectRequest, isProjectStatusQuestion, parseRunAnswer,
    type Project, type ProjectPorts, type ProjectRunResult,
} from './projects.js'

const OWNER = { principalId: 'owner-sample', permission: 'owner' as const, isGroup: false, systemAuthored: false, channel: 'telegram' }

interface Pending { project: Project; instruction: string; resolve: (result: ProjectRunResult) => void }

function harness(options: { findExisting?: ProjectPorts['findExisting']; dataDir?: string } = {}) {
    const pending: Pending[] = []
    const notices: Array<{ projectId: string; kind: string; text: string }> = []
    const ports: ProjectPorts = {
        run: (project, instruction) => new Promise(resolve => pending.push({ project, instruction, resolve })),
        notify: async (project, text, kind) => { notices.push({ projectId: project.id, kind, text }) },
        findExisting: options.findExisting,
    }
    const dataDir = options.dataDir || mkdtempSync(join(tmpdir(), 'projekte-'))
    const coordinator = new ProjectCoordinator({ dataDir, ports, now: () => Date.now() })
    return { coordinator, pending, notices, dataDir, ports }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const settle = async (coordinator: ProjectCoordinator) => { for (let i = 0; i < 5; i++) await tick(); await coordinator.idle() }

describe('detecting projects in plain speech', () => {
    it('splits "kümmer dich um X und nebenbei um Y" into two goals', () => {
        const goals = detectProjectRequest('Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche')
        expect(goals).toHaveLength(2)
        expect(goals![0]).toMatch(/Steuererklärung/)
        expect(goals![1]).toMatch(/Küche/)
        expect(detectProjectRequest('Kümmere dich bitte um den Umzug.')).toEqual(['den Umzug'])
        expect(detectProjectRequest('Übernimm die Planung vom Gartenfest, außerdem kümmer dich um die Fahrradreparatur')).toHaveLength(2)
    })

    it('ignores ordinary messages and the owner doing things himself', () => {
        expect(detectProjectRequest('Wie wird das Wetter morgen?')).toBeNull()
        expect(detectProjectRequest('Ich kümmere mich selbst um die Steuer')).toBeNull()
        expect(detectProjectRequest('/auftrag Steuer')).toBeNull()
    })

    it('recognises the status question and the run answer markers', () => {
        expect(isProjectStatusQuestion("Wie steht's?")).toBe(true)
        expect(isProjectStatusQuestion('wie stehts mit den projekten')).toBe(true)
        expect(isProjectStatusQuestion('Wie geht es dir?')).toBe(false)
        expect(parseRunAnswer('FRAGE: Welches Holz?')).toEqual({ art: 'frage', text: 'Welches Holz?' })
        expect(parseRunAnswer('FERTIG: Angebot liegt vor')).toEqual({ art: 'fertig', text: 'Angebot liegt vor' })
        expect(parseRunAnswer('WEITER: Händler verglichen').art).toBe('weiter')
        expect(parseRunAnswer('Soll ich Eiche oder Buche nehmen?').art).toBe('frage')
    })
})

describe('parallel projects from one conversation', () => {
    it('creates both projects, runs them at the same time and reports briefly', async () => {
        const { coordinator, pending, notices } = harness()
        const turn = await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche' })
        expect(turn.reply).toMatch(/Steuererklärung/)
        expect(turn.reply).toMatch(/Küche/)
        await tick()
        // both started before either finished
        expect(pending).toHaveLength(2)
        const kitchen = pending.find(item => /Küche/.test(item.project.ziel))!
        const tax = pending.find(item => /Steuer/.test(item.project.ziel))!
        kitchen.resolve({ ok: true, text: 'FRAGE: Welches Holz soll die Arbeitsplatte haben?' })
        tax.resolve({ ok: true, text: 'FERTIG: Unterlagen-Liste ist fertig' })
        await settle(coordinator)
        const list = coordinator.list(OWNER.principalId)
        expect(list.find(item => item.id === kitchen.project.id)?.status).toBe('wartet-auf-dich')
        expect(list.find(item => item.id === tax.project.id)?.status).toBe('fertig')
        expect(notices.map(item => item.kind).sort()).toEqual(['fertig', 'frage'])
        expect(notices.every(item => item.text.length < 400)).toBe(true)
    })

    it('does not start the same project twice', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        const again = await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        expect(again.reply).toMatch(/schon/)
        await tick()
        expect(pending).toHaveLength(1)
        expect(coordinator.list(OWNER.principalId)).toHaveLength(1)
    })

    it('uses an existing Auftrag instead of duplicating its work', async () => {
        const { coordinator, pending } = harness({ findExisting: () => ({ art: 'auftrag', ref: 'm_1', titel: 'Umzug planen', aktiv: true }) })
        const turn = await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um den Umzug' })
        expect(turn.reply).toMatch(/Auftrag/)
        await tick()
        expect(pending).toHaveLength(0)
        expect(coordinator.list(OWNER.principalId)[0].verknuepft?.ref).toBe('m_1')
    })
})

describe('later messages go to the right project', () => {
    it('an answer to a waiting question resumes exactly that project', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche' })
        await tick()
        for (const item of pending.splice(0)) item.resolve({ ok: true, text: /Küche/.test(item.project.ziel) ? 'FRAGE: Welches Holz für die Küche?' : 'FRAGE: Welches Jahr bei der Steuererklärung?' })
        await settle(coordinator)
        const turn = await coordinator.handleTurn({ ...OWNER, channel: 'desktop', text: 'Für die Küche nehmen wir Eiche' })
        expect(turn.reply).toMatch(/Küche/)
        await tick()
        expect(pending).toHaveLength(1)
        expect(pending[0].project.ziel).toMatch(/Küche/)
        expect(pending[0].instruction).toMatch(/Eiche/)
        const tax = coordinator.list(OWNER.principalId).find(item => /Steuer/.test(item.ziel))!
        expect(tax.status).toBe('wartet-auf-dich')
    })

    it('a remark about a running project is noted and given to its next round', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        await tick()
        const turn = await coordinator.handleTurn({ ...OWNER, text: 'Bei der Steuererklärung bitte auch die Spenden berücksichtigen' })
        expect(turn.reply).toBeUndefined()
        expect(turn.hint).toMatch(/Steuererklärung/)
        pending.shift()!.resolve({ ok: true, text: 'WEITER: Belege gesammelt' })
        await tick(); await tick()
        expect(pending).toHaveLength(1)
        expect(pending[0].instruction).toMatch(/Spenden/)
    })

    it('leaves unrelated messages to the normal conversation', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        await tick()
        pending.shift()!.resolve({ ok: true, text: 'FRAGE: Welches Jahr bei der Steuererklärung?' })
        await settle(coordinator)
        expect(await coordinator.handleTurn({ ...OWNER, text: 'Wie wird das Wetter morgen in Salzburg?' })).toEqual({})
        expect(assignMessage(coordinator.list(OWNER.principalId), 'Wie wird das Wetter morgen in Salzburg?', Date.now())).toBeNull()
    })
})

describe('status, identity and restart', () => {
    it('"Wie steht es?" lists all projects briefly, on every channel of the owner', async () => {
        const { coordinator, pending } = harness()
        expect(await coordinator.handleTurn({ ...OWNER, text: "Wie steht's?" })).toEqual({})
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche' })
        await tick()
        pending.find(item => /Steuer/.test(item.project.ziel))!.resolve({ ok: true, text: 'FERTIG: Liste fertig' })
        await tick(); await tick()
        const status = await coordinator.handleTurn({ ...OWNER, channel: 'desktop', text: "Wie steht's?" })
        expect(status.reply).toMatch(/Steuererklärung/)
        expect(status.reply).toMatch(/Küche/)
        expect(status.reply).toMatch(/fertig/i)
        expect(status.reply!.split('\n').length).toBeLessThanOrEqual(8)
    })

    it('strangers, groups and system messages never create or see projects', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        expect(await coordinator.handleTurn({ ...OWNER, principalId: 'stranger', permission: 'user', text: 'Kümmer dich um meinen Garten' })).toEqual({})
        expect(await coordinator.handleTurn({ ...OWNER, principalId: 'stranger', permission: 'user', text: "Wie steht's?" })).toEqual({})
        expect(await coordinator.handleTurn({ ...OWNER, isGroup: true, text: 'Kümmer dich um den Garten' })).toEqual({})
        expect(await coordinator.handleTurn({ ...OWNER, systemAuthored: true, text: 'Kümmer dich um den Garten' })).toEqual({})
        await tick()
        expect(pending).toHaveLength(1)
        expect(coordinator.list('stranger')).toEqual([])
    })

    it('survives a restart and continues running projects', async () => {
        const first = harness()
        await first.coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung' })
        await tick()
        const second = harness({ dataDir: first.dataDir })
        expect(second.coordinator.list(OWNER.principalId)).toHaveLength(1)
        second.coordinator.resume()
        await tick()
        expect(second.pending).toHaveLength(1)
        second.pending[0].resolve({ ok: true, text: 'FERTIG: erledigt' })
        await settle(second.coordinator)
        expect(second.coordinator.list(OWNER.principalId)[0].status).toBe('fertig')
    })
})
describe('stopping and the parallel limit', () => {
    it('"stopp das Projekt Küche" stops only that project', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung und nebenbei um ein Angebot für die neue Küche' })
        await tick()
        const turn = await coordinator.handleTurn({ ...OWNER, text: 'Stopp das Projekt mit der Küche' })
        expect(turn.reply).toMatch(/gestoppt/)
        for (const item of pending.splice(0)) item.resolve({ ok: true, text: 'WEITER: weiter' })
        await tick(); await tick()
        const list = coordinator.list(OWNER.principalId)
        expect(list.find(item => /Küche/.test(item.ziel))?.status).toBe('gestoppt')
        expect(pending.map(item => item.project.ziel)).toEqual([expect.stringMatching(/Steuer/)])
    })

    it('runs at most three projects at once and starts the next when one finishes', async () => {
        const { coordinator, pending } = harness()
        await coordinator.handleTurn({ ...OWNER, text: 'Kümmer dich um die Steuererklärung, außerdem um die Küche, außerdem um den Garten, außerdem um das Auto' })
        await tick()
        expect(coordinator.list(OWNER.principalId)).toHaveLength(4)
        expect(pending).toHaveLength(3)
        pending.shift()!.resolve({ ok: true, text: 'FERTIG: ok' })
        await tick(); await tick(); await tick()
        expect(pending).toHaveLength(3)
    })
})