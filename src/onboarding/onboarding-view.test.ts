import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { UI_FILES } from '../dashboard/server.js'
import { DASHBOARD_UI_FILES } from '../dev/copy-dashboard-assets.js'

const renderer = (name: string) => readFileSync(fileURLToPath(new URL(`../../desktop/renderer/${name}`, import.meta.url)), 'utf8')

function loadView(claim?: () => Promise<{ claimed: boolean }>) {
    const window: any = { novaDesktop: claim ? { onboarding: { claim } } : {} }
    const document = { activeElement: null, querySelector: () => null }
    vm.runInNewContext(renderer('onboarding.js'), { window, document, setTimeout: () => 0, clearTimeout: () => undefined, console, FormData: class {}, Date, JSON, String })
    return window.XaventraOnboarding
}
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
function ctxWith(data: unknown) {
    const ctx = {
        api: { get: vi.fn(async () => data), post: vi.fn(async () => ({})) },
        esc, attr: esc, icon: (name: string) => `[${name}]`, toast: vi.fn(), fail: vi.fn(), errorText: (e: unknown) => String(e), navigate: vi.fn(),
        isActive: () => true, rerender: vi.fn(),
    }
    return ctx
}
const summary = (telegram: Record<string, unknown> = {}) => ({
    firstStart: true, state: 'pending', ownerName: null,
    doctor: { running: false, report: { items: [
        { step: 'hardware', status: 'ok', text: 'Rechner erkannt: linux/x64' },
        { step: 'modell', status: 'vorgeschlagen', text: 'Vorschlag: qwen3', proposalId: 'iq-000000000001' },
    ] } },
    telegram: { configured: false, running: false, botUsername: null, paired: false, pairedWith: null, pairingPending: false, restartNeeded: false, ...telegram },
    connections: { available: false, gefunden: 0, verbunden: 0, beispiele: [], view: 'verbindungen' },
    questions: [{ id: 'name', done: false }, { id: 'telegram', done: false }, { id: 'verbindungen', done: false, available: false }],
})

describe('Desktop-Ansicht „Erster Start“ (2.85 Paket B, Punkt 3)', () => {
    it('is shipped with the one UI (Electron and browser) and loaded before app.js', () => {
        const html = renderer('index.html')
        expect(html.indexOf('onboarding.js')).toBeGreaterThan(0)
        expect(html.indexOf('onboarding.js')).toBeLessThan(html.indexOf('app.js'))
        expect(Object.keys(UI_FILES)).toContain('onboarding.js')
        expect(DASHBOARD_UI_FILES).toContain('onboarding.js')
        expect(renderer('app.js')).toContain("if (section === 'start')")
    })

    it('shows the report and at most three questions; Telegram starts with BotFather and a hidden token field', async () => {
        const view = loadView()
        const ctx = ctxWith(summary())
        view.page(ctx)
        await new Promise(resolve => setImmediate(resolve))
        const html: string = view.page(ctx)
        expect(html).toContain('Was ich getan habe')
        expect(html).toContain('Vorschlag: qwen3')
        expect(html).toContain('data-section="heute"')
        expect(html.match(/<section class="section">/g)).toHaveLength(4)
        expect(html).toContain('https://t.me/BotFather')
        expect(html).toMatch(/name="token" type="password" autocomplete="off"/)
        expect(html).toContain('Die Ansicht „Verbindungen“ kommt')
    })

    it('once a bot exists it is one button, then a QR code and a link; paired shows who', async () => {
        const view = loadView()
        const configured = ctxWith(summary({ configured: true, running: true, botUsername: 'example_bot' }))
        view.page(configured); await new Promise(resolve => setImmediate(resolve))
        expect(view.page(configured)).toContain('data-onboarding="pair"')
        const paired = loadView()
        const ctx = ctxWith(summary({ configured: true, paired: true, pairedWith: '@example' }))
        paired.page(ctx); await new Promise(resolve => setImmediate(resolve))
        expect(paired.page(ctx)).toContain('Gekoppelt mit @example')
    })

    it('connections only link to the view of package A', async () => {
        const view = loadView()
        const data = { ...summary(), connections: { available: true, gefunden: 2, verbunden: 0, beispiele: ['Home Assistant', 'Drucker'], view: 'verbindungen' } }
        const ctx = ctxWith(data)
        view.page(ctx); await new Promise(resolve => setImmediate(resolve))
        const html: string = view.page(ctx)
        expect(html).toContain('2 Dienste gefunden: Home Assistant, Drucker')
        expect(html).toContain('data-section="verbindungen"')
    })

    it('asks the main process to claim the owner token only after an auth error and without a stored token', async () => {
        const claim = vi.fn(async () => ({ claimed: true }))
        const view = loadView(claim)
        expect(await view.tryClaim(new Error('Der Main ist nicht erreichbar'), { hasToken: false })).toBe(false)
        expect(await view.tryClaim(new Error('Desktop authentication required'), { hasToken: true })).toBe(false)
        expect(claim).not.toHaveBeenCalled()
        expect(await view.tryClaim(new Error('Desktop authentication required'), { hasToken: false })).toBe(true)
        expect(await loadView().tryClaim(new Error('Desktop authentication required'), { hasToken: false })).toBe(false)
    })
})
