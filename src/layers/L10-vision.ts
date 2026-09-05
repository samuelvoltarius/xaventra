/**
 * L10 Vision Layer - Visual Feedback for Frontend Debugging
 * 
 * Takes screenshots and analyzes them with Vision LLM (OpenAI GPT-5.4 or Ollama)
 * to detect layout issues, CSS errors, and UI problems.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


// ============================================
// Types
// ============================================

export interface VisionAnalysis {
    timestamp: number
    url: string
    screenshotPath: string
    issues: VisionIssue[]
    suggestions: string[]
    summary: string
    model: string
}

export interface VisionIssue {
    type: 'layout' | 'color' | 'spacing' | 'responsive' | 'accessibility' | 'other'
    severity: 'low' | 'medium' | 'high'
    description: string
    location?: string  // e.g., "top-right", "navbar", "form"
}

export interface VisionConfig {
    screenshotDir: string
    model: string
    maxWidth: number
    maxHeight: number
}

// ============================================
// Vision Analyzer
// ============================================

export class VisionAnalyzer {
    private config: VisionConfig
    private playwright: unknown = null
    private visionBackend: 'ollama' | 'openai' = 'ollama'
    private detectedModel: string = ''

    constructor(config: Partial<VisionConfig> = {}) {
        this.config = {
            screenshotDir: config.screenshotDir || '.nova-vision',
            model: config.model || 'auto', // 'auto' = detect best available
            maxWidth: config.maxWidth || 1920,
            maxHeight: config.maxHeight || 1080,
        }

        // Ensure screenshot directory exists
        if (!existsSync(this.config.screenshotDir)) {
            mkdirSync(this.config.screenshotDir, { recursive: true })
        }

        // Start async model detection
        this.detectBestVisionModel().catch(() => { })

        console.log(`[L10 Vision] Analyzer initialized`)
    }

    /**
     * Dynamically detect available vision-capable models
     */
    private async detectBestVisionModel(): Promise<void> {
        if (this.config.model !== 'auto') {
            // If model was explicitly set, determine which backend to use
            this.detectedModel = this.config.model
            this.visionBackend = this.config.model.startsWith('gpt') ? 'openai' : 'ollama'
            console.log(`[L10 Vision] Using explicit model: ${this.detectedModel} (${this.visionBackend})`)
            return
        }

        // Try central model resolver first (scans entire network)
        try {
            const { resolveModel } = await import('../core/model-resolver.js')
            const resolved = await resolveModel('vision')
            if (resolved) {
                this.detectedModel = resolved.id
                this.visionBackend = resolved.provider === 'openai' ? 'openai' : 'ollama'
                console.log(`[L10 Vision] ✅ Auto-resolved: ${resolved.id} (${resolved.provider})`)
                return
            }
        } catch { /* resolver not available */ }

        // Fallback: local Ollama probe
        const visionModels = ['gemma3:12b', 'gemma3:4b', 'gemma3:latest', 'llava:latest', 'llava:13b', 'llava:7b', 'bakllava:latest', 'moondream:latest']
        try {
            const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) })
            if (resp.ok) {
                const data = await resp.json() as { models?: Array<{ name: string }> }
                const available = (data.models || []).map(m => m.name)
                for (const model of visionModels) {
                    if (available.some(a => a === model || a.startsWith(model.split(':')[0]))) {
                        this.detectedModel = model
                        this.visionBackend = 'ollama'
                        console.log(`[L10 Vision] ✅ Ollama fallback: ${model}`)
                        return
                    }
                }
            }
        } catch { /* Ollama not available */ }

        // Ultimate fallback
        this.detectedModel = 'gemma3:4b'
        this.visionBackend = 'ollama'
        console.log(`[L10 Vision] ⚠️ No vision model detected, falling back to ${this.detectedModel}`)
    }

    /**
     * Get OpenAI API key from config or environment
     */
    private getOpenAIKey(): string | null {
        // Try environment variable first
        if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY

        // Try xaventra.config.json
        try {
            const configPath = resolveConfigPath()
            if (existsSync(configPath)) {
                const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                return config.providers?.openai?.apiKey || config.apis?.openai_key || null
            }
        } catch { /* config not available */ }
        return null
    }

    /**
     * Capture screenshot of a URL
     */
    async captureScreenshot(url: string): Promise<{ path: string; buffer: Buffer }> {
        console.log(`[L10 Vision] Capturing: ${url}`)

        try {
            // Dynamic import Playwright
            const pw = await import('playwright')

            const browser = await pw.chromium.launch({ headless: true })
            const page = await browser.newPage({
                viewport: { width: this.config.maxWidth, height: this.config.maxHeight }
            })

            await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })

            // Wait for any animations to settle
            await page.waitForTimeout(1000)

            const timestamp = Date.now()
            const filename = `screenshot_${timestamp}.png`
            const filepath = join(this.config.screenshotDir, filename)

            const buffer = await page.screenshot({
                fullPage: false,
                type: 'png'
            })

            writeFileSync(filepath, buffer)
            await browser.close()

            console.log(`[L10 Vision] Screenshot saved: ${filepath}`)
            return { path: filepath, buffer }

        } catch (err) {
            console.error(`[L10 Vision] Screenshot failed: ${err}`)
            throw err
        }
    }

    /**
     * Analyze screenshot with best available Vision LLM
     */
    async analyzeScreenshot(
        screenshotPath: string,
        context?: string
    ): Promise<VisionAnalysis> {
        console.log(`[L10 Vision] Analyzing with ${this.detectedModel} (${this.visionBackend}): ${screenshotPath}`)

        const imageBuffer = readFileSync(screenshotPath)
        const base64Image = imageBuffer.toString('base64')

        const prompt = `Du bist ein UI/UX-Experte. Analysiere diesen Screenshot einer Webseite.

${context ? `Kontext: ${context}\n\n` : ''}

Suche nach:
1. **Layout-Probleme**: Überlappende Elemente, falsche Ausrichtung, gebrochene Grids
2. **Farb-Probleme**: Schlechter Kontrast, unlesbare Texte, inkonsistente Farben
3. **Spacing-Probleme**: Zu eng, zu weit, inkonsistente Abstände
4. **Responsive-Probleme**: Elemente die nicht passen, abgeschnittene Inhalte
5. **Accessibility-Probleme**: Fehlende Labels, kleine Klickbereiche

Antworte im JSON-Format:

\`\`\`json
{
  "summary": "Kurze Zusammenfassung der UI-Qualität",
  "issues": [
    {
      "type": "layout|color|spacing|responsive|accessibility|other",
      "severity": "low|medium|high",
      "description": "Was ist das Problem",
      "location": "Wo auf der Seite (z.B. 'Header', 'Footer', 'Formular')"
    }
  ],
  "suggestions": [
    "Konkrete Verbesserungsvorschläge"
  ]
}
\`\`\`

Falls keine Probleme gefunden werden, gib ein leeres issues-Array zurück.`

        try {
            let text = ''

            if (this.visionBackend === 'ollama') {
                // Use Ollama with multimodal model
                const response = await fetch('http://localhost:11434/api/generate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.detectedModel,
                        prompt,
                        images: [base64Image],
                        stream: false,
                    }),
                })

                if (!response.ok) throw new Error(`Ollama error: ${response.status}`)
                const data = await response.json() as { response?: string }
                text = data.response || ''

            } else {
                // Use OpenAI Vision API (GPT-5.4)
                const apiKey = this.getOpenAIKey()
                if (!apiKey) throw new Error('No OpenAI API key')

                const response = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: this.detectedModel || 'auto',
                        messages: [{
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:image/png;base64,${base64Image}`,
                                        detail: 'high',
                                    },
                                },
                            ],
                        }],
                        max_tokens: 2000,
                        temperature: 0.3,
                    }),
                })

                if (!response.ok) throw new Error(`OpenAI Vision error: ${response.status}`)
                const data = await response.json() as any
                text = data.choices?.[0]?.message?.content || ''
            }

            // Parse JSON from response
            const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*"issues"[\s\S]*\}/)
            if (!jsonMatch) {
                console.warn('[L10 Vision] No JSON in response')
                return this.emptyAnalysis(screenshotPath)
            }

            const jsonStr = jsonMatch[1] || jsonMatch[0]
            const parsed = JSON.parse(jsonStr)

            const analysis: VisionAnalysis = {
                timestamp: Date.now(),
                url: '',  // Will be set by caller
                screenshotPath,
                issues: parsed.issues || [],
                suggestions: parsed.suggestions || [],
                summary: parsed.summary || 'Keine Analyse verfügbar',
                model: this.detectedModel,
            }

            console.log(`[L10 Vision] Found ${analysis.issues.length} issues`)
            return analysis

        } catch (err) {
            console.error(`[L10 Vision] Analysis failed: ${err}`)
            return this.emptyAnalysis(screenshotPath)
        }
    }

    /**
     * Capture and analyze in one step
     */
    async captureAndAnalyze(url: string, context?: string): Promise<VisionAnalysis> {
        const { path } = await this.captureScreenshot(url)
        const analysis = await this.analyzeScreenshot(path, context)
        analysis.url = url
        return analysis
    }

    /**
     * Compare current screenshot with a reference
     */
    async compareWithReference(
        currentPath: string,
        referencePath: string
    ): Promise<{
        similarity: 'identical' | 'similar' | 'different'
        differences: string[]
    }> {
        console.log(`[L10 Vision] Comparing screenshots`)

        const currentBuffer = readFileSync(currentPath)
        const referenceBuffer = readFileSync(referencePath)

        const prompt = `Vergleiche diese zwei Screenshots und finde Unterschiede.

Bild 1 ist der AKTUELLE Stand.
Bild 2 ist die REFERENZ (so soll es aussehen).

Antworte im JSON-Format:

\`\`\`json
{
  "similarity": "identical|similar|different",
  "differences": [
    "Beschreibung der Unterschiede"
  ]
}
\`\`\``

        try {
            const apiKey = this.getOpenAIKey()
            if (!apiKey) throw new Error('No OpenAI API key for vision comparison')

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: 'auto',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${currentBuffer.toString('base64')}`,
                                    detail: 'high',
                                },
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${referenceBuffer.toString('base64')}`,
                                    detail: 'high',
                                },
                            },
                        ],
                    }],
                    max_tokens: 1000,
                }),
            })

            const data = await response.json() as any
            const text = data.choices?.[0]?.message?.content || ''
            const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)

            if (jsonMatch) {
                return JSON.parse(jsonMatch[1])
            }
        } catch (err) {
            console.error(`[L10 Vision] Comparison failed: ${err}`)
        }

        return { similarity: 'different', differences: ['Vergleich fehlgeschlagen'] }
    }

    private emptyAnalysis(path: string): VisionAnalysis {
        return {
            timestamp: Date.now(),
            url: '',
            screenshotPath: path,
            issues: [],
            suggestions: [],
            summary: 'Keine Probleme erkannt',
            model: this.config.model,
        }
    }

    /**
     * Format analysis for user message
     */
    formatAnalysis(analysis: VisionAnalysis): string {
        let msg = `👁️ **Vision Analysis**\n\n`
        msg += `📸 URL: ${analysis.url || 'N/A'}\n`
        msg += `📊 ${analysis.summary}\n\n`

        if (analysis.issues.length > 0) {
            msg += `**Gefundene Probleme (${analysis.issues.length}):**\n`
            for (const issue of analysis.issues) {
                const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢'
                msg += `${icon} **${issue.type}**: ${issue.description}`
                if (issue.location) msg += ` _(${issue.location})_`
                msg += `\n`
            }
            msg += `\n`
        } else {
            msg += `✅ Keine Probleme gefunden!\n\n`
        }

        if (analysis.suggestions.length > 0) {
            msg += `**Vorschläge:**\n`
            for (const suggestion of analysis.suggestions) {
                msg += `💡 ${suggestion}\n`
            }
        }

        return msg
    }
}

// ============================================
// Singleton
// ============================================

let visionAnalyzer: VisionAnalyzer | null = null

export function getVisionAnalyzer(): VisionAnalyzer {
    if (!visionAnalyzer) {
        visionAnalyzer = new VisionAnalyzer()
    }
    return visionAnalyzer
}

// ============================================
// Vision Feedback Loop — Nova self-corrects UI
// ============================================

interface FeedbackEntry {
    timestamp: number
    url: string
    issueCount: number
    highSeverity: number
    issues: VisionIssue[]
    suggestions: string[]
}

let feedbackLog: FeedbackEntry[] = []
let feedbackLoopInterval: ReturnType<typeof setInterval> | null = null

function loadFeedbackLog(): FeedbackEntry[] {
    try {
        const logPath = join(process.cwd(), '.nova-vision', 'feedback-log.json')
        if (existsSync(logPath)) {
            return JSON.parse(readFileSync(logPath, 'utf-8'))
        }
    } catch { /* fresh start */ }
    return []
}

function saveFeedbackLog(): void {
    try {
        const dir = join(process.cwd(), '.nova-vision')
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        const logPath = join(dir, 'feedback-log.json')
        // Keep last 50 entries
        writeFileSync(logPath, JSON.stringify(feedbackLog.slice(-50), null, 2))
    } catch { /* non-critical */ }
}

export async function runVisionFeedback(url: string = 'http://localhost:3001'): Promise<FeedbackEntry | null> {
    try {
        const analyzer = getVisionAnalyzer()
        const analysis = await analyzer.captureAndAnalyze(url, 'Nova Dashboard — prüfe auf UI-Probleme, Layout-Fehler, und UX-Verbesserungen')

        const entry: FeedbackEntry = {
            timestamp: Date.now(),
            url,
            issueCount: analysis.issues.length,
            highSeverity: analysis.issues.filter(i => i.severity === 'high').length,
            issues: analysis.issues,
            suggestions: analysis.suggestions,
        }

        feedbackLog.push(entry)
        saveFeedbackLog()

        if (entry.issueCount > 0) {
            console.log(`[L10 Vision Loop] 👁️ ${entry.issueCount} UI-Issues gefunden (${entry.highSeverity} kritisch)`)
        } else {
            console.log(`[L10 Vision Loop] ✅ Dashboard UI sieht gut aus`)
        }

        return entry
    } catch (err) {
        console.log(`[L10 Vision Loop] ⚠️ Feedback check failed: ${err}`)
        return null
    }
}

export function startVisionFeedbackLoop(intervalMinutes: number = 15): void {
    if (feedbackLoopInterval) return

    feedbackLog = loadFeedbackLog()
    console.log(`[L10 Vision Loop] Started (every ${intervalMinutes} min, ${feedbackLog.length} previous entries)`)

    feedbackLoopInterval = setInterval(async () => {
        await runVisionFeedback()
    }, intervalMinutes * 60 * 1000)
}

export function getVisionFeedbackContext(): string {
    if (feedbackLog.length === 0) return ''

    const recent = feedbackLog.slice(-3)
    const hasIssues = recent.some(e => e.issueCount > 0)
    if (!hasIssues) return ''

    let ctx = '\n\n## 👁️ DASHBOARD UI-FEEDBACK (Vision Loop)\n'
    for (const entry of recent) {
        if (entry.issueCount === 0) continue
        ctx += `\n**${new Date(entry.timestamp).toLocaleString('de')}** — ${entry.issueCount} Issues:\n`
        for (const issue of entry.issues) {
            ctx += `- [${issue.severity}] ${issue.type}: ${issue.description}\n`
        }
    }
    ctx += '\nBerücksichtige diese Issues wenn du UI-bezogene Fragen beantwortest.\n'
    return ctx
}

// ============================================
// Per-Action Screenshot Context Injection
// Inspired by Mark XXXIX — automatically captures screen context
// before browser/desktop tool calls so Nova "sees" what it's doing.
// ============================================

// Tools that benefit from having a screenshot as context
const VISUAL_TOOLS = new Set([
    'browser_open', 'browser_click', 'browser_type', 'browser_extract',
    'browser_search', 'browser_screenshot', 'browser_navigate',
    'desktop_click', 'desktop_type', 'desktop_screenshot',
    'playwright_action', 'computer_use',
])

let autoScreenshotEnabled = false
let lastAutoScreenshot: { path: string; timestamp: number; toolName: string } | null = null

export function enableAutoScreenshot(enabled = true): void {
    autoScreenshotEnabled = enabled
    console.log(`[L10 Vision] Auto-Screenshot ${enabled ? 'aktiviert' : 'deaktiviert'}`)
}

export function isAutoScreenshotEnabled(): boolean {
    return autoScreenshotEnabled
}

/**
 * Called by tool-router before executing a visual tool.
 * Returns a base64 screenshot string if auto-screenshot is enabled,
 * or null if not applicable / not enabled.
 */
export async function captureContextScreenshot(
    toolName: string,
    url?: string,
): Promise<string | null> {
    if (!autoScreenshotEnabled) return null
    if (!VISUAL_TOOLS.has(toolName)) return null

    const targetUrl = url || 'http://localhost:3001'

    try {
        const analyzer = getVisionAnalyzer()
        const { path, buffer } = await analyzer.captureScreenshot(targetUrl)

        lastAutoScreenshot = { path, timestamp: Date.now(), toolName }

        // Return as base64 for inline use in LLM messages
        return `data:image/png;base64,${buffer.toString('base64')}`
    } catch {
        // Screenshot failure is non-fatal — tool still runs
        return null
    }
}

/**
 * Returns a text context block for injection into the system prompt,
 * describing what was last seen on screen.
 * Used by tool-router to add visual context to LLM messages.
 */
export async function getVisualToolContext(toolName: string, url?: string): Promise<string> {
    if (!autoScreenshotEnabled) return ''
    if (!VISUAL_TOOLS.has(toolName)) return ''

    try {
        const analyzer = getVisionAnalyzer()
        const targetUrl = url || 'http://localhost:3001'
        const { path } = await analyzer.captureScreenshot(targetUrl)
        const analysis = await analyzer.analyzeScreenshot(path, `Vor dem Tool-Aufruf: ${toolName}`)

        if (analysis.issues.length === 0 && !analysis.summary) return ''

        return `\n\n## 👁️ VISUELLER KONTEXT (vor ${toolName})\n${analysis.summary}\n${
            analysis.issues.slice(0, 3).map(i => `- [${i.severity}] ${i.description}`).join('\n')
        }\n`
    } catch {
        return ''
    }
}

export function getLastAutoScreenshot(): typeof lastAutoScreenshot {
    return lastAutoScreenshot
}

export default { VisionAnalyzer, getVisionAnalyzer, runVisionFeedback, startVisionFeedbackLoop, getVisionFeedbackContext, captureContextScreenshot, getVisualToolContext, enableAutoScreenshot, isAutoScreenshotEnabled, getLastAutoScreenshot }
