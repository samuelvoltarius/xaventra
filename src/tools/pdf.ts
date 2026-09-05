/**
 * Nova - PDF Analyzer
 * 
 * Extracts text and analyzes PDF documents.
 * Uses pdfjs-dist for PDF parsing.
 */

import { existsSync, readFileSync } from 'node:fs'

// ============================================
// Types
// ============================================

export interface PDFPage {
    pageNumber: number
    text: string
    width: number
    height: number
}

export interface PDFDocument {
    path: string
    numPages: number
    pages: PDFPage[]
    metadata: PDFMetadata
}

export interface PDFMetadata {
    title?: string
    author?: string
    subject?: string
    creator?: string
    producer?: string
    creationDate?: Date
    modificationDate?: Date
}

export interface PDFAnalyzerConfig {
    maxPages?: number  // Limit pages to process
}

// ============================================
// PDF Analyzer
// ============================================

export class PDFAnalyzer {
    private config: Required<PDFAnalyzerConfig>
    private pdfjs: typeof import('pdfjs-dist') | null = null

    constructor(config: PDFAnalyzerConfig = {}) {
        this.config = {
            maxPages: config.maxPages ?? 100,
        }
    }

    /**
     * Load pdfjs library (lazy)
     */
    private async loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
        if (this.pdfjs) return this.pdfjs

        try {
            this.pdfjs = await import('pdfjs-dist')
            return this.pdfjs
        } catch (err) {
            throw new Error(`Failed to load pdfjs-dist: ${err}`)
        }
    }

    /**
     * Parse a PDF file and extract text
     */
    async parse(filePath: string): Promise<PDFDocument> {
        if (!existsSync(filePath)) {
            throw new Error(`PDF file not found: ${filePath}`)
        }

        const pdfjs = await this.loadPdfjs()
        const data = readFileSync(filePath)

        const doc = await pdfjs.getDocument({
            data: new Uint8Array(data),
            useSystemFonts: true,
        }).promise

        const pages: PDFPage[] = []
        const numPagesToProcess = Math.min(doc.numPages, this.config.maxPages)

        for (let i = 1; i <= numPagesToProcess; i++) {
            const page = await doc.getPage(i)
            const textContent = await page.getTextContent()
            const viewport = page.getViewport({ scale: 1.0 })

            const text = textContent.items
                .map((item: unknown) => {
                    const textItem = item as { str?: string }
                    return textItem.str ?? ''
                })
                .join(' ')

            pages.push({
                pageNumber: i,
                text: text.trim(),
                width: viewport.width,
                height: viewport.height,
            })
        }

        // Extract metadata
        const metadata = await this.extractMetadata(doc)

        return {
            path: filePath,
            numPages: doc.numPages,
            pages,
            metadata,
        }
    }

    /**
     * Extract metadata from PDF
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async extractMetadata(doc: any): Promise<PDFMetadata> {
        try {
            const meta = await doc.getMetadata()
            const info = meta.info ?? {}

            return {
                title: this.getString(info.Title),
                author: this.getString(info.Author),
                subject: this.getString(info.Subject),
                creator: this.getString(info.Creator),
                producer: this.getString(info.Producer),
                creationDate: this.parseDate(info.CreationDate),
                modificationDate: this.parseDate(info.ModDate),
            }
        } catch {
            return {}
        }
    }

    private getString(value: unknown): string | undefined {
        if (typeof value === 'string' && value.trim()) {
            return value.trim()
        }
        return undefined
    }

    private parseDate(value: unknown): Date | undefined {
        if (typeof value === 'string') {
            // PDF date format: D:YYYYMMDDHHmmSS
            const match = value.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/)
            if (match) {
                const [, year, month, day, hour = '0', min = '0', sec = '0'] = match
                return new Date(
                    parseInt(year),
                    parseInt(month) - 1,
                    parseInt(day),
                    parseInt(hour),
                    parseInt(min),
                    parseInt(sec)
                )
            }
        }
        return undefined
    }

    /**
     * Get full text from PDF (all pages combined)
     */
    async getText(filePath: string): Promise<string> {
        const doc = await this.parse(filePath)
        return doc.pages.map(p => p.text).join('\n\n')
    }

    /**
     * Get text from specific pages
     */
    async getTextFromPages(filePath: string, pageNumbers: number[]): Promise<string> {
        const doc = await this.parse(filePath)
        return doc.pages
            .filter(p => pageNumbers.includes(p.pageNumber))
            .map(p => p.text)
            .join('\n\n')
    }

    /**
     * Search for text in PDF
     */
    async search(filePath: string, query: string): Promise<Array<{ pageNumber: number; snippet: string }>> {
        const doc = await this.parse(filePath)
        const results: Array<{ pageNumber: number; snippet: string }> = []
        const queryLower = query.toLowerCase()

        for (const page of doc.pages) {
            const textLower = page.text.toLowerCase()
            let idx = textLower.indexOf(queryLower)

            while (idx !== -1) {
                // Get snippet around match
                const start = Math.max(0, idx - 50)
                const end = Math.min(page.text.length, idx + query.length + 50)
                const snippet = page.text.slice(start, end)

                results.push({
                    pageNumber: page.pageNumber,
                    snippet: (start > 0 ? '...' : '') + snippet + (end < page.text.length ? '...' : ''),
                })

                idx = textLower.indexOf(queryLower, idx + 1)
            }
        }

        return results
    }

    /**
     * Get page count without full parsing
     */
    async getPageCount(filePath: string): Promise<number> {
        if (!existsSync(filePath)) {
            throw new Error(`PDF file not found: ${filePath}`)
        }

        const pdfjs = await this.loadPdfjs()
        const data = readFileSync(filePath)

        const doc = await pdfjs.getDocument({
            data: new Uint8Array(data),
        }).promise

        return doc.numPages
    }
}

// ============================================
// Singleton
// ============================================

let pdfInstance: PDFAnalyzer | null = null

export function getPDFAnalyzer(): PDFAnalyzer {
    if (!pdfInstance) {
        pdfInstance = new PDFAnalyzer()
    }
    return pdfInstance
}

export default { PDFAnalyzer, getPDFAnalyzer }
