import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// P9 Begriffe: „Auftrag“ = Owner-Ziel als Schrittkette (/auftrag, Alias
// /mission mit Hinweis), „Mission“ = Verantwortungs-Mission (/arbeit), /wave
// ist entfernt, und es gibt nur einen Ziel-Speicher (goals.json).

afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('./autonomous-executor.js')
})

function state(): any {
    return {
        running: true, channels: { telegram: null, whatsapp: null, discord: null },
        llm: null, internalLlm: null, memory: null, learning: null, tools: null,
        resilience: null, startTime: Date.now(), config: {}, __userPermission: 'owner',
    }
}
const owner = { channel: 'cli', rawUserId: 'owner-1', principalId: 'owner-1', permission: 'owner' as const }

describe('P9 /auftrag und /mission', () => {
    it('/auftrag zeigt den Auftrags-Status; /mission liefert dasselbe mit Hinweis auf den neuen Namen', async () => {
        vi.doMock('./autonomous-executor.js', () => ({
            getMissionStatus: () => 'STATUS-AUFTRAG', getActiveMission: () => null, startMission: vi.fn(), cancelMission: vi.fn(),
            pauseMission: vi.fn(), resumeMission: vi.fn(), getMissionHistory: vi.fn(), formatMissionConfig: vi.fn(), updateMissionConfig: vi.fn(),
        }))
        const { handleCommand } = await import('./slash-commands.js')
        const auftrag = String(await handleCommand('auftrag', 'status', 'owner-1', state(), [], owner))
        expect(auftrag).toBe('STATUS-AUFTRAG')
        const mission = String(await handleCommand('mission', 'status', 'owner-1', state(), [], owner))
        expect(mission).toMatch(/\/mission heißt jetzt \/auftrag/)
        expect(mission).toMatch(/Verantwortungs-Missionen \(\/arbeit\)/)
        expect(mission.endsWith('STATUS-AUFTRAG')).toBe(true)
    })

    it('/wave ist weg und verweist auf /auftrag und /arbeit', async () => {
        const { handleCommand } = await import('./slash-commands.js')
        const text = String(await handleCommand('wave', 'new Projekt', 'owner-1', state(), [], owner))
        expect(text).toMatch(/gibt es nicht mehr/)
        expect(text).toMatch(/\/auftrag/)
        expect(text).toMatch(/\/arbeit/)
    })

    it('Nutzertexte der Aufträge sagen „Auftrag“, nicht „Mission“', () => {
        const source = readFileSync(fileURLToPath(new URL('./autonomous-executor.ts', import.meta.url)), 'utf8')
        const userTexts = source.match(/(?:return|notifyUser\(|progressUpdates\.push\(|msg \+?=)\s*[`'][^`']*[`']/g) || []
        expect(userTexts.length).toBeGreaterThan(10)
        expect(userTexts.some(text => text.includes('Kein aktiver Auftrag'))).toBe(true)
        expect(userTexts.filter(text => /(?<![A-Za-z])Mission|\/mission/.test(text))).toEqual([])
    })
})

describe('P9 Auftrags-Dateien', () => {
    it('übernimmt missions.json / mission-config.json einmal nach auftraege*.json und benennt die alten in .migriert um', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'auftrag-files-'))
        vi.spyOn(process, 'cwd').mockReturnValue(cwd)
        const data = join(cwd, '.nova-data')
        mkdirSync(data, { recursive: true })
        writeFileSync(join(data, 'missions.json'), JSON.stringify({ active: null, history: [{ id: 'a1' }], queue: [] }))
        writeFileSync(join(data, 'mission-config.json'), JSON.stringify({ maxSteps: 7 }))
        vi.resetModules()
        const executor = await import('./autonomous-executor.js')
        expect(executor.migrateLegacyAuftragFiles()).toBe(2)
        expect(JSON.parse(readFileSync(join(data, 'auftraege.json'), 'utf8')).history).toEqual([{ id: 'a1' }])
        expect(JSON.parse(readFileSync(join(data, 'auftraege-config.json'), 'utf8')).maxSteps).toBe(7)
        expect(existsSync(join(data, 'missions.json'))).toBe(false)
        expect(existsSync(join(data, 'missions.json.migriert'))).toBe(true)
        expect(executor.migrateLegacyAuftragFiles()).toBe(0)
    })
})

describe('P9 ein Ziel-Speicher', () => {
    it('Selbst-Ziele liegen im Goal Manager (Herkunft selbst) und self-goals.json wird übernommen', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'self-goals-'))
        vi.spyOn(process, 'cwd').mockReturnValue(cwd)
        const data = join(cwd, '.nova-data')
        mkdirSync(data, { recursive: true })
        const now = Date.now()
        writeFileSync(join(data, 'self-goals.json'), JSON.stringify([
            { id: 'goal_1', goal: 'Logs auf Fehler prüfen', reason: 'Wartung', status: 'pending', createdAt: now - 60_000 },
            { id: 'goal_2', goal: 'Speicher analysieren', reason: '', status: 'done', createdAt: now - 120_000, result: 'ok' },
            { id: 'goal_3', goal: 'Alte Idee', reason: '', status: 'pending', createdAt: now - 5 * 24 * 60 * 60 * 1000 },
        ]))
        vi.resetModules()
        const goals = await import('./goal-manager.js')
        goals.setGoalManager(new goals.GoalManager(join(data, 'goals.json')))
        vi.doMock('./autonomy-authority.js', () => ({ hasGlobalAutonomyAuthority: () => true }))
        const engine = (await import('../intelligence/autonomy-engine.js')).getSelfGoalEngine()

        expect(existsSync(join(data, 'self-goals.json'))).toBe(false)
        expect(existsSync(join(data, 'self-goals.json.migriert'))).toBe(true)
        const stored = goals.getGoalManager().list(goals.SELF_GOAL_OWNER)
        expect(stored.map(goal => goal.title).sort()).toEqual(['Alte Idee', 'Logs auf Fehler prüfen', 'Speicher analysieren'])
        expect(stored.every(goal => goal.origin === 'selbst')).toBe(true)
        expect(stored.find(goal => goal.title === 'Alte Idee')!.status).toBe('cancelled')

        const next = engine.getNextGoal()!
        expect(next.goal).toBe('Logs auf Fehler prüfen')
        engine.completeGoal(next.id, 'keine Fehler gefunden')
        expect(engine.getNextGoal()).toBeNull()
        const done = goals.getGoalManager().list(goals.SELF_GOAL_OWNER).find(goal => goal.id === next.id)!
        expect(done).toMatchObject({ status: 'completed', result: 'keine Fehler gefunden' })
        // never in a user's prompt
        expect(goals.getGoalManager().getPrompt('owner-1')).toBe('')
        expect(JSON.parse(readFileSync(join(data, 'goals.json'), 'utf8')).goals.length).toBe(3)
        vi.doUnmock('./autonomy-authority.js')
    })
})
