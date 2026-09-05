import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const desktopRoot = join(root, 'desktop')
const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
const executablePath = desktopRequire('electron')
const artifactRoot = resolve(process.env.NOVA_DESKTOP_QA_DIR || join(tmpdir(), 'nova-desktop-qa'))
mkdirSync(artifactRoot, { recursive: true })

const app = await electron.launch({ executablePath, args: [desktopRoot], cwd: desktopRoot })
try {
    const page = await app.firstWindow()
    await page.waitForSelector('.shell', { timeout: 20_000 })

    const initial = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight,
        documentScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        documentScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        workspace: (() => { const box = document.querySelector('.workspace')?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : null })(),
        navLabels: [...document.querySelectorAll('.nav-label')].map(node => node.textContent?.trim()),
        workspaceBar: Boolean(document.querySelector('.workspace-context-bar')),
        modelValues: [...document.querySelectorAll('#model-picker option')].map(node => node.value),
    }))
    if (initial.documentScrollX || initial.documentScrollY) throw new Error(`Desktop shell unexpectedly scrolls: ${JSON.stringify(initial)}`)
    if (!initial.workspace || initial.workspace.bottom > initial.height + 1 || initial.workspace.right > initial.width + 1) throw new Error(`Workspace is clipped: ${JSON.stringify(initial)}`)
    if (!['Arbeitsraum', 'Agenten', 'Infrastruktur', 'Studio', 'Defense', 'Evidence', 'Gedächtnis', 'Setup'].every(label => initial.navLabels.includes(label))) throw new Error(`Navigation labels are incomplete: ${JSON.stringify(initial.navLabels)}`)
    if (!initial.workspaceBar) throw new Error('Local workspace context bar is missing')
    if (new Set(initial.modelValues).size !== initial.modelValues.length || initial.modelValues.some(value => !value)) throw new Error(`Model route values are not unique: ${JSON.stringify(initial.modelValues)}`)

    await page.click('[data-section="settings"]')
    await page.waitForSelector('.settings-grid')
    const settings = await page.evaluate(() => ({
        cards: document.querySelectorAll('.settings-card').length,
        labels: [...document.querySelectorAll('.settings-card .eyebrow')].map(node => node.textContent?.trim()),
        canScroll: (document.querySelector('.view')?.scrollHeight || 0) > (document.querySelector('.view')?.clientHeight || 0),
    }))
    if (settings.cards !== 6) throw new Error(`Expected six settings groups, received ${settings.cards}`)
    if (!settings.labels.some(label => label?.includes('Workspace'))) throw new Error(`Workspace settings group is missing: ${JSON.stringify(settings.labels)}`)
    await page.screenshot({ path: join(artifactRoot, 'settings.jpg'), type: 'jpeg', quality: 85 })

    await page.click('[data-section="chat"]')
    await page.waitForSelector('.messages')
    const scroll = await page.evaluate(() => {
        const box = document.querySelector('.messages')
        if (!box) return null
        box.scrollTop = 0
        const before = box.scrollTop
        box.scrollTop = Math.min(box.scrollHeight, 240)
        return { before, after: box.scrollTop, clientHeight: box.clientHeight, scrollHeight: box.scrollHeight, overflowY: getComputedStyle(box).overflowY }
    })
    if (!scroll || scroll.overflowY !== 'auto' || scroll.clientHeight <= 0) throw new Error(`Message pane is not independently scrollable: ${JSON.stringify(scroll)}`)
    if (scroll.scrollHeight > scroll.clientHeight && scroll.after <= scroll.before) throw new Error(`Message pane refused to scroll: ${JSON.stringify(scroll)}`)

    const capture = await page.evaluate(() => window.novaDesktop.desktop.capture())
    if (capture?.kind !== 'screen_capture' || capture?.mimeType !== 'image/jpeg' || !capture?.base64 || capture.base64.length > 180_000) {
        throw new Error('Typed desktop capture bridge returned an invalid payload')
    }
    await page.screenshot({ path: join(artifactRoot, 'chat.jpg'), type: 'jpeg', quality: 85 })

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1120, 720))
    await page.waitForTimeout(300)
    const minimum = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight,
        documentScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        documentScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        messagesHeight: document.querySelector('.messages')?.clientHeight || 0,
        composerBottom: document.querySelector('.composer')?.getBoundingClientRect().bottom || 0,
    }))
    if (minimum.documentScrollX || minimum.documentScrollY || minimum.messagesHeight <= 0 || minimum.composerBottom > minimum.height + 1) {
        throw new Error(`Minimum viewport is clipped: ${JSON.stringify(minimum)}`)
    }
    await page.screenshot({ path: join(artifactRoot, 'minimum-window.jpg'), type: 'jpeg', quality: 85 })

    console.log(JSON.stringify({ ok: true, artifactRoot, initial, settings, scroll, minimum, captureBytes: Math.floor(capture.base64.length * 0.75) }, null, 2))
} finally {
    await app.close().catch(() => {})
}
