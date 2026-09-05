/**
 * Nova Markdown Processor
 * 
 * Inspired by OpenClaw's markdown/ (14 files, ir.ts 24KB)
 * Frontmatter parser, code fence extraction, table parser,
 * WhatsApp-safe markdown, IR parser/renderer
 */

// ============================================
// Frontmatter Parser
// ============================================

export interface Frontmatter {
    data: Record<string, unknown>
    content: string
    raw: string
}

export function parseFrontmatter(input: string): Frontmatter {
    const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!match) return { data: {}, content: input, raw: '' }

    const raw = match[1] || ''
    const content = match[2] || ''
    const data: Record<string, unknown> = {}

    for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const colonIdx = trimmed.indexOf(':')
        if (colonIdx === -1) continue
        const key = trimmed.slice(0, colonIdx).trim()
        let value: unknown = trimmed.slice(colonIdx + 1).trim()

        if (value === 'true') value = true
        else if (value === 'false') value = false
        else if (value === 'null') value = null
        else if (/^-?\d+$/.test(value as string)) value = parseInt(value as string, 10)
        else if (/^-?\d+\.\d+$/.test(value as string)) value = parseFloat(value as string)
        else if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
            value = (value as string).slice(1, -1)
        }

        data[key] = value
    }

    return { data, content, raw }
}

// ============================================
// Code Fence Extraction
// ============================================

export interface CodeFence {
    language: string
    code: string
    startLine: number
    endLine: number
}

export function extractCodeFences(markdown: string): CodeFence[] {
    const fences: CodeFence[] = []
    const lines = markdown.split('\n')
    let inFence = false
    let fenceStart = 0
    let fenceLang = ''
    let fenceCode: string[] = []
    let fenceChar = ''

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        const trimmed = line.trimStart()

        if (!inFence) {
            const m = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
            if (m) {
                inFence = true
                fenceChar = m[1]![0]!
                fenceLang = m[2]!.trim().split(/\s/)[0] || ''
                fenceStart = i
                fenceCode = []
            }
        } else {
            const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/)
            if (closeMatch && closeMatch[1]![0] === fenceChar) {
                fences.push({ language: fenceLang, code: fenceCode.join('\n'), startLine: fenceStart, endLine: i })
                inFence = false
                fenceCode = []
            } else {
                fenceCode.push(line)
            }
        }
    }
    return fences
}

export function stripCodeFences(markdown: string): string {
    const fences = extractCodeFences(markdown)
    if (fences.length === 0) return markdown
    const lines = markdown.split('\n')
    const skip = new Set<number>()
    for (const f of fences) for (let i = f.startLine; i <= f.endLine; i++) skip.add(i)
    return lines.filter((_, i) => !skip.has(i)).join('\n')
}

// ============================================
// WhatsApp-Safe Markdown
// ============================================

export function toWhatsAppMarkdown(markdown: string): string {
    let r = markdown
    r = r.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    r = r.replace(/\*\*(.+?)\*\*/g, '*$1*')
    r = r.replace(/__(.+?)__/g, '*$1*')
    r = r.replace(/~~(.+?)~~/g, '~$1~')
    r = r.replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    r = r.replace(/!\[(.+?)\]\(.+?\)/g, '[Bild: $1]')
    r = r.replace(/<[^>]+>/g, '')
    return r
}

// ============================================
// Markdown IR
// ============================================

export type MarkdownNodeType = 'heading' | 'paragraph' | 'code_block' | 'blockquote'
    | 'list' | 'list_item' | 'horizontal_rule' | 'frontmatter'

export interface MarkdownNode {
    type: MarkdownNodeType
    content: string
    children?: MarkdownNode[]
    attributes?: Record<string, string | number>
    startLine: number
    endLine: number
}

export function parseToIR(markdown: string): MarkdownNode[] {
    const nodes: MarkdownNode[] = []
    const fm = parseFrontmatter(markdown)
    const content = fm.content || markdown

    if (fm.raw) {
        nodes.push({
            type: 'frontmatter', content: fm.raw,
            startLine: 0, endLine: fm.raw.split('\n').length + 1,
            attributes: fm.data as Record<string, string | number>,
        })
    }

    const lines = content.split('\n')
    let i = 0

    while (i < lines.length) {
        const line = lines[i]!
        const trimmed = line.trim()
        if (trimmed === '') { i++; continue }

        // Heading
        const hm = trimmed.match(/^(#{1,6})\s+(.+)$/)
        if (hm) {
            nodes.push({ type: 'heading', content: hm[2]!, startLine: i, endLine: i, attributes: { level: hm[1]!.length } })
            i++; continue
        }
        // HR
        if (/^[-*_]{3,}$/.test(trimmed)) {
            nodes.push({ type: 'horizontal_rule', content: '', startLine: i, endLine: i })
            i++; continue
        }
        // Code block
        const fm2 = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
        if (fm2) {
            const lang = fm2[2]!.trim()
            const codeLines: string[] = []
            i++
            while (i < lines.length && !lines[i]!.trimStart().match(/^[`~]{3,}\s*$/)) {
                codeLines.push(lines[i]!)
                i++
            }
            nodes.push({ type: 'code_block', content: codeLines.join('\n'), startLine: i - codeLines.length - 1, endLine: i, attributes: lang ? { language: lang } : undefined })
            i++; continue
        }
        // Blockquote
        if (trimmed.startsWith('>')) {
            const ql: string[] = []
            while (i < lines.length && lines[i]!.trimStart().startsWith('>')) {
                ql.push(lines[i]!.replace(/^\s*>\s?/, ''))
                i++
            }
            nodes.push({ type: 'blockquote', content: ql.join('\n'), startLine: i - ql.length, endLine: i - 1 })
            continue
        }
        // List
        if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
            const items: MarkdownNode[] = []
            const ordered = /^\d+\./.test(trimmed)
            while (i < lines.length) {
                const ll = lines[i]!.trim()
                if (ll === '' || (!/^[-*+]\s/.test(ll) && !/^\d+\.\s/.test(ll) && !ll.startsWith('  '))) break
                items.push({ type: 'list_item', content: ll.replace(/^[-*+]\s|^\d+\.\s/, ''), startLine: i, endLine: i })
                i++
            }
            nodes.push({ type: 'list', content: '', children: items, startLine: items[0]!.startLine, endLine: items[items.length - 1]!.endLine, attributes: { ordered: ordered ? 1 : 0 } })
            continue
        }
        // Paragraph
        const pl: string[] = []
        while (i < lines.length && lines[i]!.trim() !== '') { pl.push(lines[i]!); i++ }
        nodes.push({ type: 'paragraph', content: pl.join('\n'), startLine: i - pl.length, endLine: i - 1 })
    }
    return nodes
}

export function renderIR(nodes: MarkdownNode[]): string {
    return nodes.map(n => {
        switch (n.type) {
            case 'frontmatter': return `---\n${n.content}\n---`
            case 'heading': return `${'#'.repeat((n.attributes?.level as number) || 1)} ${n.content}`
            case 'paragraph': return n.content
            case 'code_block': return `\`\`\`${n.attributes?.language || ''}\n${n.content}\n\`\`\``
            case 'blockquote': return n.content.split('\n').map(l => `> ${l}`).join('\n')
            case 'horizontal_rule': return '---'
            case 'list': return n.children?.map((item, idx) =>
                n.attributes?.ordered === 1 ? `${idx + 1}. ${item.content}` : `- ${item.content}`
            ).join('\n') || ''
            default: return n.content
        }
    }).join('\n\n')
}

// ============================================
// Utilities
// ============================================

export function extractHeadings(md: string): Array<{ level: number; text: string; line: number }> {
    return md.split('\n').reduce((acc, line, i) => {
        const m = line.match(/^(#{1,6})\s+(.+)$/)
        if (m) acc.push({ level: m[1]!.length, text: m[2]!.trim(), line: i })
        return acc
    }, [] as Array<{ level: number; text: string; line: number }>)
}

export function extractLinks(md: string): Array<{ text: string; url: string }> {
    const links: Array<{ text: string; url: string }> = []
    const re = /\[([^\]]+)\]\(([^)]+)\)/g
    let m
    while ((m = re.exec(md)) !== null) links.push({ text: m[1]!, url: m[2]! })
    return links
}

export function wordCount(md: string): number {
    const stripped = stripCodeFences(md).replace(/^#{1,6}\s+/gm, '').replace(/[*_~`]/g, '')
    return stripped.split(/\s+/).filter(w => w.length > 0).length
}

export function estimateReadingTime(md: string, wpm = 200): number {
    return Math.max(1, Math.ceil(wordCount(md) / wpm))
}
