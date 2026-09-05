/**
 * Nova — Universal Document Reader
 * 
 * Reads ANY file format with cascading strategy:
 * 1. Text files → readFileSync
 * 2. PDF → pdfjs-dist + quality check → VLM fallback
 * 3. Office (DOCX/XLSX/PPTX) → Python subprocess
 * 4. Images → VLM (Vision Language Model)
 * 5. Unknown → try text, then VLM
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, basename, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { homedir, platform } from 'node:os'

// ============================================
// Types
// ============================================

export interface DocumentResult {
    success: boolean
    text: string
    format: string
    method: 'text' | 'pdfjs' | 'python' | 'vlm' | 'vlm-fallback' | 'unknown'
    pages?: number
    metadata?: Record<string, string>
    error?: string
}

// ============================================
// Constants
// ============================================

const TEXT_EXTENSIONS = [
    '.txt', '.md', '.json', '.csv', '.xml', '.html', '.htm',
    '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.log', '.ts', '.js', '.py', '.sh', '.bat', '.ps1',
    '.css', '.scss', '.less', '.sql', '.env', '.gitignore',
    '.tsx', '.jsx', '.vue', '.svelte', '.astro',
]

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif']

const OFFICE_EXTENSIONS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp']

/** Resolve a real Python interpreter instead of trusting Windows Store aliases. */
export function findPythonExecutable(): string | null {
    const home = homedir()
    const candidates = [
        process.env.PYTHON_PATH,
        platform() === 'win32' ? join(home, 'AppData', 'Local', 'Python', 'bin', 'python.exe') : undefined,
        platform() === 'win32' ? join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe') : undefined,
        platform() === 'win32' ? join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe') : undefined,
        platform() === 'win32' ? join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe') : undefined,
        platform() === 'win32' ? 'C:\\Python313\\python.exe' : undefined,
        platform() === 'win32' ? 'C:\\Python312\\python.exe' : undefined,
        platform() === 'win32' ? 'C:\\Python311\\python.exe' : undefined,
        'python3',
        'python',
        'py',
    ].filter((candidate): candidate is string => !!candidate)

    for (const candidate of candidates) {
        if ((candidate.includes('\\') || candidate.includes('/')) && !existsSync(candidate)) continue
        const args = candidate === 'py' ? ['-3', '--version'] : ['--version']
        const probe = spawnSync(candidate, args, { encoding: 'utf8', timeout: 5_000, windowsHide: true })
        if (probe.status === 0 && !probe.error) return candidate
    }
    return null
}

function runPython(scriptPath: string, args: string[], options: { timeout: number; maxBuffer?: number }): string {
    const python = findPythonExecutable()
    if (!python) throw new Error('Kein funktionsfähiger Python-Interpreter gefunden (PYTHON_PATH kann gesetzt werden)')
    const pythonArgs = python === 'py' ? ['-3', scriptPath, ...args] : [scriptPath, ...args]
    return execFileSync(python, pythonArgs, {
        encoding: 'utf-8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }).trim()
}

// ============================================
// Main Entry Point
// ============================================

export async function readDocument(filePath: string): Promise<DocumentResult> {
    if (!existsSync(filePath)) {
        return { success: false, text: '', format: 'unknown', method: 'unknown', error: `Datei nicht gefunden: ${filePath}` }
    }

    const ext = extname(filePath).toLowerCase()
    const name = basename(filePath)
    console.log(`[DocReader] 📄 Reading: ${name} (${ext || 'no extension'})`)

    try {
        // 1. Text-based files
        if (TEXT_EXTENSIONS.includes(ext)) {
            return readAsText(filePath, ext)
        }

        // 2. PDF
        if (ext === '.pdf') {
            return await readPDF(filePath)
        }

        // 3. Office documents
        if (OFFICE_EXTENSIONS.includes(ext)) {
            return await readOffice(filePath, ext)
        }

        // 4. Images → VLM
        if (IMAGE_EXTENSIONS.includes(ext)) {
            return await readImage(filePath)
        }

        // 5. Unknown format → try text first, then VLM
        return await readUnknown(filePath, ext)

    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[DocReader] ❌ Error: ${error}`)
        return { success: false, text: '', format: ext, method: 'unknown', error }
    }
}

// ============================================
// Text Reader
// ============================================

function readAsText(filePath: string, ext: string): DocumentResult {
    const content = readFileSync(filePath, 'utf-8')
    console.log(`[DocReader] ✅ Text read: ${content.length} chars`)
    return {
        success: true,
        text: content,
        format: ext,
        method: 'text',
    }
}

// ============================================
// PDF Reader (pdfjs + VLM fallback)
// ============================================

async function readPDF(filePath: string): Promise<DocumentResult> {
    // Try pdfjs-dist first
    try {
        const pdfjs = await import('pdfjs-dist')
        const data = readFileSync(filePath)
        const doc = await pdfjs.getDocument({ data: new Uint8Array(data.buffer) }).promise

        const pages: string[] = []
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i)
            const textContent = await page.getTextContent()
            const text = textContent.items
                .map((item: any) => item.str || '')
                .join(' ')
            pages.push(text)
        }

        const fullText = pages.join('\n\n--- Seite ---\n\n')

        // Quality check: is the extracted text usable?
        if (isTextGarbage(fullText, doc.numPages)) {
            console.log(`[DocReader] ⚠️ PDF text is garbage (scanned/encrypted?), trying VLM...`)
            return await readPDFviaVLM(filePath, doc.numPages)
        }

        console.log(`[DocReader] ✅ PDF read via pdfjs: ${fullText.length} chars, ${doc.numPages} pages`)
        return {
            success: true,
            text: fullText,
            format: '.pdf',
            method: 'pdfjs',
            pages: doc.numPages,
        }
    } catch (pdfjsErr) {
        console.log(`[DocReader] ⚠️ pdfjs failed: ${pdfjsErr}, trying VLM...`)
        return await readPDFviaVLM(filePath)
    }
}

/**
 * Check if extracted PDF text is garbage (scanned PDF, embedded fonts, etc.)
 */
function isTextGarbage(text: string, pageCount: number): boolean {
    if (!text || text.trim().length === 0) return true

    // Too short for number of pages (< 20 chars per page average)
    if (text.length < pageCount * 20) return true

    // High ratio of non-word characters (typical for font encoding garbage)
    const words = text.match(/\b[a-zA-ZäöüÄÖÜß]{2,}\b/g) || []
    const wordRatio = words.length / (text.length / 5)  // Expected ~1 word per 5 chars
    if (wordRatio < 0.1) return true  // Less than 10% are real words

    // Too many replacement characters or control chars
    const garbageChars = (text.match(/[\ufffd\u0000-\u001f]/g) || []).length
    if (garbageChars > text.length * 0.05) return true  // >5% garbage chars

    return false
}

/**
 * Read PDF by converting pages to images and using VLM
 */
async function readPDFviaVLM(filePath: string, numPages?: number): Promise<DocumentResult> {
    // Use Python to convert PDF to images
    const tmpDir = join(process.cwd(), '.nova-tmp')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

    const pythonScript = `
import sys, os
try:
    import fitz  # PyMuPDF
except ImportError:
    os.system(sys.executable + ' -m pip install PyMuPDF -q')
    import fitz

doc = fitz.open(sys.argv[1])
out_dir = sys.argv[2]
for i, page in enumerate(doc):
    pix = page.get_pixmap(dpi=200)
    pix.save(os.path.join(out_dir, f'page_{i}.png'))
print(f'OK:{doc.page_count}')
`

    const scriptPath = join(tmpDir, '_pdf2img.py')
    writeFileSync(scriptPath, pythonScript)

    try {
        const output = runPython(scriptPath, [filePath, tmpDir], { timeout: 60_000 })

        const match = output.match(/OK:(\d+)/)
        const pageCount = match ? parseInt(match[1]) : numPages || 1

        // Read each page image with VLM
        const pageTexts: string[] = []
        for (let i = 0; i < Math.min(pageCount, 20); i++) {  // Max 20 pages
            const imgPath = join(tmpDir, `page_${i}.png`)
            if (!existsSync(imgPath)) continue

            const result = await analyzeImageWithVLM(imgPath, `Lies den gesamten Text auf dieser Seite (Seite ${i + 1}/${pageCount}). Gib NUR den Text wieder, keine Beschreibung.`)
            if (result) pageTexts.push(result)
        }

        const fullText = pageTexts.join('\n\n--- Seite ---\n\n')
        console.log(`[DocReader] ✅ PDF read via VLM: ${fullText.length} chars, ${pageCount} pages`)

        return {
            success: true,
            text: fullText,
            format: '.pdf',
            method: 'vlm-fallback',
            pages: pageCount,
        }
    } catch (pyErr) {
        console.error(`[DocReader] ❌ PDF→Image conversion failed: ${pyErr}`)
        return {
            success: false,
            text: '',
            format: '.pdf',
            method: 'vlm-fallback',
            error: `PDF konnte weder mit pdfjs noch via VLM gelesen werden: ${pyErr}`,
        }
    }
}

// ============================================
// Office Reader (Python subprocess)
// ============================================

async function readOffice(filePath: string, ext: string): Promise<DocumentResult> {
    const pythonScript = buildOfficePythonScript(ext)
    const tmpDir = join(process.cwd(), '.nova-tmp')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })

    const scriptPath = join(tmpDir, '_office_reader.py')
    writeFileSync(scriptPath, pythonScript)

    try {
        const output = runPython(scriptPath, [filePath], {
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024,
        })

        if (output.startsWith('ERROR:')) {
            throw new Error(output.replace('ERROR:', ''))
        }

        console.log(`[DocReader] ✅ Office read via Python: ${output.length} chars`)
        return {
            success: true,
            text: output,
            format: ext,
            method: 'python',
        }
    } catch (pyErr) {
        console.log(`[DocReader] ⚠️ Python failed for ${ext}: ${pyErr}, trying VLM...`)
        // Fallback: try to read with VLM (only for DOCX/DOC — convert to images first)
        return {
            success: false,
            text: '',
            format: ext,
            method: 'python',
            error: `Office-Datei konnte nicht gelesen werden: ${pyErr}`,
        }
    }
}

function buildOfficePythonScript(ext: string): string {
    if (['.docx', '.doc'].includes(ext)) {
        return `
import sys, os
try:
    from docx import Document
except ImportError:
    os.system(sys.executable + ' -m pip install python-docx -q')
    from docx import Document

doc = Document(sys.argv[1])
text = []
for para in doc.paragraphs:
    text.append(para.text)
for table in doc.tables:
    for row in table.rows:
        cells = [cell.text for cell in row.cells]
        text.append(' | '.join(cells))
print('\\n'.join(text))
`
    }

    if (['.xlsx', '.xls'].includes(ext)) {
        return `
import sys, os
try:
    import openpyxl
except ImportError:
    os.system(sys.executable + ' -m pip install openpyxl -q')
    import openpyxl

wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    print(f'=== Sheet: {sheet_name} ===')
    for row in ws.iter_rows(values_only=True):
        cells = [str(c) if c is not None else '' for c in row]
        print(' | '.join(cells))
    print()
`
    }

    if (['.pptx', '.ppt'].includes(ext)) {
        return `
import sys, os
try:
    from pptx import Presentation
except ImportError:
    os.system(sys.executable + ' -m pip install python-pptx -q')
    from pptx import Presentation

prs = Presentation(sys.argv[1])
for i, slide in enumerate(prs.slides):
    print(f'=== Folie {i+1} ===')
    for shape in slide.shapes:
        if shape.has_text_frame:
            for para in shape.text_frame.paragraphs:
                print(para.text)
    print()
`
    }

    // ODT/ODS/ODP — generic approach
    return `
import sys, os, zipfile, re

# ODF files are ZIP archives with content.xml
try:
    with zipfile.ZipFile(sys.argv[1], 'r') as z:
        content = z.read('content.xml').decode('utf-8')
        # Strip XML tags, keep text
        text = re.sub(r'<[^>]+>', ' ', content)
        text = re.sub(r'\\s+', ' ', text).strip()
        print(text)
except Exception as e:
    print(f'ERROR:{e}')
`
}

// ============================================
// Image Reader (VLM)
// ============================================

async function readImage(filePath: string): Promise<DocumentResult> {
    const description = await analyzeImageWithVLM(
        filePath,
        'Beschreibe dieses Bild detailliert. Wenn Text sichtbar ist, lies den gesamten Text. Wenn es ein Dokument oder Formular ist, extrahiere alle Informationen strukturiert.'
    )

    if (!description) {
        return {
            success: false,
            text: '',
            format: extname(filePath),
            method: 'vlm',
            error: 'VLM konnte das Bild nicht analysieren',
        }
    }

    console.log(`[DocReader] ✅ Image read via VLM: ${description.length} chars`)
    return {
        success: true,
        text: description,
        format: extname(filePath),
        method: 'vlm',
    }
}

// ============================================
// Unknown Format Reader
// ============================================

async function readUnknown(filePath: string, ext: string): Promise<DocumentResult> {
    // Try as text first
    try {
        const content = readFileSync(filePath, 'utf-8')
        // Check if it's actually readable text (not binary garbage)
        const binaryChars = (content.match(/[\x00-\x08\x0e-\x1f]/g) || []).length
        if (binaryChars < content.length * 0.01) {
            console.log(`[DocReader] ✅ Unknown format read as text: ${content.length} chars`)
            return {
                success: true,
                text: content,
                format: ext || 'unknown',
                method: 'text',
            }
        }
    } catch { /* not text */ }

    // Try as image via VLM
    console.log(`[DocReader] Trying unknown format as image via VLM...`)
    const description = await analyzeImageWithVLM(
        filePath,
        'Was zeigt diese Datei? Extrahiere allen sichtbaren Text und beschreibe den Inhalt.'
    )

    if (description) {
        return {
            success: true,
            text: description,
            format: ext || 'unknown',
            method: 'vlm',
        }
    }

    return {
        success: false,
        text: '',
        format: ext || 'unknown',
        method: 'unknown',
        error: 'Dateiformat nicht erkannt und VLM konnte nichts extrahieren',
    }
}

// ============================================
// VLM Helper (Ollama → OpenAI fallback)
// ============================================

async function analyzeImageWithVLM(imagePath: string, prompt: string): Promise<string | null> {
    const imageBuffer = readFileSync(imagePath)
    const base64Image = imageBuffer.toString('base64')
    const mimeType = getMimeType(imagePath)

    // Try central model resolver first
    let resolvedModel: string | null = null
    let resolvedEndpoint: string | null = null
    try {
        const { resolveModel } = await import('../core/model-resolver.js')
        const resolved = await resolveModel('vision')
        if (resolved) {
            resolvedModel = resolved.id
            resolvedEndpoint = resolved.endpoint || null
        }
    } catch { /* resolver not available */ }

    // Try 1: Local LLM (via resolved model — only if model was resolved)
    const ollamaModel = resolvedModel
    const ollamaUrl = resolvedEndpoint || 'http://localhost:11434'
    if (ollamaModel) {
        try {
            const resp = await fetch(`${ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ollamaModel,
                    prompt,
                    images: [base64Image],
                    stream: false,
                }),
                signal: AbortSignal.timeout(60000),
            })

            if (resp.ok) {
                const data = await resp.json() as { response?: string }
                if (data.response && data.response.length > 10) {
                    console.log(`[DocReader VLM] ✅ Local response (${ollamaModel}): ${data.response.length} chars`)
                    return data.response
                }
            }
        } catch { /* local LLM not available */ }
    }

    // Try 2: Nova's own LLM client (uses createNovaLLMClient which auto-resolves)
    try {
        const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
        const llm = await createNovaLLMClient({ role: 'vision' })
        const result = await llm.complete([
            { role: 'user', content: prompt, image: { data: base64Image, mimeType } },
        ])
        if (result.content && result.content.length > 10) {
            console.log(`[DocReader VLM] ✅ Nova LLM response: ${result.content.length} chars`)
            return result.content
        }
    } catch { /* Nova LLM not available */ }

    console.log(`[DocReader VLM] ❌ No VLM backend available`)
    return null
}

function getMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.tiff': 'image/tiff', '.tif': 'image/tiff',
        '.pdf': 'application/pdf',
    }
    return mimeMap[ext] || 'application/octet-stream'
}

// ============================================
// Exports
// ============================================

export default { readDocument }
