import { describe, expect, it } from 'vitest'
import { CLOUD_SYSTEM_PROMPT, createCloudSafeClient, sanitizeMessagesForCloud } from './cloud-prompt.js'

// Phase 6d: before anything leaves for a cloud model, memory, journal,
// conversation history and customer data are removed. Only the task and the
// code context needed for it remain.

const MEMORY_MARKERS = [
    'MEMORY-MARKER-7f3a', 'JOURNAL-MARKER-19c2', 'KUNDE-MARKER-55d0', 'VERLAUF-MARKER-a1b2', 'USERKONTEXT-MARKER-0c0c',
]

function pipelineMessages() {
    return [
        {
            role: 'system', content: [
                'Du bist Xaventra.',
                '## RELEVANTE ERINNERUNGEN', `- ${MEMORY_MARKERS[0]} Alfred mag Kaffee`,
                '## JOURNAL (heute)', `- ${MEMORY_MARKERS[1]} Termin beim Arzt`,
                '## USER-KONTEXT', `${MEMORY_MARKERS[4]} Wohnort und Familie`,
                '## HANDELN', 'Nutze Werkzeuge.',
            ].join('\n'),
        },
        { role: 'system', content: `<memory>${MEMORY_MARKERS[2]} Kundenliste Müller GmbH</memory>` },
        { role: 'user', content: `Gestern: ${MEMORY_MARKERS[3]} wir sprachen über das Haus` },
        { role: 'assistant', content: `Ja, ${MEMORY_MARKERS[3]} das Haus.` },
        { role: 'user', content: 'Schreib eine TypeScript-Funktion add(a, b) mit Test.\n```ts\nexport const x = 1\n```', image: { data: 'AAAA', mimeType: 'image/png' } },
    ]
}

describe('cleaned prompt for cloud targets', () => {
    it('removes memory, journal, customer data, user context and history; keeps task and code', () => {
        const { messages, removed } = sanitizeMessagesForCloud(pipelineMessages())
        const sent = JSON.stringify(messages)
        for (const marker of MEMORY_MARKERS) expect(sent).not.toContain(marker)
        expect(sent).toContain('Schreib eine TypeScript-Funktion add(a, b) mit Test.')
        expect(sent).toContain('export const x = 1')
        expect(messages[0]).toEqual({ role: 'system', content: CLOUD_SYSTEM_PROMPT })
        expect(messages.filter(message => message.role === 'system')).toHaveLength(1)
        // Pictures never leave.
        expect(sent).not.toContain('AAAA')
        expect(removed.systemMessages).toBe(2)
        expect(removed.historyMessages).toBe(2)
    })

    it('keeps the current tool loop but scrubs memory blocks out of it', () => {
        const input = [
            ...pipelineMessages(),
            { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }] },
            { role: 'tool', tool_call_id: 't1', content: `export function a() {}\n## GEDÄCHTNIS\n${MEMORY_MARKERS[0]}` },
        ]
        const { messages } = sanitizeMessagesForCloud(input)
        const sent = JSON.stringify(messages)
        expect(sent).toContain('export function a() {}')
        expect(sent).toContain('read_file')
        expect(sent).not.toContain(MEMORY_MARKERS[0])
    })

    it('guards every completion of a cloud client, including later rounds', async () => {
        const seen: any[][] = []
        const raw = { modelId: 'cloud-a', complete: async (messages: any[]) => { seen.push(messages); return { content: 'ok' } } }
        const safe = createCloudSafeClient(raw)
        expect((safe as any).modelId).toBe('cloud-a')
        await safe.complete(pipelineMessages() as any)
        await safe.complete(pipelineMessages() as any)
        expect(seen).toHaveLength(2)
        for (const call of seen) for (const marker of MEMORY_MARKERS) expect(JSON.stringify(call)).not.toContain(marker)
    })

    it('Gegenprobe: the raw pipeline messages do contain the markers', () => {
        const raw = JSON.stringify(pipelineMessages())
        for (const marker of MEMORY_MARKERS) expect(raw).toContain(marker)
    })
})
