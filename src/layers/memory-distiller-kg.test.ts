import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Der Distiller liefert für Owner-Fakten Subjekt/Beziehung/Wert an die
// Governance (Wissensgraph-Projektion nur über sie); Gäste bekommen nie Tripel.
const governance = vi.hoisted(() => ({ record: vi.fn(async (proposal: any) => ({ id: 'mem', ...proposal })) }))
vi.mock('../memory/memory-governance.js', () => ({ getMemoryGovernanceCoordinator: () => governance }))
vi.mock('../memory/journal.js', () => ({ getTodayEntry: () => null, getRecentEntries: () => [], recordEvent: () => undefined }))

const date = '2026-09-29'
const sandbox = join(process.cwd(), '.nova-test-tmp', `distiller-kg-${randomUUID()}`)
mkdirSync(join(sandbox, '.nova-data', 'sessions'), { recursive: true })
writeFileSync(join(sandbox, 'xaventra.config.json'), JSON.stringify({
    channels: { telegram: { allowFrom: ['111'] } },
    userAliases: { '111': 'Sample', '222': 'Gast' },
    userPrincipals: { 'telegram:111': 'sample' },
}))
const line = (content: string) => JSON.stringify({ ts: `${date}T10:00:00.000Z`, channel: 'telegram', role: 'user', content })
writeFileSync(join(sandbox, '.nova-data', 'sessions', 'Sample.jsonl'), `${line('Ich wohne in Hallein und drucke mit dem Voron.')}\n`)
writeFileSync(join(sandbox, '.nova-data', 'sessions', 'Gast.jsonl'), `${line('Ich wohne in Linz und fahre gerne Rennrad.')}\n`)
const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sandbox)
afterAll(() => cwd.mockRestore())

const { runDistillation } = await import('./memory-distiller.js')

const answer = (guest: boolean) => JSON.stringify({
    userFacts: guest
        ? [{ satz: 'Der Gast wohnt in Linz und fährt gerne Rennrad.', beziehung: 'wohnt_in', wert: 'Linz' }]
        : [
            { satz: 'Der Benutzer wohnt in Hallein bei Salzburg.', beziehung: 'wohnt in', wert: 'Hallein' },
            { satz: 'Der Benutzer druckt mit einem Voron 3D-Drucker.', beziehung: 'drucker', wert: 'Voron 2.4 mit Klipper und sehr langem Zusatznamen dran' },
            'Der Benutzer mag ruhige Abende mit klassischer Musik.',
        ],
    decisions: [], learnings: [], openQuestions: [], mistakes: [], mood: 'ruhig', diaryText: 'Ein ruhiger Tag.',
})

describe('Distiller → Governance-Tripel', () => {
    it('Owner-Fakten tragen Subjekt/Beziehung/Wert (höchstens 50 Zeichen), Gäste nie', async () => {
        await runDistillation({ complete: vi.fn(async (prompt: string) => answer(prompt.includes('Linz'))) }, date)
        const proposals = governance.record.mock.calls.map(call => call[0] as any)
        const hallein = proposals.find(item => /Hallein/.test(item.content))
        expect(hallein).toMatchObject({ scope: 'user:sample', subject: 'user:sample', predicate: 'wohnt_in', value: 'Hallein' })
        const voron = proposals.find(item => /Voron/.test(item.content))
        expect(voron.subject).toBeUndefined()
        const musik = proposals.find(item => /Musik/.test(item.content))
        expect(musik.subject).toBeUndefined()
        const linz = proposals.find(item => /Linz/.test(item.content))
        expect(linz.scope).toBe('user:222')
        expect(linz.subject).toBeUndefined()
    })
})
