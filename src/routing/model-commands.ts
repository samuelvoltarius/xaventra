/**
 * Phase 6d — `/modelle` (owner): the model register with proven capabilities,
 * privacy class, measurements and the current choice per task class, plus
 * `/modelle wechsel <aufgabe> <modell> [min]` which only PLANS a vLLM switch
 * (Knopf-Karte; nothing runs without "Ja").
 */
import type { ModelEndpoint, ModelRegistry } from './model-registry.js'
import {
    TASK_CLASS_LABELS, decideMultiRoute, readMultiRouteSettings,
    type MultiRouteSettings, type TaskModelClass,
} from './task-model-routing.js'

const CLASSES: readonly TaskModelClass[] = ['code', 'refactor', 'debug', 'vision', 'smalltalk', 'short', 'general']
const SOURCE_LABEL = { probe: 'Probe', ledger: 'Ledger', regel: 'Regel' } as const
const HEALTH_LABEL = { ok: 'gesund', down: 'nicht erreichbar', unbekannt: 'Gesundheit unbekannt' } as const

function endpointLines(ep: ModelEndpoint): string[] {
    const where = ep.node ? ` auf ${ep.node}` : ''
    const cost = ep.costEurPerCall === null ? 'Kosten unbekannt (gilt als teuer)' : `${ep.costEurPerCall} €/Aufruf`
    const loaded = ep.kind === 'ollama' ? (ep.loaded ? ' · geladen' : ' · nicht geladen') : ''
    const caps = ep.capabilities.length
        ? ep.capabilities.map(item => `${item.capability} (${SOURCE_LABEL[item.source]})`).join(', ')
        : 'keine belegt'
    const lines = [`• \`${ep.model}\` — ${ep.kind}${where} · ${ep.privacy} · ${cost} · ${HEALTH_LABEL[ep.health]}${loaded}`, `   Fähigkeiten: ${caps}`]
    if (ep.measurements.length) {
        lines.push(`   Messung: ${ep.measurements.map(item => `${TASK_CLASS_LABELS[item.taskClass]} ${Math.round(item.successRate * 100)} % (n=${item.samples}, ${item.avgLatencyMs} ms, ${item.source === 'scout' ? 'Scout' : 'Ledger'})`).join(' · ')}`)
    }
    return lines
}

export function formatModelRegistry(registry: ModelRegistry, settings: MultiRouteSettings, config: any = {}): string {
    const lines = ['🧭 *Modelle* (Register, Phase 6d)']
    lines.push(settings.enabled
        ? '▶️ Multi-Router: an — Stufe A harte Filter, Stufe B Messung (Erfolgsquote > Latenz > Kosten), ohne Messdaten R1–R8.'
        : '⏸️ Multi-Router: aus (routing.multi.enabled=false) — es gilt unverändert die Regeltabelle R1–R8.')
    lines.push(`💶 Cloud-Tagesbudget: ${settings.cloudDailyBudgetEur} €${settings.cloudDailyBudgetEur <= 0 ? ' (keine Cloud außer Codex nach Regeltabelle)' : ''} · heute verbraucht ${(settings.cloudSpentTodayEur || 0).toFixed(2)} €`)
    lines.push('', `*Register* (${registry.endpoints.length}; Quellen: ${registry.sources.join(', ') || 'keine'})`)
    if (!registry.endpoints.length) lines.push('• noch keine Endpunkte erkannt')
    for (const ep of registry.endpoints) lines.push(...endpointLines(ep))
    lines.push('', '*Aktuelle Wahl je Aufgabenart* (Owner, nicht privat):')
    const effective = settings.enabled ? settings : { ...settings, enabled: true }
    for (const taskClass of CLASSES) {
        const decision = decideMultiRoute(
            { signals: { content: '' }, permission: 'owner', codexEnabled: config?.codex?.enabled === true },
            registry, effective, { taskClass, private: taskClass === 'vision' },
        )
        const chosen = decision.endpoint
            ? `\`${decision.endpoint.model}\`${decision.endpoint.node ? ` auf ${decision.endpoint.node}` : ''} (Messung)`
            : decision.target === 'codex' ? `Codex (${decision.rule})` : `lokales Standardmodell (${decision.rule})`
        const admissible = decision.candidates.filter(item => !item.excluded).length
        lines.push(`• ${TASK_CLASS_LABELS[taskClass]} → ${settings.enabled ? chosen : `${decision.baseline.target === 'codex' ? 'Codex' : 'lokal'} (${decision.baseline.rule})${decision.endpoint ? ` · mit Multi-Router: ${chosen}` : ''}`} · ${admissible}/${decision.candidates.length} zulässig`)
    }
    lines.push('', 'vLLM-Wechsel am Spark: `/modelle wechsel <aufgabe> <ziel>` (Ziel aus der festen Liste, z. B. flash, coder) → Knopf-Karte, ~15 min ohne lokales LLM, Rückweg automatisch; nichts läuft ohne Ja.')
    return lines.join('\n')
}

const CLASS_ALIASES: Record<string, TaskModelClass> = {
    code: 'code', umbau: 'refactor', refactor: 'refactor', debug: 'debug', fehlersuche: 'debug', vision: 'vision', bild: 'vision',
    bilder: 'vision', smalltalk: 'smalltalk', kurz: 'short', short: 'short', allgemein: 'general', general: 'general',
}

export async function handleModelleCommand(args: string): Promise<string> {
    const config = (globalThis as any).__novaState?.config || {}
    const [{ collectModelRegistry }, { getCloudSpendToday }] = await Promise.all([import('./model-registry.js'), import('./model-runtime.js')])
    const registry = await collectModelRegistry({ config })
    const settings = { ...readMultiRouteSettings(config), cloudSpentTodayEur: getCloudSpendToday() }
    const parts = String(args || '').trim().split(/\s+/).filter(Boolean)
    if (parts[0]?.toLowerCase() !== 'wechsel') return formatModelRegistry(registry, settings, config)

    const taskClass = CLASS_ALIASES[String(parts[1] || '').toLowerCase()]
    const targetModel = parts[2]
    const minutes = Number.parseInt(parts[3] || '', 10)
    if (!taskClass || !targetModel) return 'Syntax: /modelle wechsel <code|umbau|fehlersuche|bild|kurz|allgemein> <ziel> [minuten]'
    const vllm = registry.endpoints.find(ep => ep.kind === 'vllm' && ep.privacy === 'lokal')
    if (!vllm) return '❌ Kein lokaler vLLM-Endpunkt im Register — kein Plan.'
    const measured = vllm.measurements.find(item => item.taskClass === taskClass)
    const { proposeVllmSwitch, resolveProductionVllmRuntime } = await import('./local-model-control.js')
    const result = await proposeVllmSwitch({
        node: vllm.node || 'spark', taskClass, targetModel: targetModel.toLowerCase(), baseUrl: vllm.baseUrl,
        estimatedMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 15,
        evidence: measured
            ? `Aktuell ${vllm.model}: ${TASK_CLASS_LABELS[taskClass]} ${Math.round(measured.successRate * 100)} % bei ${measured.samples} Läufen (${measured.source}). Wunsch des Owners per /modelle.`
            : `Für ${TASK_CLASS_LABELS[taskClass]} liegen für ${vllm.model} keine Messdaten vor. Wunsch des Owners per /modelle.`,
    }, { resolveRuntime: resolveProductionVllmRuntime })
    if (!result.ok) return `❌ Kein Plan: ${(result as { reason: string }).reason}`
    return `📝 Plan ${result.plan.id} angelegt und als Knopf-Karte eingereiht: ${result.card.vorschlag}`
}
