/**
 * Port for "thoughts" (Autonomie-Plan: Quelle, Beleg, Wichtigkeit, Vorschlag,
 * Erlaubnisstufe). Producers only describe; a thought never executes anything.
 * The approval cards (Phase 1) attach to this port during integration; the
 * default sink appends one JSON line per thought.
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ThoughtPermission = 'selbst' | 'fragen' | 'nie'
export type ThoughtImportance = 'niedrig' | 'normal' | 'hoch' | 'kritisch'

/** What a later, code-issued approval would bind to. Data only. */
export interface ThoughtProposal { action: string; params: Record<string, unknown> }

export interface Thought {
    schema: 1
    id: string
    at: string
    source: string
    kind: string
    title: string
    text: string
    evidence: string[]
    importance: ThoughtImportance
    permission: ThoughtPermission
    proposal?: ThoughtProposal
    /** Same key = same matter; consumers and producers debounce on it. */
    dedupeKey: string
}

export interface ThoughtSink { emit(thought: Thought): Promise<void> }

export function makeThought(input: Omit<Thought, 'schema' | 'id' | 'at'>, now = Date.now()): Thought {
    const at = new Date(now).toISOString()
    const id = createHash('sha256').update(`${input.dedupeKey}\n${at}`).digest('hex').slice(0, 16)
    return { schema: 1, id, at, ...input }
}

/** Default sink: append-only JSONL (0600). No network, no execution. */
export class JsonlThoughtSink implements ThoughtSink {
    constructor(readonly path: string) {}
    async emit(thought: Thought): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true })
        await appendFile(this.path, `${JSON.stringify(thought)}\n`, { encoding: 'utf8', mode: 0o600 })
    }
}

/** Plain-text cleanup for untrusted text (release notes) shown in a thought. */
export function plainText(value: unknown, max: number): string {
    const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
