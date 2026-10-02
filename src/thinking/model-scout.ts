/**
 * Phase 3 — Modell-Scout (wöchentlich über den Schedule-Port).
 *
 * 1. Kandidaten aus konfigurierten Quellen: Hugging-Face-API (nur GET, mit
 *    Zeitlimit, keine Anmeldung) oder eine Fixture-Datei (offline). Keine
 *    Quelle konfiguriert = nichts passiert. Netzfehler = leere Liste + Notiz.
 * 2. Filter: passt in den GB10-Speicher (Schätzung aus Parametern × Format +
 *    Reserve; Größe unbekannt = verworfen), vLLM-kompatibel (Transformers/
 *    Safetensors, nicht nur GGUF/MLX), Lizenz auf der Erlaubt-Liste.
 * 3. Prüfsatz aus echten Fällen (`probe-set.ts`, ohne private Inhalte).
 * 4. Vergleich gegen das aktuelle Modell NUR über einen injizierten
 *    `ScoutRunner` — dieser Bau lädt nichts herunter und startet kein Modell.
 *    Ohne Runner bleibt es bei „Kandidaten passen, ungetestet". Getestet wird
 *    nur bei gemessen ruhiger GPU (LoadProbe), nie neben vLLM-Last.
 *    2.84.0: gemessen werden nur INSTALLIERTE lokale Modelle (`inventory()`
 *    des Runners, scout-runner.ts). Reine Hugging-Face-Kandidaten werden Idee
 *    im Bericht („passt, nicht installiert; zum Testen auf die Zielliste
 *    setzen"), nie eine Karte.
 * 5. Vorschlag „Modell Z war X % besser" mit Testbericht als Gedanke (Stufe
 *    `fragen`) — 2.84.0 nur, wenn Z ein Ziel der vLLM-Wechselliste ist
 *    (`routing.vllm.targets`; der Vorschlag nennt den Zielnamen). Sonst Idee.
 *    Kein automatischer Wechsel: dieses Modul hat keinen Zugriff auf die
 *    Modell-Umschaltung.
 * 6. 2.86 Punkt 8: Ein Fund endet nicht mehr als Config-Arbeit für den Owner
 *    („auf die Zielliste setzen“). Nicht installierte passende Kandidaten und
 *    gemessene Sieger ohne Wechselziel werden für die Katalogpflege gesammelt
 *    (install/software-freshness.ts) und höchstens einmal pro Woche gebündelt
 *    über die vorhandene Delegation an Claude gegeben.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonSync } from '../core/atomic-storage.js'
import { getNovaDataDir } from '../core/data-root.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { CatalogFinding } from '../install/software-freshness.js'
import type { ProbeCase } from './probe-set.js'
import { judgeLoad, newThoughtId, type LoadProbe, type Thought, type ThoughtSink, type ThinkingSettings } from './ports.js'

export interface ModelCandidate {
    id: string
    source: string
    license?: string
    /** Parameter in Milliarden. */
    paramsB?: number
    /** Gewichtsformat: bf16, fp16, fp8, int8, awq, gptq, int4, nvfp4, … */
    quant?: string
    libraries: string[]
    tags: string[]
}

export interface ModelSource {
    name: string
    list(signal: AbortSignal): Promise<ModelCandidate[]>
}

export interface RunnerResult {
    model: string
    passed: number
    total: number
    avgLatencyMs: number
    perCase?: Array<{ id: string; ok: boolean }>
}

/** 2.84.0: ein Ziel der vLLM-Wechselliste; `modelId` = vom Host-Agenten erwartete Modell-ID (falls bekannt). */
export interface ScoutSwitchTarget { target: string; modelId?: string }
/** 2.84.0: was der Runner messen kann (installierte lokale Modelle) und wohin gewechselt werden darf. */
export interface ScoutInventory { installed: string[]; targets: ScoutSwitchTarget[] }

/** Port: führt den Prüfsatz gegen ein Modell aus (Integration: bereits laufender Endpoint). */
export interface ScoutRunner {
    evaluate(model: string, probes: ProbeCase[], signal: AbortSignal): Promise<RunnerResult>
    /** Installierte lokale Modelle und die vLLM-Wechselliste (ohne: nichts messbar außer dem aktuellen Modell). */
    inventory?(signal: AbortSignal): Promise<ScoutInventory>
}

const GIB = 1024 ** 3
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const BYTES_PER_PARAM: Record<string, number> = {
    f32: 4, fp32: 4, bf16: 2, fp16: 2, f16: 2, fp8: 1, int8: 1, awq: 0.55, gptq: 0.55, int4: 0.55, nvfp4: 0.55, mxfp4: 0.55,
}
/** Laufzeit-Reserve (KV-Cache, CUDA-Kontext) zusätzlich zu den Gewichten. */
export const RUNTIME_RESERVE_BYTES = 8 * GIB
const WEIGHT_OVERHEAD = 1.15

function quantFromName(id: string): string | undefined {
    const lower = id.toLowerCase()
    for (const key of ['nvfp4', 'mxfp4', 'awq', 'gptq', 'int4', 'fp8', 'int8', 'bf16', 'fp16']) if (lower.includes(key)) return key
    return undefined
}

function quantFromSafetensors(parameters: unknown): string | undefined {
    if (!parameters || typeof parameters !== 'object') return undefined
    const [top] = Object.entries(parameters as Record<string, number>).filter(([, value]) => Number(value) > 0).sort((a, b) => Number(b[1]) - Number(a[1]))
    if (!top) return undefined
    const key = top[0].toUpperCase()
    if (key === 'BF16') return 'bf16'
    if (key === 'F16') return 'fp16'
    if (key === 'F32') return 'f32'
    if (key.startsWith('F8')) return 'fp8'
    if (key === 'I8' || key === 'U8') return 'int8'
    if (key === 'I4' || key === 'U4') return 'int4'
    return undefined
}

/** Liest einen Eintrag der Hugging-Face-API (oder einer gleich aufgebauten Fixture). */
export function parseHubModel(raw: any, source: string): ModelCandidate | null {
    const id = String(raw?.id || raw?.modelId || '')
    if (!ID_PATTERN.test(id)) return null
    const tags: string[] = Array.isArray(raw?.tags) ? raw.tags.map((tag: unknown) => String(tag).toLowerCase()).slice(0, 80) : []
    const license = (tags.find(tag => tag.startsWith('license:'))?.slice('license:'.length) || (typeof raw?.license === 'string' ? raw.license.toLowerCase() : undefined)) || undefined
    const total = Number(raw?.safetensors?.total)
    const fromName = /(?:^|[-_/.])(\d+(?:\.\d+)?)[bB](?:$|[-_.])/.exec(id)?.[1]
    const paramsB = Number.isFinite(total) && total > 0 ? total / 1e9 : fromName ? Number(fromName) : undefined
    const libraries = [...new Set([raw?.library_name, ...tags.filter(tag => ['transformers', 'gguf', 'mlx', 'onnx', 'safetensors', 'vllm'].includes(tag))]
        .filter((value): value is string => typeof value === 'string' && !!value).map(value => value.toLowerCase()))]
    return { id, source, license, paramsB, quant: quantFromName(id) || quantFromSafetensors(raw?.safetensors?.parameters), libraries, tags }
}

export function huggingFaceSource(options: { url?: string; limit?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {}): ModelSource {
    const base = (options.url || 'https://huggingface.co').replace(/\/+$/, '')
    const limit = Math.max(1, Math.min(200, options.limit ?? 50))
    const timeoutMs = Math.max(10, options.timeoutMs ?? 10_000)
    const doFetch = options.fetchImpl || fetch
    return {
        name: 'huggingface',
        async list(signal) {
            const query = new URLSearchParams({ pipeline_tag: 'text-generation', sort: 'trendingScore', direction: '-1', limit: String(limit) })
            for (const field of ['safetensors', 'tags', 'library_name']) query.append('expand[]', field)
            const response = await doFetch(`${base}/api/models?${query.toString()}`, {
                method: 'GET', headers: { accept: 'application/json' }, redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            })
            if (!response.ok) throw new Error(`Hugging Face antwortet ${response.status}`)
            const body = await response.json()
            return (Array.isArray(body) ? body : []).map(item => parseHubModel(item, 'huggingface')).filter((item): item is ModelCandidate => !!item)
        },
    }
}

export function fixtureSource(path: string): ModelSource {
    return {
        name: 'fixture',
        async list() {
            if (!existsSync(path)) throw new Error('Fixture fehlt')
            const body = JSON.parse(readFileSync(path, 'utf8'))
            return (Array.isArray(body) ? body : []).map(item => parseHubModel(item, 'fixture')).filter((item): item is ModelCandidate => !!item)
        },
    }
}

/** Geschätzter Speicherbedarf in Bytes, oder null wenn die Größe unbekannt ist. */
export function estimateModelBytes(candidate: Pick<ModelCandidate, 'paramsB' | 'quant'>): number | null {
    if (!(Number(candidate.paramsB) > 0)) return null
    const perParam = BYTES_PER_PARAM[String(candidate.quant || '').toLowerCase()] ?? 2 // unbekanntes Format: wie bf16 rechnen
    return Math.round(candidate.paramsB! * 1e9 * perParam * WEIGHT_OVERHEAD + RUNTIME_RESERVE_BYTES)
}

export function isVllmCompatible(candidate: ModelCandidate): boolean {
    const libs = new Set([...candidate.libraries, ...candidate.tags])
    return libs.has('transformers') || libs.has('safetensors') || libs.has('vllm')
}

export function filterCandidates(candidates: readonly ModelCandidate[], options: { memoryBudgetBytes: number; licenses: readonly string[] }): { fit: ModelCandidate[]; rejected: Array<{ id: string; reason: string }> } {
    const fit: ModelCandidate[] = []
    const rejected: Array<{ id: string; reason: string }> = []
    const licenses = new Set(options.licenses.map(value => value.toLowerCase()))
    for (const candidate of candidates) {
        const bytes = estimateModelBytes(candidate)
        let reason = ''
        if (!(options.memoryBudgetBytes > 0)) reason = 'Speicherbudget unbekannt'
        else if (bytes === null) reason = 'Größe unbekannt'
        else if (bytes > options.memoryBudgetBytes) reason = `zu groß (${(bytes / GIB).toFixed(0)} GiB > ${(options.memoryBudgetBytes / GIB).toFixed(0)} GiB)`
        else if (!isVllmCompatible(candidate)) reason = 'nicht vLLM-kompatibel (nur GGUF/MLX/ONNX)'
        else if (!candidate.license || !licenses.has(candidate.license.toLowerCase())) reason = `Lizenz nicht erlaubt (${candidate.license || 'unbekannt'})`
        if (reason) rejected.push({ id: candidate.id, reason })
        else fit.push(candidate)
    }
    return { fit, rejected }
}

export interface ScoutReport {
    createdAt: string
    currentModel: string
    probes: { total: number; doctor: number; alltag: number }
    results: Array<{ model: string; passed: number; total: number; score: number; avgLatencyMs: number; error?: string }>
    rejected: Array<{ id: string; reason: string }>
    sourceErrors: string[]
    /** 2.84.0: Ideen ohne Karte (nicht installiert bzw. nicht auf der Wechselliste). */
    ideas?: Array<{ model: string; reason: string }>
}

export interface ModelScoutDeps {
    settings: ThinkingSettings
    sources: readonly ModelSource[]
    load: LoadProbe
    sink: ThoughtSink
    probes: ProbeCase[]
    runner?: ScoutRunner
    currentModel?: string
    memoryBudgetBytes?: number
    reportPath?: string
    now?: Date
    importanceFactor?: (kind: string) => number
    /** 2.86 Punkt 8: where model finds go (default: the Katalogpflege collection in software-freshness.ts). */
    catalogCare?: { note(findings: CatalogFinding[]): void | Promise<void> }
}

/** How many not-installed candidates of one run go to the Katalogpflege (the best-ranked first). */
const MAX_CARE_FINDS_PER_RUN = 5

export interface ModelScoutResult {
    ran: boolean
    reason: string
    candidates: ModelCandidate[]
    rejected: Array<{ id: string; reason: string }>
    sourceErrors: string[]
    report?: ScoutReport
    proposal?: Thought
}

const sameModel = (a: string, b: string) => {
    const norm = (value: string) => value.toLowerCase().trim()
    return norm(a) === norm(b) || norm(a).split('/').pop() === norm(b).split('/').pop()
}

export async function runModelScout(deps: ModelScoutDeps): Promise<ModelScoutResult> {
    const now = deps.now || new Date()
    const cfg = deps.settings.scout
    const empty = { candidates: [], rejected: [], sourceErrors: [] }
    if (!deps.settings.enabled || !cfg.enabled) return { ran: false, reason: 'aus', ...empty }
    // Testen heißt Last: vorher messen, damit bei belegter GPU auch nichts abgefragt wird.
    if (deps.runner) {
        const load = judgeLoad(await deps.load.sample(), deps.settings.load)
        if (!load.idle) return { ran: false, reason: load.reason, ...empty }
    }

    const sourceErrors: string[] = []
    const all: ModelCandidate[] = []
    for (const source of deps.sources) {
        try { all.push(...(await source.list(AbortSignal.timeout(30_000))).slice(0, 200)) }
        catch (error) { sourceErrors.push(`${source.name}: ${redactSecrets(String((error as Error)?.message || error)).slice(0, 160)}`) }
    }
    const current = deps.currentModel || cfg.currentModel || ''
    const unique = [...new Map(all.map(item => [item.id.toLowerCase(), item])).values()].filter(item => !current || !sameModel(item.id, current))
    const budget = deps.memoryBudgetBytes ?? (cfg.memoryBudgetGB ? cfg.memoryBudgetGB * GIB : 0)
    const { fit, rejected } = filterCandidates(unique, { memoryBudgetBytes: budget, licenses: cfg.licenses })
    // 2.84.0: what the runner can measure (installed, local) and where a switch may go.
    let inventory: ScoutInventory = { installed: [], targets: [] }
    if (deps.runner?.inventory) {
        try { inventory = await deps.runner.inventory(AbortSignal.timeout(60_000)) }
        catch (error) { sourceErrors.push(`Inventar: ${redactSecrets(String((error as Error)?.message || error)).slice(0, 160)}`) }
    }
    const installed = [...new Map((inventory.installed || []).filter(model => model && (!current || !sameModel(model, current))).map(model => [model.toLowerCase(), model])).values()]
    const targetOf = (model: string) => (inventory.targets || []).find(item => sameModel(item.target, model) || (item.modelId ? sameModel(item.modelId, model) : false))
    const ideas: Array<{ model: string; reason: string }> = deps.runner
        ? fit.filter(item => !installed.some(model => sameModel(model, item.id))).map(item => ({ model: item.id, reason: 'passt, nicht installiert; geht gesammelt an Claude zur Katalogpflege' }))
        : []
    // 2.86 Punkt 8: finds are collected for Claude's weekly Katalogpflege task, never owner config work.
    const noteCare = async (findings: CatalogFinding[]) => {
        if (!findings.length) return
        try {
            if (deps.catalogCare) await deps.catalogCare.note(findings)
            else (await import('../install/software-freshness.js')).noteCatalogFindings(findings, { now: now.getTime() })
        } catch { /* a lost find comes back next week */ }
    }
    const report: ScoutReport = {
        createdAt: now.toISOString(), currentModel: current,
        probes: { total: deps.probes.length, doctor: deps.probes.filter(item => item.origin === 'doctor').length, alltag: deps.probes.filter(item => item.origin === 'alltag').length },
        results: [], rejected: rejected.slice(0, 50), sourceErrors, ideas,
    }
    const save = () => {
        try { const path = deps.reportPath || getNovaDataDir('thinking', 'scout-report.json'); mkdirSync(dirname(path), { recursive: true }); atomicWriteJsonSync(path, report) } catch { /* Bericht ist optional */ }
    }
    const result = (reason: string, proposal?: Thought): ModelScoutResult => { save(); return { ran: true, reason, candidates: fit, rejected, sourceErrors, report, proposal } }

    if (!fit.length && !installed.length) return result(sourceErrors.length && !all.length ? 'keine Quelle erreichbar' : 'kein passender Kandidat')
    const factor = deps.importanceFactor ? deps.importanceFactor('modell-scout') : 1
    // Pure Hugging Face candidates are an idea in the report — never measured, never a card.
    if (ideas.length) {
        await noteCare(ideas.slice(0, MAX_CARE_FINDS_PER_RUN).map(item => ({ model: item.model, source: 'modell-scout' as const, reason: 'passt (Speicher, vLLM, Lizenz), nicht installiert', at: now.getTime(),
            url: `https://huggingface.co/${item.model}` })))
        await deps.sink.emit({
            id: newThoughtId('modell-scout', now), createdAt: now.toISOString(), source: 'modell-scout', kind: 'modell-scout:kandidaten',
            title: `${ideas.length} Modell-Kandidat(en) passen, nicht installiert`,
            text: `Passend (Speicher, vLLM, Lizenz), aber nicht installiert: ${ideas.slice(0, 5).map(item => item.model).join(', ')}. Geht gesammelt an Claude zur Katalogpflege (Katalogeintrag bzw. vLLM-Ziel prüfen, höchstens ein Auftrag pro Woche); gemessen wird nur Installiertes.`,
            evidence: [{ metric: 'passende Kandidaten', value: ideas.length, source: deps.sources.map(item => item.name).join(', ') }],
            importance: 0.2 * factor, stufe: 'selbst', status: 'info', dedupeKey: `modell-scout:kandidaten:${ideas.map(item => item.model).sort().join(',')}`,
        })
    }
    if (!deps.runner || !current || !deps.probes.length) {
        await deps.sink.emit({
            id: newThoughtId('modell-scout', now), createdAt: now.toISOString(), source: 'modell-scout', kind: 'modell-scout:kandidaten',
            title: `${fit.length} Modell-Kandidat(en) passen, ungetestet`,
            text: `Passend (Speicher, vLLM, Lizenz): ${fit.slice(0, 5).map(item => item.id).join(', ')}. Kein Testlauf: ${!deps.runner ? 'kein Prüf-Runner angeschlossen' : !current ? 'aktuelles Modell unbekannt' : 'Prüfsatz leer'}.`,
            evidence: [{ metric: 'passende Kandidaten', value: fit.length, source: deps.sources.map(item => item.name).join(', ') }],
            importance: 0.2 * factor, stufe: 'selbst', status: 'info', dedupeKey: `modell-scout:kandidaten:${fit.map(item => item.id).sort().join(',')}`,
        })
        return result('ungetestet (kein Runner/Modell/Prüfsatz)')
    }

    const evaluate = async (model: string) => {
        try {
            const value = await deps.runner!.evaluate(model, deps.probes, AbortSignal.timeout(30 * 60_000))
            const total = Math.max(0, Math.floor(value.total)), passed = Math.max(0, Math.min(total, Math.floor(value.passed)))
            return { model, passed, total, score: total ? passed / total : 0, avgLatencyMs: Math.round(Number(value.avgLatencyMs) || 0) }
        } catch (error) {
            return { model, passed: 0, total: 0, score: 0, avgLatencyMs: 0, error: redactSecrets(String((error as Error)?.message || error)).slice(0, 160) }
        }
    }
    if (!installed.length) return result(ideas.length ? 'nur nicht installierte Kandidaten — Idee im Bericht' : 'kein installiertes Modell zum Messen')
    const baseline = await evaluate(current)
    report.results.push(baseline)
    if (baseline.error || !baseline.total) return result('aktuelles Modell nicht messbar — kein Vergleich')
    for (const model of installed.slice(0, cfg.maxCandidates)) report.results.push(await evaluate(model))

    const improvement = (score: number) => baseline.score > 0 ? (score - baseline.score) / baseline.score * 100 : score * 100
    const best = report.results.slice(1).filter(item => !item.error && item.total > 0)
        .map(item => ({ ...item, gain: Math.round(improvement(item.score)) }))
        .sort((a, b) => b.gain - a.gain)[0]
    if (!best || best.gain < cfg.minImprovementPercent) return result(best ? `bester Kandidat nur ${best.gain} % besser (Schwelle ${cfg.minImprovementPercent} %)` : 'kein Kandidat messbar')

    const target = targetOf(best.model)
    if (!target) {
        // Better, but no switch target: an idea, never a card whose Ja could only fail.
        const reason = `${best.gain} % besser gemessen, aber kein Ziel der vLLM-Wechselliste — geht an Claude zur Katalogpflege`
        ideas.push({ model: best.model, reason })
        await noteCare([{ model: best.model, source: 'modell-scout', at: now.getTime(),
            reason: `${best.gain} % besser als ${current} gemessen (${best.passed}/${best.total} gegen ${baseline.passed}/${baseline.total} Prüffälle), kein Ziel der vLLM-Wechselliste` }])
        await deps.sink.emit({
            id: newThoughtId('modell-scout', now), createdAt: now.toISOString(), source: 'modell-scout', kind: 'modell-scout:idee',
            title: `${best.model} war ${best.gain} % besser (kein Wechselziel)`,
            text: `${best.model} war ${best.gain} % besser als ${current} (${best.passed}/${best.total} gegen ${baseline.passed}/${baseline.total} Prüffälle). Es steht nicht auf der vLLM-Wechselliste — geht gesammelt an Claude zur Katalogpflege (vLLM-Ziel prüfen), kein Wechselvorschlag.`,
            evidence: [
                { metric: `Trefferquote ${current}`, value: Math.round(baseline.score * 1000) / 10, unit: '%', source: 'Scout-Prüfsatz' },
                { metric: `Trefferquote ${best.model}`, value: Math.round(best.score * 1000) / 10, unit: '%', source: 'Scout-Prüfsatz' },
            ],
            importance: 0.3 * factor, stufe: 'selbst', status: 'info', dedupeKey: `modell-scout:idee:${best.model}`,
        })
        return result(`${best.model} (+${best.gain} %), kein Wechselziel — Idee`)
    }

    const proposal: Thought = {
        id: newThoughtId('modell-scout', now), createdAt: now.toISOString(), source: 'modell-scout', kind: 'modell-wechsel',
        title: `Neues Modell ${best.model} war ${best.gain} % besser`,
        text: `${best.model} war ${best.gain} % besser als ${current} (${best.passed}/${best.total} gegen ${baseline.passed}/${baseline.total} Prüffälle, `
            + `Ø ${best.avgLatencyMs} ms gegen ${baseline.avgLatencyMs} ms). Prüfsatz: ${report.probes.doctor} Doctor-Fälle, ${report.probes.alltag} Alltagsfragen. Wechselziel: ${target.target}. Kein automatischer Wechsel.`,
        evidence: [
            { metric: `Trefferquote ${current}`, value: Math.round(baseline.score * 1000) / 10, unit: '%', source: 'Scout-Prüfsatz' },
            { metric: `Trefferquote ${best.model}`, value: Math.round(best.score * 1000) / 10, unit: '%', source: 'Scout-Prüfsatz' },
        ],
        importance: Math.min(1, 0.5 + best.gain / 100) * factor,
        proposal: { action: 'modell-wechsel', params: { modell: target.target, von: current }, autoExecute: false },
        stufe: 'fragen', status: 'neu', dedupeKey: `modell-wechsel:${best.model}`, report,
    }
    await deps.sink.emit(proposal)
    return result(`Vorschlag ${best.model} (+${best.gain} %)`, proposal)
}
