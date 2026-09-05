/**
 * Nova - Browser Adapter
 * 
 * Web browsing and automation using Playwright.
 * Enables Nova to:
 * - Browse websites
 * - Take screenshots
 * - Extract content
 * - Fill forms
 * - Interact with web pages
 * 
 * Install: npm install playwright && npx playwright install chromium
 */

// ============================================
// Types
// ============================================

export interface BrowserConfig {
    headless: boolean
    timeout: number
    viewport: { width: number; height: number }
    userAgent?: string
    screenshotDir: string
    storageStatePath?: string
    downloadDir?: string
}

export interface PageContent {
    url: string
    title: string
    text: string
    links: Array<{ text: string; href: string }>
    images: Array<{ alt: string; src: string }>
}

export interface ScreenshotResult {
    path: string
    timestamp: number
}

// ============================================
// Default Config
// ============================================

const DEFAULT_CONFIG: BrowserConfig = {
    headless: true,
    timeout: 30000,
    viewport: { width: 1280, height: 720 },
    screenshotDir: '.nova-screenshots',
}

// ============================================
// Browser Adapter
// ============================================

export class BrowserAdapter {
    private config: BrowserConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private browser: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private context: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private page: any = null

    constructor(config: Partial<BrowserConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    // ============================================
    // Lifecycle
    // ============================================

    /** Gesetzt, wenn nur ein Systembrowser geoeffnet wurde (ohne Fernsteuerung). */
    private nurSichtbarGestartet?: string

    async launch(): Promise<void> {
        try {
            const { chromium } = await import('playwright')

            // In NovaOS sitzt ein Mensch vor dem Bildschirm. Ein unsichtbar
            // gestarteter Browser fuehrt genau zu dem Dialog, den es hier
            // wirklich gab: Nova meldet "Google ist auf", der Mensch sagt
            // "ich sehe es nicht", und Nova erklaert, sie laufe headless.
            // Ist ein Bildschirm da, wird sichtbar gestartet.
            const sichtbarMoeglich = process.env.NOVA_OS_MODE === 'true' && Boolean(process.env.DISPLAY)
            const headless = process.env.NOVA_BROWSER_HEADLESS === '1'
                ? true
                : (sichtbarMoeglich ? false : this.config.headless)

            // Playwright bringt seinen EIGENEN Chromium mit, der extra
            // heruntergeladen werden muss. In NovaOS ist der nicht dabei —
            // dafuer steht oft ein ganz normaler Browser im System, den der
            // Mensch ohnehin sehen soll. Also erst danach suchen und ihn
            // benutzen; Playwright steuert ihn dann ueber `channel`.
            // Ohne das meldete Nova "Browser launch failed. Run: npm install
            // playwright ..." — obwohl ein funktionierender Firefox
            // installiert war. Am 30.08.2026 am laufenden System gesehen.
            const systemBrowser = (): string | undefined => {
                if (process.env.NOVA_OS_MODE !== 'true') return undefined
                const { existsSync: da } = require('node:fs') as typeof import('node:fs')
                for (const [pfad, kanal] of [
                    ['/usr/bin/chromium', 'chromium'],
                    ['/usr/bin/chromium-browser', 'chromium'],
                    ['/usr/bin/google-chrome', 'chrome'],
                    ['/snap/bin/chromium', 'chromium'],
                ] as const) {
                    // Die Ubuntu-Huelle chromium-browser verlangt snap und
                    // funktioniert nicht — sie hat kaum Inhalt.
                    try {
                        if (da(pfad) && (require('node:fs') as typeof import('node:fs')).statSync(pfad).size > 100_000) return kanal
                    } catch { /* weiter */ }
                }
                return undefined
            }

            const kanal = systemBrowser()
            this.browser = await chromium.launch({
                headless,
                ...(kanal ? { channel: kanal } : {}),
                args: headless ? [] : ['--no-sandbox', '--start-maximized'],
            })

            const { existsSync, mkdirSync } = await import('node:fs')
            if (this.config.storageStatePath) mkdirSync((await import('node:path')).dirname(this.config.storageStatePath), { recursive: true })
            const context = await this.browser.newContext({
                viewport: this.config.viewport,
                userAgent: this.config.userAgent,
                acceptDownloads: true,
                storageState: this.config.storageStatePath && existsSync(this.config.storageStatePath)
                    ? this.config.storageStatePath : undefined,
            })
            this.context = context
            this.page = await context.newPage()
            console.log('[Browser] Launched')
        } catch (err) {
            // Letzter Ausweg in NovaOS: einfach den Browser aufmachen, den
            // das System hat. Nova kann ihn dann zwar nicht fernsteuern, aber
            // der Mensch sieht die Seite — und darum ging es ihm.
            if (process.env.NOVA_OS_MODE === 'true' && process.env.DISPLAY) {
                const { execFileSync } = await import('node:child_process')
                const { existsSync } = await import('node:fs')
                for (const kandidat of ['/usr/bin/firefox', '/snap/bin/firefox',
                                        '/usr/bin/epiphany-browser', '/usr/bin/chromium',
                                        '/usr/bin/xdg-open']) {
                    if (!existsSync(kandidat)) continue
                    try {
                        execFileSync('setsid', [kandidat, 'https://www.google.com'], {
                            env: { ...process.env, DISPLAY: process.env.DISPLAY },
                            stdio: 'ignore', timeout: 8000,
                        })
                        this.nurSichtbarGestartet = kandidat
                        console.log(`[Browser] Ohne Fernsteuerung geoeffnet: ${kandidat}`)
                        return
                    } catch { /* naechster Kandidat */ }
                }
            }
            throw new Error(`Browser launch failed. Run: npm install playwright && npx playwright install chromium`)
        }
    }

    async close(): Promise<void> {
        if (this.context && this.config.storageStatePath) {
            await this.context.storageState({ path: this.config.storageStatePath }).catch(() => undefined)
        }
        if (this.browser) {
            await this.browser.close()
            this.browser = null
            this.context = null
            this.page = null
            console.log('[Browser] Closed')
        }
    }

    isRunning(): boolean {
        return this.browser !== null
    }

    // ============================================
    // Navigation
    // ============================================

    async goto(url: string): Promise<PageContent> {
        this.ensurePage()
        console.log(`[Browser] → ${url}`)

        await this.page.goto(url, {
            timeout: this.config.timeout,
            waitUntil: 'domcontentloaded',
        })

        return this.getContent()
    }

    async back(): Promise<void> {
        this.ensurePage()
        await this.page.goBack()
    }

    async forward(): Promise<void> {
        this.ensurePage()
        await this.page.goForward()
    }

    async reload(): Promise<void> {
        this.ensurePage()
        await this.page.reload()
    }

    // ============================================
    // Content Extraction
    // ============================================

    async getContent(): Promise<PageContent> {
        this.ensurePage()

        const title = await this.page.title()
        const url = this.page.url()

        // Extract text using locators
        const text = await this.page.locator('body').innerText()

        // Extract links
        const linkElements = await this.page.locator('a[href]').all()
        const links: Array<{ text: string; href: string }> = []
        for (const el of linkElements.slice(0, 50)) {
            const text = await el.innerText().catch(() => '')
            const href = await el.getAttribute('href') || ''
            if (href) links.push({ text: text.trim(), href })
        }

        // Extract images
        const imgElements = await this.page.locator('img[src]').all()
        const images: Array<{ alt: string; src: string }> = []
        for (const el of imgElements.slice(0, 20)) {
            const alt = await el.getAttribute('alt') || ''
            const src = await el.getAttribute('src') || ''
            if (src) images.push({ alt, src })
        }

        return {
            url,
            title,
            text: text.slice(0, 10000),
            links,
            images,
        }
    }

    async getText(selector?: string): Promise<string> {
        this.ensurePage()

        if (selector) {
            return this.page.locator(selector).innerText()
        }
        return this.page.locator('body').innerText()
    }

    // ============================================
    // Interactions
    // ============================================

    async click(selector: string): Promise<void> {
        this.ensurePage()
        console.log(`[Browser] Click: ${selector}`)
        await this.page.locator(selector).click()
    }

    async type(selector: string, text: string): Promise<void> {
        this.ensurePage()
        console.log(`[Browser] Type: ${selector}`)
        await this.page.locator(selector).fill(text)
    }

    async press(key: string): Promise<void> {
        this.ensurePage()
        await this.page.keyboard.press(key)
    }

    async scroll(direction: 'up' | 'down', pixels = 500): Promise<void> {
        this.ensurePage()
        const delta = direction === 'down' ? pixels : -pixels
        await this.page.mouse.wheel(0, delta)
    }

    async waitFor(selector: string, timeout?: number): Promise<void> {
        this.ensurePage()
        await this.page.locator(selector).waitFor({
            timeout: timeout || this.config.timeout,
        })
    }

    async newTab(url?: string): Promise<{ index: number; url: string; title: string }> {
        this.ensurePage()
        const page = await this.context.newPage()
        if (url) await page.goto(url, { timeout: this.config.timeout, waitUntil: 'domcontentloaded' })
        this.page = page
        const pages = this.context.pages()
        return { index: pages.indexOf(page), url: page.url(), title: await page.title() }
    }

    async listTabs(): Promise<Array<{ index: number; active: boolean; url: string; title: string }>> {
        this.ensurePage()
        return Promise.all(this.context.pages().map(async (page: any, index: number) => ({
            index,
            active: page === this.page,
            url: page.url(),
            title: await page.title().catch(() => ''),
        })))
    }

    async switchTab(index: number): Promise<PageContent> {
        this.ensurePage()
        const page = this.context.pages()[index]
        if (!page) throw new Error(`Browser tab not found: ${index}`)
        this.page = page
        await page.bringToFront()
        return this.getContent()
    }

    async closeTab(index: number): Promise<void> {
        this.ensurePage()
        const pages = this.context.pages()
        const page = pages[index]
        if (!page) throw new Error(`Browser tab not found: ${index}`)
        await page.close()
        const remaining = this.context.pages()
        this.page = remaining[Math.min(index, remaining.length - 1)] || await this.context.newPage()
    }

    async upload(selector: string, paths: string[]): Promise<void> {
        this.ensurePage()
        if (!paths.length) throw new Error('At least one upload path is required')
        await this.page.locator(selector).setInputFiles(paths)
    }

    async clickAndDownload(selector: string, targetDir?: string): Promise<{ path: string; suggestedFilename: string }> {
        this.ensurePage()
        const { mkdirSync } = await import('node:fs')
        const { join } = await import('node:path')
        const directory = targetDir || this.config.downloadDir || join(process.cwd(), '.nova-downloads')
        mkdirSync(directory, { recursive: true })
        const downloadPromise = this.page.waitForEvent('download', { timeout: this.config.timeout })
        await this.page.locator(selector).click()
        const download = await downloadPromise
        const suggestedFilename = download.suggestedFilename()
        const path = join(directory, `${Date.now()}-${suggestedFilename}`)
        await download.saveAs(path)
        return { path, suggestedFilename }
    }

    async getInteractiveElements(limit = 100): Promise<Array<{ index: number; role: string; name: string; selector: string }>> {
        this.ensurePage()
        return this.page.locator('a,button,input,textarea,select,[role="button"],[tabindex]').evaluateAll((elements: any[], max: number) =>
            elements.slice(0, max).map((element, index) => ({
                index,
                role: element.getAttribute('role') || element.tagName.toLowerCase(),
                name: (element.getAttribute('aria-label') || element.getAttribute('name') || element.textContent || '').trim().slice(0, 160),
                selector: element.id
                    ? `#${String(element.id).replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`
                    : `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
            })), limit)
    }

    // ============================================
    // Screenshots
    // ============================================

    async screenshot(name?: string): Promise<ScreenshotResult> {
        this.ensurePage()

        const { mkdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')

        if (!existsSync(this.config.screenshotDir)) {
            mkdirSync(this.config.screenshotDir, { recursive: true })
        }

        const timestamp = Date.now()
        const filename = name || `screenshot-${timestamp}.png`
        const filepath = join(this.config.screenshotDir, filename)

        await this.page.screenshot({ path: filepath })
        console.log(`[Browser] Screenshot: ${filepath}`)

        return { path: filepath, timestamp }
    }

    async screenshotFullPage(name?: string): Promise<ScreenshotResult> {
        this.ensurePage()

        const { mkdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')

        if (!existsSync(this.config.screenshotDir)) {
            mkdirSync(this.config.screenshotDir, { recursive: true })
        }

        const timestamp = Date.now()
        const filename = name || `fullpage-${timestamp}.png`
        const filepath = join(this.config.screenshotDir, filename)

        await this.page.screenshot({ path: filepath, fullPage: true })
        console.log(`[Browser] Full page screenshot: ${filepath}`)

        return { path: filepath, timestamp }
    }

    async screenshotElement(selector: string, name?: string): Promise<ScreenshotResult> {
        this.ensurePage()

        const { mkdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')

        if (!existsSync(this.config.screenshotDir)) {
            mkdirSync(this.config.screenshotDir, { recursive: true })
        }

        const timestamp = Date.now()
        const filename = name || `element-${timestamp}.png`
        const filepath = join(this.config.screenshotDir, filename)

        await this.page.locator(selector).screenshot({ path: filepath })
        console.log(`[Browser] Element screenshot: ${filepath}`)

        return { path: filepath, timestamp }
    }

    // ============================================
    // PDF
    // ============================================

    async pdf(name?: string): Promise<string> {
        this.ensurePage()

        const { mkdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')

        if (!existsSync(this.config.screenshotDir)) {
            mkdirSync(this.config.screenshotDir, { recursive: true })
        }

        const filename = name || `page-${Date.now()}.pdf`
        const filepath = join(this.config.screenshotDir, filename)

        await this.page.pdf({ path: filepath, format: 'A4' })
        console.log(`[Browser] PDF: ${filepath}`)

        return filepath
    }

    // ============================================
    // Form Helpers
    // ============================================

    async fillForm(fields: Record<string, string>): Promise<void> {
        for (const [selector, value] of Object.entries(fields)) {
            await this.type(selector, value)
        }
    }

    async select(selector: string, value: string): Promise<void> {
        this.ensurePage()
        await this.page.locator(selector).selectOption(value)
    }

    async check(selector: string): Promise<void> {
        this.ensurePage()
        await this.page.locator(selector).check()
    }

    async uncheck(selector: string): Promise<void> {
        this.ensurePage()
        await this.page.locator(selector).uncheck()
    }

    // ============================================
    // Utilities
    // ============================================

    async wait(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms))
    }

    getCurrentUrl(): string {
        this.ensurePage()
        return this.page.url()
    }

    private ensurePage(): void {
        if (!this.page) {
            throw new Error('Browser not launched. Call launch() first.')
        }
    }
}

// ============================================
// Factory
// ============================================

let browserInstance: BrowserAdapter | null = null

/**
 * Get or create a browser adapter (synchronous - caller must call launch())
 */
export function getBrowser(config?: Partial<BrowserConfig>): BrowserAdapter {
    if (!browserInstance) {
        browserInstance = new BrowserAdapter(config)
    }
    return browserInstance
}

/**
 * Get or create AND launch browser (async singleton)
 */
export async function getOrCreateBrowser(config?: Partial<BrowserConfig>): Promise<BrowserAdapter> {
    if (!browserInstance) {
        browserInstance = new BrowserAdapter(config)
        await browserInstance.launch()
    }
    return browserInstance
}

export function createBrowser(config?: Partial<BrowserConfig>): BrowserAdapter {
    return new BrowserAdapter(config)
}

export default { BrowserAdapter, getBrowser, getOrCreateBrowser, createBrowser }
