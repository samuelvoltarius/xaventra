/**
 * Document RAG — Index and retrieve documents via LanceDB vector search.
 *
 * Documents are chunked (512 tokens / ~2048 chars) and stored in LanceDB
 * alongside conversation memories. They are retrieved semantically on query.
 *
 * Usage:
 *   await indexDocument('path/to/file.md', 'user-123')
 *   const results = await queryDocuments('how does authentication work?', 'user-123')
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentRagStats {
    documents: number
    chunks: number
    lastIndexedName?: string
    lastIndexedAt?: string
    lastError?: string
}

export interface DocumentChunk {
    content: string
    source: string      // filename
    chunkIndex: number
    score?: number
}

// ─── In-memory index tracker ──────────────────────────────────────────────────

const _indexedDocs = new Map<string, { name: string; chunks: number; at: string }>()
let _lastError: string | undefined

// ─── Chunking ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE  = 1800   // chars (~450 tokens)
const CHUNK_OVERLAP = 200  // chars of overlap between chunks

function chunkText(text: string): string[] {
    if (text.length <= CHUNK_SIZE) return [text.trim()]

    const chunks: string[] = []
    let pos = 0
    while (pos < text.length) {
        const end = Math.min(pos + CHUNK_SIZE, text.length)
        const chunk = text.slice(pos, end).trim()
        if (chunk.length > 50) chunks.push(chunk)
        pos += CHUNK_SIZE - CHUNK_OVERLAP
    }
    return chunks
}

// ─── LanceDB bridge ───────────────────────────────────────────────────────────

async function getLanceMemory() {
    try {
        // LanceDB is initialized in daemon.ts as state.lanceMemory
        // Access via globalThis for cross-module access
        return (globalThis as any).__novaState?.lanceMemory ?? null
    } catch {
        return null
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Index a document file into LanceDB for semantic retrieval.
 * Supports: .md, .txt, .ts, .js, .json, .py (plain text)
 */
export async function indexDocument(filePath: string, userId = 'system'): Promise<{ chunks: number; name: string }> {
    if (!existsSync(filePath)) {
        _lastError = `File not found: ${filePath}`
        return { chunks: 0, name: '' }
    }

    const name = basename(filePath)
    const stat = statSync(filePath)
    if (stat.size > 5 * 1024 * 1024) {   // 5 MB limit
        _lastError = `File too large (${Math.round(stat.size / 1024)} KB): ${name}`
        return { chunks: 0, name }
    }

    let text: string
    try {
        text = readFileSync(filePath, 'utf-8')
    } catch (err: any) {
        _lastError = `Read error: ${err.message}`
        return { chunks: 0, name }
    }

    const chunks = chunkText(text)
    const lance = await getLanceMemory()

    if (!lance) {
        // LanceDB not available — store in stats only
        _lastError = 'LanceDB not available — chunks not persisted'
        _indexedDocs.set(filePath, { name, chunks: chunks.length, at: new Date().toISOString() })
        return { chunks: chunks.length, name }
    }

    let stored = 0
    for (let i = 0; i < chunks.length; i++) {
        try {
            await lance.remember(
                chunks[i],
                'document-chunk',
                `doc:${userId}:${name}`,
                { source: name, filePath, chunkIndex: i, userId, timestamp: Date.now() },
            )
            stored++
        } catch { /* skip failed chunk */ }
    }

    _indexedDocs.set(filePath, { name, chunks: stored, at: new Date().toISOString() })
    console.log(`[DocumentRAG] Indexed ${stored}/${chunks.length} chunks from ${name}`)
    return { chunks: stored, name }
}

/**
 * Query indexed documents semantically. Returns top-k relevant chunks.
 */
export async function queryDocuments(query: string, userId = 'system', limit = 3): Promise<DocumentChunk[]> {
    const lance = await getLanceMemory()
    if (!lance) return []

    try {
        const results = await lance.recall(query, limit * 2)
        return results
            .filter((r: any) => r.entry?.type === 'document-chunk')
            .slice(0, limit)
            .map((r: any) => ({
                content: r.entry?.content ?? '',
                source: r.entry?.metadata?.source ?? 'unknown',
                chunkIndex: r.entry?.metadata?.chunkIndex ?? 0,
                score: r.score,
            }))
    } catch {
        return []
    }
}

/**
 * Build a context block for injection into the system prompt.
 */
export async function getDocumentContext(query: string, userId = 'system'): Promise<string> {
    const chunks = await queryDocuments(query, userId, 3)
    if (chunks.length === 0) return ''

    const lines = chunks.map(c =>
        `[${c.source} §${c.chunkIndex + 1}] ${c.content.slice(0, 400)}`
    )
    return `\n\n## DOKUMENT-KONTEXT (aus RAG)\n${lines.join('\n\n---\n')}`
}

/**
 * Index a plain text string directly (no file needed).
 */
export async function indexText(text: string, sourceName: string, userId = 'system'): Promise<number> {
    const chunks = chunkText(text)
    const lance = await getLanceMemory()
    if (!lance) return 0

    let stored = 0
    for (let i = 0; i < chunks.length; i++) {
        try {
            await lance.remember(
                chunks[i],
                'document-chunk',
                `doc:${userId}:${sourceName}`,
                { source: sourceName, chunkIndex: i, userId, timestamp: Date.now() },
            )
            stored++
        } catch { /* skip */ }
    }
    _indexedDocs.set(sourceName, { name: sourceName, chunks: stored, at: new Date().toISOString() })
    return stored
}

/**
 * Stats for /status or audit endpoints.
 */
export function getDocumentRagStats(): DocumentRagStats {
    const docs = [..._indexedDocs.values()]
    const totalChunks = docs.reduce((s, d) => s + d.chunks, 0)
    const last = docs[docs.length - 1]
    return {
        documents: docs.length,
        chunks: totalChunks,
        lastIndexedName: last?.name,
        lastIndexedAt: last?.at,
        lastError: _lastError,
    }
}
