/**
 * Advanced RAG (Retrieval Augmented Generation)
 * 
 * Better vector similarity, document chunking, semantic search.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface Document {
    id: string
    content: string
    metadata: {
        source: string
        type: 'file' | 'web' | 'memory' | 'conversation'
        timestamp: number
        [key: string]: unknown
    }
}

export interface Chunk {
    id: string
    documentId: string
    content: string
    embedding?: number[]
    startIndex: number
    endIndex: number
}

export interface SearchResult {
    chunk: Chunk
    score: number
    document: Document
}

// ============================================
// Chunking Strategies
// ============================================

const DEFAULT_CHUNK_SIZE = 500
const DEFAULT_OVERLAP = 50

/**
 * Split document into overlapping chunks
 */
export function chunkDocument(doc: Document, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP): Chunk[] {
    const chunks: Chunk[] = []
    const content = doc.content
    let start = 0
    let chunkIndex = 0

    while (start < content.length) {
        const end = Math.min(start + chunkSize, content.length)

        // Try to break at sentence boundary
        let actualEnd = end
        if (end < content.length) {
            const lastPeriod = content.lastIndexOf('.', end)
            const lastNewline = content.lastIndexOf('\n', end)
            const breakPoint = Math.max(lastPeriod, lastNewline)
            if (breakPoint > start + chunkSize / 2) {
                actualEnd = breakPoint + 1
            }
        }

        chunks.push({
            id: `${doc.id}_chunk_${chunkIndex}`,
            documentId: doc.id,
            content: content.slice(start, actualEnd).trim(),
            startIndex: start,
            endIndex: actualEnd,
        })

        start = actualEnd - overlap
        chunkIndex++
    }

    console.log(`[RAG] Chunked document ${doc.id} into ${chunks.length} chunks`)
    return chunks
}

// ============================================
// Simple Embedding (TF-IDF based)
// ============================================

/**
 * Simple embedding using word frequency (no external API needed)
 */
export function simpleEmbed(text: string, vocabSize = 1000): number[] {
    const words = text.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)

    // Create word frequency map
    const freq = new Map<string, number>()
    for (const word of words) {
        freq.set(word, (freq.get(word) || 0) + 1)
    }

    // Create fixed-size embedding using hash
    const embedding = new Array(vocabSize).fill(0)
    for (const [word, count] of freq) {
        const hash = Math.abs(hashCode(word)) % vocabSize
        embedding[hash] += count / words.length
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
    return magnitude > 0 ? embedding.map(v => v / magnitude) : embedding
}

function hashCode(s: string): number {
    let hash = 0
    for (let i = 0; i < s.length; i++) {
        hash = ((hash << 5) - hash) + s.charCodeAt(i)
        hash |= 0
    }
    return hash
}

// ============================================
// Similarity
// ============================================

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0

    let dotProduct = 0
    let magA = 0
    let magB = 0

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i]
        magA += a[i] * a[i]
        magB += b[i] * b[i]
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB)
    return magnitude > 0 ? dotProduct / magnitude : 0
}

// ============================================
// RAG Store
// ============================================

const RAG_DIR = '.nova-rag'

export class RAGStore {
    private documents: Map<string, Document> = new Map()
    private chunks: Map<string, Chunk> = new Map()
    private embeddings: Map<string, number[]> = new Map()

    constructor() {
        this.load()
    }

    private getPath(): string {
        const dir = join(process.cwd(), RAG_DIR)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        return join(dir, 'store.json')
    }

    private load(): void {
        const path = this.getPath()
        if (existsSync(path)) {
            try {
                const data = JSON.parse(readFileSync(path, 'utf-8'))
                this.documents = new Map(Object.entries(data.documents || {}))
                this.chunks = new Map(Object.entries(data.chunks || {}))
                this.embeddings = new Map(Object.entries(data.embeddings || {}))
                console.log(`[RAG] Loaded ${this.documents.size} documents, ${this.chunks.size} chunks`)
            } catch {
                console.log('[RAG] Failed to load store, starting fresh')
            }
        }
    }

    private save(): void {
        const data = {
            documents: Object.fromEntries(this.documents),
            chunks: Object.fromEntries(this.chunks),
            embeddings: Object.fromEntries(this.embeddings),
        }
        writeFileSync(this.getPath(), JSON.stringify(data, null, 2))
    }

    /**
     * Add a document to the store
     */
    addDocument(content: string, source: string, type: Document['metadata']['type'] = 'memory'): Document {
        const doc: Document = {
            id: crypto.randomUUID().slice(0, 8),
            content,
            metadata: { source, type, timestamp: Date.now() },
        }

        this.documents.set(doc.id, doc)

        // Chunk and embed
        const chunks = chunkDocument(doc)
        for (const chunk of chunks) {
            chunk.embedding = simpleEmbed(chunk.content)
            this.chunks.set(chunk.id, chunk)
            this.embeddings.set(chunk.id, chunk.embedding)
        }

        this.save()
        return doc
    }

    /**
     * Search for relevant chunks
     */
    search(query: string, topK = 5): SearchResult[] {
        const queryEmbedding = simpleEmbed(query)
        const results: SearchResult[] = []

        for (const [chunkId, embedding] of this.embeddings) {
            const score = cosineSimilarity(queryEmbedding, embedding)
            const chunk = this.chunks.get(chunkId)
            if (chunk) {
                const doc = this.documents.get(chunk.documentId)
                if (doc) {
                    results.push({ chunk, score, document: doc })
                }
            }
        }

        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
    }

    /**
     * Get context for a query
     */
    getContext(query: string, topK = 3): string {
        const results = this.search(query, topK)
        if (results.length === 0) return ''

        return results
            .filter(r => r.score > 0.1)
            .map(r => `[${r.document.metadata.source}]: ${r.chunk.content}`)
            .join('\n\n')
    }

    /**
     * Get stats
     */
    getStats(): { documents: number; chunks: number } {
        return {
            documents: this.documents.size,
            chunks: this.chunks.size,
        }
    }
}

// ============================================
// Singleton
// ============================================

let ragStore: RAGStore | null = null

export function getRAGStore(): RAGStore {
    if (!ragStore) {
        ragStore = new RAGStore()
    }
    return ragStore
}

export default {
    RAGStore,
    getRAGStore,
    chunkDocument,
    simpleEmbed,
    cosineSimilarity,
}
