/**
 * Desktop „System“ → „Wer kann was am besten“ (2.86 Paket J Punkt 5).
 *
 * Read-only projection of the one strength module (mesh/node-strengths.ts):
 * per strength the best places with their reason, the Main succession ranking,
 * which nodes were not ranked and why, and the recently detected changes.
 * Owner only via /api/desktop/system/staerken. Nothing here changes anything.
 */
import { clean } from './desktop-views.js'
import type { StrengthChange, StrengthFacts } from '../mesh/node-strengths.js'
import { rankNodes, STRENGTH_CAPABILITIES, STRENGTH_STALE_MS, type RankTarget } from '../mesh/node-strengths.js'

export interface StaerkenRangliste {
    id: string
    titel: string
    plaetze: Array<{ platz: number; knoten: string; begruendung: string[] }>
    nichtGeeignet: Array<{ knoten: string; grund: string }>
}

export interface StaerkenView {
    generatedAt: string
    faehigkeiten: StaerkenRangliste[]
    main: StaerkenRangliste
    knoten: Array<{ id: string; lokal: boolean; frisch: boolean }>
    aenderungen: Array<{ at: string; knoten: string; text: string[] }>
    hinweis: string
    probleme: string[]
}

const PLACES = 3

function liste(target: RankTarget, facts: StrengthFacts): StaerkenRangliste {
    const ranking = rankNodes(target, facts)
    return {
        id: target,
        titel: clean(ranking.label, 80),
        plaetze: ranking.ranked.slice(0, PLACES).map(item => ({
            platz: item.place, knoten: clean(item.nodeId, 80), begruendung: item.reasons.slice(0, 6).map(reason => clean(reason, 200)),
        })),
        nichtGeeignet: ranking.excluded.slice(0, 12).map(item => ({ knoten: clean(item.nodeId, 80), grund: clean(item.reason, 160) })),
    }
}

export function staerkenViewFrom(facts: StrengthFacts, changes: readonly StrengthChange[], problems: string[] = []): StaerkenView {
    return {
        generatedAt: new Date(facts.now).toISOString(),
        faehigkeiten: STRENGTH_CAPABILITIES.map(target => liste(target, facts)),
        main: liste('main', facts),
        knoten: [...facts.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(node => ({
            id: clean(node.nodeId, 80), lokal: node.local,
            frisch: node.local || (typeof node.lastSeen === 'number' && facts.now - node.lastSeen <= STRENGTH_STALE_MS),
        })),
        aenderungen: changes.slice(0, 20).map(change => ({ at: clean(change.at, 40), knoten: clean(change.nodeId, 80), text: change.changes.slice(0, 12).map(item => clean(item, 160)) })),
        hinweis: 'Aus signierten Knotenprofilen, laufender Software und gemessenen Owner-Läufen. Aufgaben mit „auto“ gehen an Platz 1; die Begründung steht im Beleg.',
        probleme: problems.map(item => clean(item, 200)),
    }
}

export async function collectStaerken(): Promise<StaerkenView> {
    const { collectStrengthFacts, listStrengthChanges } = await import('../mesh/node-strengths.js')
    const problems: string[] = []
    const facts = await collectStrengthFacts().catch(error => {
        problems.push(`Knotenfakten nicht lesbar: ${String((error as Error)?.message || error)}`)
        return { nodes: [], measurements: [], now: Date.now() } as StrengthFacts
    })
    const changes = await listStrengthChanges().catch(() => [] as StrengthChange[])
    return staerkenViewFrom(facts, changes, problems)
}
