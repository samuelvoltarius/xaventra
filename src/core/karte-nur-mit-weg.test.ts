/**
 * 2.86 Punkt 5: Keine Karte ohne Ausführungsweg; eine Frage = eine Karte.
 *
 * Ein Ja, das nichts tut, kostet Aufmerksamkeit und lehrt, dass Ja nichts
 * bedeutet. Ein `fragen`-Gedanke wird nur dann eine Knopf-Karte, wenn der
 * Gedanken-Hub einen echten Ausführungsweg für ihn kennt; sonst geht er als
 * Text bzw. in den Bericht.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../thinking/thinking-runtime.js', () => ({ getThinkingSettings: () => ({ enabled: true, learning: { enabled: false } }) }))

const { addThought, getThought, listThoughts } = await import('../planner/index.js')
const { listApprovalCards } = await import('./approval-cards.js')
const { createPlannerTelegramPort } = await import('./planner-card-bridge.js')
const hub = await import('./thought-hub.js')
const { createSelfUpdateThoughtSink, createSensingThoughtSink, createThinkingThoughtSink, rememberAutoReminderAction } = hub
const hasThoughtAction = (id: string): Promise<boolean> => (hub as any).hasThoughtAction(id)
const { createUpdateProposal } = await import('./self-update/release-watch.js')

const base = { createdAt: new Date().toISOString(), urgency: 'normal' as const }
function fakeTelegram() {
    return { hasCardAuthority: vi.fn(async () => true), getOwnerChatIds: vi.fn(() => ['1001']), sendApprovalCard: vi.fn(async () => 7) }
}
async function deliver(thoughtId: string, tg = fakeTelegram()) {
    const thought = getThought(thoughtId)!
    const receipt = await createPlannerTelegramPort(tg).deliver({ id: `out-${thoughtId.slice(3, 15)}`, kind: 'gedanke', title: thought.title, text: thought.evidence || thought.title, permission: thought.permission, thoughtId, ...base })
    return { receipt, tg, card: listApprovalCards().find(card => card.aktion.ref === thoughtId) }
}

describe('Punkt 5: ein fragen-Gedanke wird nur mit Ausführungsweg eine Karte', () => {
    it('a fragen thought without a remembered action gets no card; it goes out as plain text', async () => {
        const { thought } = addThought({ source: 'test', title: 'Antwortentwurf vorbereiten?', severity: 'warning', kind: 'vorschlag', proposal: 'Entwurf', permission: 'fragen', signature: 'weg-ohne-aktion' })
        expect(await hasThoughtAction(thought.id)).toBe(false)
        const { receipt, tg, card } = await deliver(thought.id)
        expect(receipt.status).toBe('zugestellt')
        expect(card).toBeUndefined()
        expect(getThought(thought.id)?.status).not.toBe('wartet-auf-knopf')
        expect(tg.sendApprovalCard).toHaveBeenCalledWith('1001', expect.stringContaining('Antwortentwurf'), [])
    })

    it('Gegenprobe: an idea with action idee-pruefen still becomes one card', async () => {
        await createThinkingThoughtSink().emit({
            id: 'idee-weg-1', createdAt: new Date().toISOString(), source: 'ideen-lauf', kind: 'idee:werkzeug-fehler', title: 'Werkzeug weg_test scheitert oft',
            text: 'weg_test scheitert', evidence: [{ metric: 'errorRate', value: 40, unit: '%', source: 'traces' }], target: 'Fehlerrate unter 20 %', importance: 0.6,
            proposal: { action: 'idee-pruefen', params: { regel: 'werkzeug-fehler', subjekt: 'weg_test', metrik: 'errorRate', vorher: 40, ziel: 20, richtung: 'unter' }, autoExecute: false },
            stufe: 'fragen', status: 'neu', dedupeKey: 'werkzeug-fehler:weg_test',
        } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title === 'Werkzeug weg_test scheitert oft')!
        expect(thought.permission).toBe('fragen')
        expect(await hasThoughtAction(thought.id)).toBe(true)
        const { card } = await deliver(thought.id)
        expect(card?.aktion.kind).toBe('gedanke')
        expect(listApprovalCards().filter(item => item.aktion.ref === thought.id)).toHaveLength(1)
    })

    it('Gegenprobe: an auto-reminder plan has a path (card)', async () => {
        const { thought } = addThought({ source: 'auto-erinnerungen', title: 'Morgen 09:00 erinnern?', kind: 'vorschlag', proposal: 'Erinnerung', permission: 'fragen', signature: 'weg-erinnerung' })
        rememberAutoReminderAction(thought.id, 'ar-0123456789ab')
        expect(await hasThoughtAction(thought.id)).toBe(true)
        expect((await deliver(thought.id)).card?.aktion.kind).toBe('gedanke')
    })

    it('a release proposal without a host agent is a report entry, not a card with a Ja that does nothing', async () => {
        const proposal = createUpdateProposal({
            version: '2.86.0', tag: 'v2.86.0', releaseId: 'rel-1', commit: 'a'.repeat(40), publisherKeyId: 'xaventra-update-20260910',
            artifacts: [{ arch: 'amd64', name: 'x.json', size: 10, sha256: 'b'.repeat(64), image: 'example.com/xaventra:2.86.0' }],
            notes: 'Notizen', checkedAt: new Date().toISOString(),
        } as any)
        expect(proposal.permission).toBe('selbst')
        expect(proposal.text).not.toContain('Installieren?')
        expect(proposal.text).toMatch(/rollt Claude aus/)
        await createSelfUpdateThoughtSink().emit({ ...proposal, permission: 'fragen' })
        const thought = listThoughts({ limit: 500 }).find(item => item.title === 'Xaventra 2.86.0 verfügbar')!
        // Even a producer that still asks: the self-update path has no executor yet.
        expect(thought.permission).not.toBe('fragen')
        expect((await deliver(thought.id)).card).toBeUndefined()
    })

    it('a sensing hint „fragen“ without an approveDevice action is no question', () => {
        createSensingThoughtSink().writeThought({ source: 'mail', title: 'E-Mail von a@example.com (Angebot)', summary: 'Angebot', level: 'fragen', proposal: 'Antwortentwurf vorbereiten?', dedupeKey: 'mail:weg-1', importance: 'hoch' })
        const thought = listThoughts({ limit: 500 }).find(item => item.title === 'E-Mail von a@example.com (Angebot)')!
        expect(thought.permission).toBe('selbst')
        createSensingThoughtSink().writeThought({ source: 'netz', title: 'Neues Gerät drucker-9', summary: 'neu', level: 'fragen', proposal: 'Freigeben?', action: { kind: 'approveDevice', deviceId: 'drucker-9' }, dedupeKey: 'dev:weg-9' })
        expect(listThoughts({ limit: 500 }).find(item => item.title === 'Neues Gerät drucker-9')!.permission).toBe('fragen')
    })

    it('a thinking thought „fragen“ without a known action is only an idea', async () => {
        await createThinkingThoughtSink().emit({
            id: 'denk-ohne-weg', createdAt: new Date().toISOString(), source: 'bug-finder', kind: 'bug-finder', title: 'Denk-Gedanke ohne Weg',
            text: 'x', evidence: [], importance: 0.5, stufe: 'fragen', status: 'neu', dedupeKey: 'denk-ohne-weg',
        } as any)
        const thought = listThoughts({ limit: 500 }).find(item => item.title === 'Denk-Gedanke ohne Weg')!
        expect(thought.permission).toBe('selbst')
    })
})

describe('Punkt 5: Invariante — jeder Erzeuger von „fragen“ hat einen Ausführungsweg', () => {
    // Each file that sets a thought/hint to `fragen` and the path its Ja takes.
    const ALLOWED: Record<string, string> = {
        'src/core/approval-cards.ts': 'Karten selbst (Stufe der Karte, kein Gedanke)',
        'src/core/thought-hub.ts': 'Software-Scout: gemerkte Aktion software-scout',
        'src/install/software-scout.ts': 'über den Software-Scout-Sink mit gemerkter Aktion',
        'src/planner/auto-reminders.ts': 'rememberAutoReminderAction → Planer-Job',
        'src/thinking/idea-run.ts': 'idee-pruefen',
        'src/thinking/model-scout.ts': 'modell-wechsel',
        'src/sensing/adapters/mail.ts': 'Sensing-Sink: ohne approveDevice nur Bericht',
        'src/sensing/adapters/printer.ts': 'Sensing-Sink: ohne approveDevice nur Bericht',
        'src/sensing/event-bus.ts': 'Sensing-Sink: nur approveDevice wird Frage',
        'src/core/self-update/fencing-readiness.ts': 'Selbst-Update-Sink: ohne Host-Agent nur Bericht',
        'src/watch/engine.ts': 'rememberWatchAction; ohne freigegebenen Weg Text statt Karte',
        'src/planner/thoughts.ts': 'Standard für vorschlag; die Brücke prüft hasThoughtAction',
    }
    const PRODUCER = /(?:permission|stufe|level)\s*:\s*[^,\n]*'fragen'/

    function files(dir: string): string[] {
        return readdirSync(dir).flatMap(name => {
            const path = join(dir, name)
            if (statSync(path).isDirectory()) return files(path)
            return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
        })
    }

    it('no other file creates a fragen thought (responsibilities and release-watch no longer do)', () => {
        const root = process.env.NOVA_PROJECT_ROOT || process.cwd()
        const producers = files(join(root, 'src'))
            .filter(path => readFileSync(path, 'utf8').split('\n').some(line => PRODUCER.test(line) && !/^\s*(\*|\/\/)/.test(line) && !/'selbst'\s*\|\s*'fragen'/.test(line)))
            .map(path => relative(root, path).replace(/\\/g, '/'))
        expect(producers.filter(path => !ALLOWED[path])).toEqual([])
        expect(producers).not.toContain('src/core/responsibilities.ts')
        expect(producers).not.toContain('src/core/self-update/release-watch.ts')
    })
})
