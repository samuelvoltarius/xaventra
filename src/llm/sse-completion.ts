/**
 * 2.87 Paket P: eine OpenAI-kompatible SSE-Antwort (vLLM/Qwen, LM Studio …)
 * lesen und daraus GENAU dieselbe Antwortform bauen wie ohne Strom
 * (Text, Werkzeugaufrufe, Grund, Nutzung). Unterwegs gehen nur sichtbare
 * Textstücke an den Hörer — eine Denkspur (`<think>…</think>`) nie, auch wenn
 * ihre Marken über mehrere Stücke geteilt ankommen.
 */
import type { VoiceTurnSink } from '../voice/voice-turn-stream.js'

export interface StreamedCompletion {
    content: string
    reasoning?: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    finishReason: string
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

const OPEN = '<think>'
const CLOSE = '</think>'

/** Filtert `<think>…</think>` aus einem Strom von Textstücken (zustandsbehaftet). */
export function createThinkFilter(): { push(text: string): string; flush(): string } {
    let inside = false
    let pending = ''
    const push = (text: string): string => {
        let buffer = pending + text
        pending = ''
        let out = ''
        for (;;) {
            if (inside) {
                const end = buffer.toLowerCase().indexOf(CLOSE)
                if (end < 0) {
                    // Teil einer möglichen Schlussmarke aufheben, Rest verwerfen.
                    const keep = partialSuffix(buffer, CLOSE)
                    pending = keep ? buffer.slice(-keep) : ''
                    return out
                }
                buffer = buffer.slice(end + CLOSE.length).replace(/^\s+/, '')
                inside = false
                continue
            }
            const start = buffer.toLowerCase().indexOf(OPEN)
            const orphan = buffer.toLowerCase().indexOf(CLOSE)
            if (orphan >= 0 && (start < 0 || orphan < start)) {
                // Schlussmarke ohne Anfang: alles davor war Denkspur.
                out = ''
                buffer = buffer.slice(orphan + CLOSE.length).replace(/^\s+/, '')
                continue
            }
            if (start < 0) {
                const keep = Math.max(partialSuffix(buffer, OPEN), partialSuffix(buffer, CLOSE))
                pending = keep ? buffer.slice(-keep) : ''
                return out + (keep ? buffer.slice(0, -keep) : buffer)
            }
            out += buffer.slice(0, start)
            buffer = buffer.slice(start + OPEN.length)
            inside = true
        }
    }
    return { push, flush: () => { const rest = inside ? '' : pending; pending = ''; return rest } }
}

function partialSuffix(text: string, marker: string): number {
    const lower = text.toLowerCase()
    for (let length = Math.min(marker.length - 1, lower.length); length > 0; length--) {
        if (marker.startsWith(lower.slice(-length))) return length
    }
    return 0
}

export async function readOpenAiCompletionStream(body: ReadableStream<Uint8Array>, sink: VoiceTurnSink | null): Promise<StreamedCompletion> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const filter = createThinkFilter()
    const tools: Record<number, { id: string; name: string; arguments: string }> = {}
    const announced = new Set<string>()
    let content = ''
    let reasoning = ''
    let finishReason = 'stop'
    let usage: StreamedCompletion['usage']
    let lineBuffer = ''
    let finished = false

    const emit = (text: string) => {
        if (!text) return
        content += text
        try { sink?.onTextDelta(text) } catch { /* Hörer darf die Antwort nie stören */ }
    }
    const handle = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) return
        const json = trimmed.slice(5).trim()
        if (json === '[DONE]') { finished = true; return }
        let data: any
        try { data = JSON.parse(json) } catch { return }
        if (data?.usage) {
            const prompt = Number(data.usage.prompt_tokens) || 0
            const completion = Number(data.usage.completion_tokens) || 0
            usage = { promptTokens: prompt, completionTokens: completion, totalTokens: Number(data.usage.total_tokens) || prompt + completion }
        }
        const choice = data?.choices?.[0]
        if (!choice) return
        if (choice.finish_reason) finishReason = String(choice.finish_reason)
        const delta = choice.delta || {}
        const thought = delta.reasoning ?? delta.reasoning_content
        if (typeof thought === 'string') reasoning += thought
        if (typeof delta.content === 'string' && delta.content) emit(filter.push(delta.content))
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = Number(call?.index ?? 0)
            const entry = tools[index] ||= { id: '', name: '', arguments: '' }
            if (call?.id) entry.id = String(call.id)
            if (call?.function?.name) entry.name += String(call.function.name)
            if (call?.function?.arguments) entry.arguments += String(call.function.arguments)
            if (entry.name && !announced.has(`${index}`)) {
                announced.add(`${index}`)
                try { sink?.onToolRound([entry.name]) } catch { /* nur Anzeige */ }
            }
        }
    }

    while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() || ''
        for (const line of lines) handle(line)
    }
    if (lineBuffer) handle(lineBuffer)
    try { await reader.cancel() } catch { /* schon zu */ }
    emit(filter.flush())

    const toolCalls = Object.entries(tools).sort(([a], [b]) => Number(a) - Number(b)).map(([index, call]) => {
        let args: Record<string, unknown> = {}
        try { args = call.arguments ? JSON.parse(call.arguments) : {} } catch { /* Schema-Prüfung übernimmt */ }
        return { id: call.id || `local-tool-${index}`, name: call.name, arguments: args }
    }).filter(call => call.name)
    return {
        content: content.trim(),
        reasoning: reasoning.trim() || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        finishReason: toolCalls.length ? 'tool_calls' : finishReason,
        usage,
    }
}
