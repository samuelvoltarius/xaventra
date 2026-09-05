/**
 * Nova Browser Automation
 * 
 * Inspired by OpenClaw's browser/ (86 files, Playwright/CDP integration)
 * CDP connection, screenshot, navigation, content extraction, form interaction.
 */

import { execSync } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ============================================
// Types
// ============================================

export interface BrowserSession {
    id: string
    wsEndpoint: string
    connected: boolean
    startedAt: number
    lastAction: number
    pages: BrowserPage[]
}

export interface BrowserPage {
    id: string
    url: string
    title: string
    active: boolean
}

export interface ScreenshotOptions {
    fullPage?: boolean
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    clip?: { x: number; y: number; width: number; height: number }
    outputPath?: string
}

export interface NavigationResult {
    url: string
    title: string
    status: number
    loadTimeMs: number
}

export interface ContentExtractionResult {
    text: string
    html: string
    links: Array<{ text: string; href: string }>
    images: Array<{ alt: string; src: string }>
    metadata: Record<string, string>
}

export interface FormAction {
    type: 'click' | 'type' | 'select' | 'check' | 'uncheck'
    selector: string
    value?: string
}

// ============================================
// CDP Connection Management
// ============================================

const sessions = new Map<string, BrowserSession>()

export function createSession(wsEndpoint: string): BrowserSession {
    const id = `browser_${Date.now().toString(36)}`
    const session: BrowserSession = {
        id,
        wsEndpoint,
        connected: true,
        startedAt: Date.now(),
        lastAction: Date.now(),
        pages: [],
    }
    sessions.set(id, session)
    return session
}

export function getSession(sessionId: string): BrowserSession | undefined {
    return sessions.get(sessionId)
}

export function listSessions(): BrowserSession[] {
    return [...sessions.values()]
}

export function closeSession(sessionId: string): boolean {
    return sessions.delete(sessionId)
}

// ============================================
// Screenshot Capture (via Playwright CLI)
// ============================================

export function captureScreenshot(
    url: string,
    options: ScreenshotOptions = {},
): string {
    const outputDir = join(tmpdir(), 'nova-screenshots')
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })

    const filename = `screenshot-${Date.now()}.${options.format || 'png'}`
    const outputPath = options.outputPath || join(outputDir, filename)

    try {
        // Try Playwright
        const args = [
            `--browser=chromium`,
            `--save-screenshot=${outputPath}`,
            options.fullPage ? '--full-page' : '',
            `"${url}"`,
        ].filter(Boolean).join(' ')

        execSync(`npx playwright screenshot ${args}`, {
            timeout: 30_000,
            stdio: 'pipe',
        })
        return outputPath
    } catch {
        // Fallback: try puppeteer-based approach
        try {
            const script = `
                const puppeteer = require('puppeteer');
                (async () => {
                    const browser = await puppeteer.launch({ headless: 'new' });
                    const page = await browser.newPage();
                    await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 20000 });
                    await page.screenshot({ path: '${outputPath.replace(/\\/g, '\\\\')}', fullPage: ${options.fullPage || false} });
                    await browser.close();
                })();
            `
            execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
                timeout: 30_000,
                stdio: 'pipe',
            })
            return outputPath
        } catch {
            throw new Error(`Screenshot capture failed. Install Playwright: npm install playwright`)
        }
    }
}

// ============================================
// Page Content Extraction
// ============================================

export function extractContent(url: string): ContentExtractionResult {
    try {
        const script = `
const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto('${url}', { waitUntil: 'networkidle2', timeout: 20000 });
    const result = await page.evaluate(() => ({
        text: document.body?.innerText || '',
        html: document.body?.innerHTML || '',
        title: document.title,
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 50)
            .map(a => ({ text: a.textContent?.trim() || '', href: a.href })),
        images: Array.from(document.querySelectorAll('img')).slice(0, 20)
            .map(img => ({ alt: img.alt || '', src: img.src })),
        meta: Object.fromEntries(
            Array.from(document.querySelectorAll('meta[name],meta[property]'))
            .map(m => [m.getAttribute('name') || m.getAttribute('property'), m.getAttribute('content') || ''])
        ),
    }));
    console.log(JSON.stringify(result));
    await browser.close();
})();`

        const output = execSync(`node -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
            timeout: 30_000,
            encoding: 'utf-8',
        })
        const data = JSON.parse(output.trim())
        return {
            text: data.text || '',
            html: data.html || '',
            links: data.links || [],
            images: data.images || [],
            metadata: data.meta || {},
        }
    } catch {
        throw new Error(`Content extraction failed for ${url}`)
    }
}

// ============================================
// Simple HTTP Content Fetch (no browser)
// ============================================

export async function fetchPageContent(url: string): Promise<{
    text: string
    status: number
    headers: Record<string, string>
}> {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Nova/1.0 (Bot; +https://nova.local)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
    })
    const text = await response.text()
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => { headers[k] = v })

    return { text, status: response.status, headers }
}

// ============================================
// HTML → Text Extraction
// ============================================

export function htmlToText(html: string): string {
    return html
        // Remove scripts and styles
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        // Replace common block elements with newlines
        .replace(/<(br|hr|p|div|li|tr|h[1-6])[^>]*>/gi, '\n')
        // Remove all remaining tags
        .replace(/<[^>]+>/g, '')
        // Decode entities
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        // Clean up whitespace
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        .trim()
}

// ============================================
// Cookie & Storage Management
// ============================================

export interface BrowserCookie {
    name: string
    value: string
    domain: string
    path: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
}

const cookieStore = new Map<string, BrowserCookie[]>()

export function setCookies(domain: string, cookies: BrowserCookie[]): void {
    cookieStore.set(domain, cookies)
}

export function getCookies(domain: string): BrowserCookie[] {
    return cookieStore.get(domain) || []
}

export function clearCookies(domain?: string): void {
    if (domain) cookieStore.delete(domain)
    else cookieStore.clear()
}

// ============================================
// Profile Management
// ============================================

export interface BrowserProfile {
    name: string
    userAgent?: string
    viewport?: { width: number; height: number }
    locale?: string
    timezone?: string
    cookies?: BrowserCookie[]
}

const profiles = new Map<string, BrowserProfile>()

export function createProfile(profile: BrowserProfile): void {
    profiles.set(profile.name, profile)
}

export function getProfile(name: string): BrowserProfile | undefined {
    return profiles.get(name)
}

export function listProfiles(): BrowserProfile[] {
    return [...profiles.values()]
}

export function deleteProfile(name: string): boolean {
    return profiles.delete(name)
}

// Default profiles
createProfile({
    name: 'desktop',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
})

createProfile({
    name: 'mobile',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
})

createProfile({
    name: 'tablet',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 1024, height: 768 },
})
