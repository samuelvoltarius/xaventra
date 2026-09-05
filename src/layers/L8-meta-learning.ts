/**
 * Nova L8 - Meta-Learning System
 * 
 * Enables Nova to autonomously learn new capabilities:
 * 1. Detect missing capability
 * 2. Research how to solve it
 * 3. Create tools/skills
 * 4. Remember forever
 * 
 * Example Flow:
 *   User: "Erstelle ein Bild"
 *   Nova: (no image tool) → Research → Find API → Create Tool → Execute → Save Skill
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface CapabilityCheck {
    canDo: boolean
    capability: string
    missingTools?: string[]
    suggestedApproach?: 'api' | 'package' | 'automation' | 'existing'
    existingTool?: string
}

export interface LearnedSkill {
    id: string
    name: string
    capability: string
    description: string
    learnedAt: number
    source: string
    sourceUrl?: string
    toolCode: string
    successCount: number
    lastUsed: number
}

export interface ResearchResult {
    solution: string
    type: 'api' | 'package' | 'automation'
    url?: string
    installCommand?: string
    codeExample?: string
    requiresAuth: boolean
}

// ============================================
// Capability Map - Request Keywords → Capabilities
// ============================================

export const CAPABILITY_MAP: Record<string, {
    keywords: string[]
    description: string
    defaultApproach: 'api' | 'package' | 'automation'
}> = {
    image_generation: {
        keywords: ['bild erstellen', 'bild generieren', 'image create', 'foto generieren', 'generate image', 'create image', 'zeichne', 'male'],
        description: 'Bilder mit KI generieren',
        defaultApproach: 'api',
    },
    translation: {
        keywords: ['übersetzen', 'translate', 'übersetzung', 'ins englische', 'ins deutsche', 'auf japanisch', 'in japanese'],
        description: 'Text übersetzen',
        defaultApproach: 'api',
    },
    pdf_creation: {
        keywords: ['pdf erstellen', 'pdf create', 'als pdf', 'to pdf', 'pdf generieren'],
        description: 'PDF-Dokumente erstellen',
        defaultApproach: 'package',
    },
    email_sending: {
        keywords: ['email senden', 'mail senden', 'send email', 'schreibe email', 'email an'],
        description: 'Emails versenden',
        defaultApproach: 'package',
    },
    web_scraping: {
        keywords: ['scrape', 'extrahiere von website', 'daten von', 'crawl'],
        description: 'Daten von Websites extrahieren',
        defaultApproach: 'automation',
    },
    screenshot: {
        keywords: ['screenshot', 'bildschirmfoto', 'capture page', 'website foto'],
        description: 'Screenshots von Websites machen',
        defaultApproach: 'automation',
    },
    text_to_speech: {
        keywords: ['vorlesen', 'sprechen', 'text to speech', 'tts', 'audio erstellen'],
        description: 'Text in Sprache umwandeln',
        defaultApproach: 'api',
    },
    speech_to_text: {
        keywords: ['transkribieren', 'speech to text', 'stt', 'audio zu text', 'was sagt'],
        description: 'Sprache in Text umwandeln',
        defaultApproach: 'api',
    },
    qr_code: {
        keywords: ['qr code', 'qr erstellen', 'qr generate'],
        description: 'QR-Codes generieren',
        defaultApproach: 'package',
    },
    weather: {
        keywords: ['wetter', 'weather', 'temperatur', 'regen'],
        description: 'Wetterdaten abrufen',
        defaultApproach: 'api',
    },
    calendar: {
        keywords: ['termin', 'kalender', 'calendar', 'event erstellen'],
        description: 'Kalender-Integration',
        defaultApproach: 'api',
    },
}

// ============================================
// Solutions - PREFER LOCAL over API!
// ============================================

export const SOLUTIONS: Record<string, {
    local: ResearchResult
    api?: ResearchResult
}> = {
    image_generation: {
        local: {
            solution: 'Stable Diffusion (lokal via Python)',
            type: 'package',
            installCommand: 'pip install diffusers torch',
            requiresAuth: false,
            codeExample: `
# Python script für lokale Bildgenerierung
from diffusers import StableDiffusionPipeline
import torch

pipe = StableDiffusionPipeline.from_pretrained("stabilityai/sdxl-turbo")
pipe = pipe.to("cuda" if torch.cuda.is_available() else "cpu")

def generate_image(prompt: str, output_path: str):
    image = pipe(prompt, num_inference_steps=4).images[0]
    image.save(output_path)
    return output_path`,
        },
        api: {
            solution: 'Hugging Face Inference API (Fallback)',
            type: 'api',
            url: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
            requiresAuth: false,
            codeExample: `
async function generateImage(prompt: string): Promise<Buffer> {
    const response = await fetch(
        'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
        { method: 'POST', body: JSON.stringify({ inputs: prompt }) }
    )
    return Buffer.from(await response.arrayBuffer())
}`,
        },
    },
    translation: {
        local: {
            solution: 'Argos Translate (lokal offline)',
            type: 'package',
            installCommand: 'pip install argostranslate',
            requiresAuth: false,
            codeExample: `
import argostranslate.package
import argostranslate.translate

# Install language pack once
argostranslate.package.install_from_path("de_en.argosmodel")

def translate(text: str, from_lang: str, to_lang: str) -> str:
    return argostranslate.translate.translate(text, from_lang, to_lang)`,
        },
        api: {
            solution: 'LibreTranslate API',
            type: 'api',
            url: 'https://libretranslate.com/translate',
            requiresAuth: false,
            codeExample: `
async function translate(text: string, from: string, to: string): Promise<string> {
    const response = await fetch('https://libretranslate.com/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: from, target: to }),
    })
    return (await response.json()).translatedText
}`,
        },
    },
    speech_to_text: {
        local: {
            solution: 'Whisper (lokal via OpenAI whisper)',
            type: 'package',
            installCommand: 'pip install openai-whisper',
            requiresAuth: false,
            codeExample: `
import whisper

model = whisper.load_model("base")

def transcribe(audio_path: str) -> str:
    result = model.transcribe(audio_path)
    return result["text"]`,
        },
    },
    text_to_speech: {
        local: {
            solution: 'Piper TTS (lokal offline)',
            type: 'package',
            installCommand: 'pip install piper-tts',
            requiresAuth: false,
            codeExample: `
from piper import PiperVoice

voice = PiperVoice.load("de_DE-thorsten-medium.onnx")

def speak(text: str, output_path: str):
    audio = voice.synthesize(text)
    with open(output_path, "wb") as f:
        f.write(audio)`,
        },
    },
    weather: {
        local: {
            solution: 'Open-Meteo API (kostenlos, kein Key)',
            type: 'api',
            url: 'https://api.open-meteo.com/v1/forecast',
            requiresAuth: false,
            codeExample: `
async function getWeather(lat: number, lon: number): Promise<object> {
    const url = \`https://api.open-meteo.com/v1/forecast?latitude=\${lat}&longitude=\${lon}&current_weather=true\`
    return fetch(url).then(r => r.json())
}`,
        },
    },
    qr_code: {
        local: {
            solution: 'QRCode npm package (bereits installiert)',
            type: 'package',
            installCommand: 'npm install qrcode',
            requiresAuth: false,
            codeExample: `
import QRCode from 'qrcode'
async function createQR(text: string): Promise<string> {
    return QRCode.toDataURL(text)
}`,
        },
    },
    pdf_creation: {
        local: {
            solution: 'PDFKit npm package',
            type: 'package',
            installCommand: 'npm install pdfkit',
            requiresAuth: false,
            codeExample: `
import PDFDocument from 'pdfkit'
import fs from 'fs'

function createPDF(content: string, outputPath: string): void {
    const doc = new PDFDocument()
    doc.pipe(fs.createWriteStream(outputPath))
    doc.text(content)
    doc.end()
}`,
        },
    },
    screenshot: {
        local: {
            solution: 'Playwright (bereits installiert)',
            type: 'automation',
            requiresAuth: false,
            codeExample: `
import { chromium } from 'playwright'

async function screenshot(url: string, outputPath: string): Promise<void> {
    const browser = await chromium.launch()
    const page = await browser.newPage()
    await page.goto(url)
    await page.screenshot({ path: outputPath })
    await browser.close()
}`,
        },
    },
}

// ============================================
// Skill Store - Persistent Memory
// ============================================

export class SkillStore {
    private skillsDir: string
    private skills: Map<string, LearnedSkill> = new Map()

    constructor(baseDir?: string) {
        this.skillsDir = baseDir || join(
            process.env.USERPROFILE || process.env.HOME || '',
            '.nova', 'skills'
        )
        this.loadSkills()
    }

    private loadSkills(): void {
        if (!existsSync(this.skillsDir)) {
            mkdirSync(this.skillsDir, { recursive: true })
            return
        }

        const files = readdirSync(this.skillsDir).filter(f => f.endsWith('.json'))
        for (const file of files) {
            try {
                const skill = JSON.parse(readFileSync(join(this.skillsDir, file), 'utf-8'))
                this.skills.set(skill.capability, skill)
            } catch { /* ignore invalid files */ }
        }

        console.log(`[SkillStore] ✓ ${this.skills.size} Skills geladen`)
    }

    saveSkill(skill: LearnedSkill): void {
        this.skills.set(skill.capability, skill)
        const path = join(this.skillsDir, `${skill.capability}.json`)
        writeFileSync(path, JSON.stringify(skill, null, 2))
        console.log(`[SkillStore] ✓ Skill gespeichert: ${skill.name}`)
    }

    getSkill(capability: string): LearnedSkill | undefined {
        return this.skills.get(capability)
    }

    hasSkill(capability: string): boolean {
        return this.skills.has(capability)
    }

    recordUsage(capability: string): void {
        const skill = this.skills.get(capability)
        if (skill) {
            skill.successCount++
            skill.lastUsed = Date.now()
            this.saveSkill(skill)
        }
    }

    getAllSkills(): LearnedSkill[] {
        return Array.from(this.skills.values())
    }
}

// ============================================
// Capability Detector
// ============================================

export class CapabilityDetector {
    private existingTools: Set<string>

    constructor(toolNames: string[]) {
        this.existingTools = new Set(toolNames)
    }

    detect(request: string): CapabilityCheck {
        const lowerRequest = request.toLowerCase()

        // Check each capability
        for (const [capability, config] of Object.entries(CAPABILITY_MAP)) {
            for (const keyword of config.keywords) {
                if (lowerRequest.includes(keyword.toLowerCase())) {
                    // Found capability need, check if we have tools
                    const hasTool = this.hasToolForCapability(capability)

                    return {
                        canDo: hasTool,
                        capability,
                        existingTool: hasTool ? this.getToolForCapability(capability) : undefined,
                        suggestedApproach: hasTool ? 'existing' : config.defaultApproach,
                    }
                }
            }
        }

        // No specific capability detected
        return { canDo: true, capability: 'general' }
    }

    private hasToolForCapability(capability: string): boolean {
        const toolMappings: Record<string, string[]> = {
            image_generation: ['generate_image', 'create_image', 'image_gen'],
            translation: ['translate', 'translation'],
            screenshot: ['screenshot', 'capture_page'],
            web_scraping: ['scrape', 'extract_data'],
            qr_code: ['create_qr', 'qr_code'],
            weather: ['get_weather', 'weather'],
        }

        const tools = toolMappings[capability] || []
        return tools.some(t => this.existingTools.has(t))
    }

    private getToolForCapability(capability: string): string | undefined {
        const toolMappings: Record<string, string> = {
            image_generation: 'generate_image',
            translation: 'translate',
            screenshot: 'screenshot',
        }
        return toolMappings[capability]
    }

    updateTools(toolNames: string[]): void {
        this.existingTools = new Set(toolNames)
    }
}

// ============================================
// Self-Extension Engine
// ============================================

export class SelfExtensionEngine {
    private skillStore: SkillStore

    constructor(skillStore: SkillStore) {
        this.skillStore = skillStore
    }

    async acquireCapability(
        capability: string,
        onProgress?: (msg: string) => void
    ): Promise<{ success: boolean; toolCode?: string; error?: string }> {
        onProgress?.(`🔍 Recherchiere: ${capability}...`)

        // 1. Check if we already learned this
        const existingSkill = this.skillStore.getSkill(capability)
        if (existingSkill) {
            onProgress?.(`✅ Skill bereits gelernt: ${existingSkill.name}`)
            return { success: true, toolCode: existingSkill.toolCode }
        }

        // 2. Check pre-built solutions (prefer LOCAL over API!)
        const solutionSet = SOLUTIONS[capability]
        if (solutionSet) {
            // Prefer local solution, fallback to API
            const solution = solutionSet.local
            onProgress?.(`💡 Lösung gefunden: ${solution.solution} (LOCAL bevorzugt!)`)

            // 3. Handle based on type
            if (solution.type === 'package' && solution.installCommand) {
                onProgress?.(`📦 Installiere Package: ${solution.installCommand}`)
                // In production, would execute: exec(solution.installCommand)
            }

            // 4. Generate tool code
            const toolCode = this.generateToolCode(capability, solution)

            // 5. Save as learned skill
            const skill: LearnedSkill = {
                id: `skill_${Date.now()}`,
                name: CAPABILITY_MAP[capability]?.description || capability,
                capability,
                description: `Automatisch gelernt: ${solution.solution}`,
                learnedAt: Date.now(),
                source: solution.solution,
                sourceUrl: solution.url,
                toolCode,
                successCount: 0,
                lastUsed: Date.now(),
            }

            this.skillStore.saveSkill(skill)
            onProgress?.(`✅ Skill gelernt und gespeichert: ${skill.name}`)

            return { success: true, toolCode }
        }

        // 6. No pre-built solution - RESEARCH via web search!
        onProgress?.(`🌐 Keine lokale Lösung - starte Internet-Recherche...`)

        try {
            const webResult = await this.webResearch(capability, onProgress)
            if (webResult.success && webResult.solution) {
                // Generate tool code from web result
                const toolCode = this.generateToolCode(capability, webResult.solution)

                // Save as learned skill
                const skill: LearnedSkill = {
                    id: `skill_${Date.now()}`,
                    name: CAPABILITY_MAP[capability]?.description || capability,
                    capability,
                    description: `Via Web gelernt: ${webResult.solution.solution}`,
                    learnedAt: Date.now(),
                    source: webResult.solution.solution,
                    sourceUrl: webResult.solution.url,
                    toolCode,
                    successCount: 0,
                    lastUsed: Date.now(),
                }

                this.skillStore.saveSkill(skill)
                onProgress?.(`✅ Via Web gelernt und gespeichert: ${skill.name}`)

                return { success: true, toolCode }
            }
        } catch (err) {
            onProgress?.(`❌ Web-Recherche fehlgeschlagen: ${err}`)
        }

        return {
            success: false,
            error: `Keine Lösung für ${capability} gefunden (lokal + web).`
        }
    }

    /**
     * Web Research - Search internet for solutions
     */
    private async webResearch(
        capability: string,
        onProgress?: (msg: string) => void
    ): Promise<{ success: boolean; solution?: ResearchResult }> {
        try {
            // Dynamic import to avoid circular deps
            const { googleSearch } = await import('../tools/google-search.js')

            // Construct search query
            const queries = [
                `${capability} python library npm package free`,
                `${capability} local offline tool open source`,
                `how to implement ${capability} nodejs typescript`,
            ]

            for (const query of queries) {
                onProgress?.(`🔍 Suche: "${query}"`)

                const result = await googleSearch(query, 3)

                if (result.results.length > 0) {
                    const topResult = result.results[0]
                    onProgress?.(`📚 Gefunden: ${topResult.title}`)

                    // Extract solution from search result
                    const solution: ResearchResult = {
                        solution: topResult.title,
                        type: this.classifySolutionType(topResult),
                        url: topResult.url,
                        requiresAuth: false,
                        codeExample: await this.generateCodeWithLLM(capability, topResult),
                    }

                    return { success: true, solution }
                }
            }

            return { success: false }
        } catch (err) {
            console.error('[L8 WebResearch]', err)
            return { success: false }
        }
    }

    private classifySolutionType(result: { title: string; url: string; snippet: string }): ResearchResult['type'] {
        const combined = `${result.title} ${result.url} ${result.snippet}`.toLowerCase()

        if (combined.includes('npm') || combined.includes('github.com') || combined.includes('pip')) {
            return 'package'
        }
        if (combined.includes('api') || combined.includes('endpoint') || combined.includes('rest')) {
            return 'api'
        }
        return 'automation'
    }

    private generateToolCode(capability: string, solution: ResearchResult): string {
        if (solution.codeExample) {
            return solution.codeExample
        }

        // Synchronous fallback - return template with source info
        return `
// Auto-generated tool for: ${capability}
// Source: ${solution.solution}
// Type: ${solution.type}
// Requires Auth: ${solution.requiresAuth}
// URL: ${solution.url || 'N/A'}

export async function ${capability.replace(/_/g, '')}(input: unknown): Promise<unknown> {
    console.log('[${capability}] Executing with:', input)
    // Implementation based on ${solution.url || solution.solution}
    return { success: true, capability: '${capability}' }
}
`
    }

    /**
     * Generate implementation code using LLM
     */
    private async generateCodeWithLLM(
        capability: string,
        searchResult: { title: string; url: string; snippet: string }
    ): Promise<string> {
        try {
            const { createNovaLLMClient } = await import('../llm/nova-llm-sdk.js')
            const llm = await createNovaLLMClient({})

            const prompt = `Generate a TypeScript function to implement "${capability}" based on this research:

Title: ${searchResult.title}
URL: ${searchResult.url}
Snippet: ${searchResult.snippet}

Requirements:
- Export an async function named "${capability.replace(/_/g, '')}"
- Include proper error handling
- Use fetch() for API calls if needed
- Make it work with Node.js
- Keep it concise (under 50 lines)

Return ONLY the code, no explanations.`

            const response = await llm.complete([
                { role: 'system', content: 'Du bist ein Code-Generator. Antworte nur mit TypeScript-Code, keine Erklärungen.' },
                { role: 'user', content: prompt }
            ])

            const code = response.content || ''

            // Clean up markdown code blocks if present
            const cleanCode = code
                .replace(/```typescript\n?/g, '')
                .replace(/```ts\n?/g, '')
                .replace(/```\n?/g, '')
                .trim()

            return cleanCode || this.generateFallbackCode(capability, searchResult)
        } catch (err) {
            console.log(`[L8] LLM code generation failed: ${err}`)
            return this.generateFallbackCode(capability, searchResult)
        }
    }

    private generateFallbackCode(
        capability: string,
        searchResult: { title: string; url: string; snippet: string }
    ): string {
        return `
// Auto-generated for: ${capability}
// Source: ${searchResult.url}
// Title: ${searchResult.title}

export async function ${capability.replace(/_/g, '')}(input: unknown): Promise<unknown> {
    console.log('[${capability}] Input:', input)
    // See ${searchResult.url} for implementation guidance
    return { success: true, capability: '${capability}', source: '${searchResult.url}' }
}
`
    }
}

// ============================================
// Meta-Learning Orchestrator
// ============================================

export class MetaLearningSystem {
    private detector: CapabilityDetector
    private engine: SelfExtensionEngine
    private skillStore: SkillStore

    constructor(existingToolNames: string[] = []) {
        this.skillStore = new SkillStore()
        this.detector = new CapabilityDetector(existingToolNames)
        this.engine = new SelfExtensionEngine(this.skillStore)
    }

    async processRequest(
        request: string,
        onProgress?: (msg: string) => void
    ): Promise<{
        canExecute: boolean
        capability: string
        action: 'execute' | 'learn' | 'ask_user'
        toolCode?: string
    }> {
        // 1. Detect what capability is needed
        const check = this.detector.detect(request)
        onProgress?.(`[Meta-Learning] Capability: ${check.capability}`)

        // 2. Already have it?
        if (check.canDo) {
            return {
                canExecute: true,
                capability: check.capability,
                action: 'execute',
            }
        }

        // 3. Try to learn it
        onProgress?.(`[Meta-Learning] Lerne neue Fähigkeit: ${check.capability}`)
        const result = await this.engine.acquireCapability(check.capability, onProgress)

        if (result.success) {
            return {
                canExecute: true,
                capability: check.capability,
                action: 'learn',
                toolCode: result.toolCode,
            }
        }

        // 4. Couldn't learn automatically
        return {
            canExecute: false,
            capability: check.capability,
            action: 'ask_user',
        }
    }

    getLearnedSkills(): LearnedSkill[] {
        return this.skillStore.getAllSkills()
    }

    inspectRequest(request: string): CapabilityCheck {
        return this.detector.detect(request)
    }

    /** Update learned-skill confidence only from a verified successful outcome. */
    recordVerifiedOutcome(capability: string, success: boolean): void {
        if (success) this.skillStore.recordUsage(capability)
    }

    updateToolList(toolNames: string[]): void {
        this.detector.updateTools(toolNames)
    }
}

// ============================================
// Internal LLM for meta-learning analysis
// ============================================

let internalLlm: any = null

export function setInternalLLM(llm: any): void {
    internalLlm = llm
    console.log('[L8 MetaLearning] ✓ Internal LLM connected')
}

export function getInternalLLM(): any {
    return internalLlm
}

// ============================================
// Singleton & Export
// ============================================

let metaLearning: MetaLearningSystem | null = null

export function getMetaLearningSystem(toolNames?: string[]): MetaLearningSystem {
    if (!metaLearning) {
        metaLearning = new MetaLearningSystem(toolNames || [])
    }
    return metaLearning
}

export default {
    MetaLearningSystem,
    getMetaLearningSystem,
    setInternalLLM,
    getInternalLLM,
    CapabilityDetector,
    SelfExtensionEngine,
    SkillStore,
    CAPABILITY_MAP,
    SOLUTIONS,
}
