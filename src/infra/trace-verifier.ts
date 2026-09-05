export interface TraceContractResult {
    traceId: string
    tempoTraceId?: string
    complete: boolean
    required: string[]
    present: string[]
    missing: string[]
    checkedAt: string
}

export const PRODUCTION_TRACE_CONTRACT = [
    'nova.channel.message',
    'nova.llm.complete',
    'nova.tool.execute',
    'nova.tool.evidence',
    'nova.outcome.event',
] as const

export function verifyTraceSpanNames(
    traceId: string,
    spanNames: string[],
    required: readonly string[] = PRODUCTION_TRACE_CONTRACT,
    tempoTraceId?: string,
): TraceContractResult {
    const present = [...new Set(spanNames)]
    const missing = required.filter(name => !present.includes(name))
    return {
        traceId,
        tempoTraceId,
        complete: missing.length === 0,
        required: [...required],
        present,
        missing,
        checkedAt: new Date().toISOString(),
    }
}

function collectSpanNames(value: unknown, names: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) collectSpanNames(item, names)
        return names
    }
    if (!value || typeof value !== 'object') return names
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string' && (typeof record.spanId === 'string' || typeof record.spanID === 'string')) {
        names.push(record.name)
    }
    for (const child of Object.values(record)) collectSpanNames(child, names)
    return names
}

function normalizeTempoUrl(value: string): string {
    return value.trim().replace(/\/$/, '').replace(/:4318$/, ':3200')
}

export async function verifyProductionTrace(input: {
    novaTraceId: string
    tempoUrl: string
    timeoutMs?: number
}): Promise<TraceContractResult> {
    const tempoUrl = normalizeTempoUrl(input.tempoUrl)
    const timeoutMs = input.timeoutMs ?? 5_000
    const search = await fetch(
        `${tempoUrl}/api/search?tags=${encodeURIComponent(`nova.trace.id=${input.novaTraceId}`)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
    )
    if (!search.ok) throw new Error(`Tempo search failed: HTTP ${search.status}`)
    const payload = await search.json() as { traces?: Array<{ traceID?: string; traceId?: string }> }
    const tempoTraceId = payload.traces?.[0]?.traceID || payload.traces?.[0]?.traceId
    if (!tempoTraceId) return verifyTraceSpanNames(input.novaTraceId, [])

    const response = await fetch(`${tempoUrl}/api/traces/${encodeURIComponent(tempoTraceId)}`, {
        signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Tempo trace fetch failed: HTTP ${response.status}`)
    const tracePayload = await response.json()
    return verifyTraceSpanNames(input.novaTraceId, collectSpanNames(tracePayload), undefined, tempoTraceId)
}
