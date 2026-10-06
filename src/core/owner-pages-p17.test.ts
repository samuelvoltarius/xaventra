/**
 * 2.86.1 Punkt 1 (Owner 06.10.: „(32 Seiten?)“): die Geräte-Antwort ist EINE
 * Nachricht, „Details“ höchstens eine kurze zweite (≤ 2 Seiten); das technische
 * Inventar nur auf ausdrückliche Nachfrage. Owner-Systemnachrichten haben in
 * Telegram nie mehr als 3 Seiten.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { environmentOverviewResponse, wantsTechnicalDetails } from './tool-evidence-response.js'
import { paginate } from './owner-text.js'
import { pagedView } from '../channels/telegram-pages.js'
import { createPlannerTelegramPort } from './planner-card-bridge.js'

const OWNER = [
    '🟡 Ich kenne 9 Geräte in deinem Netz — 2 warten aufs Verbinden.',
    '• Home Assistant — wartet aufs Verbinden',
    '• Tuya-Gerät — wartet aufs Verbinden',
    '• Hue Bridge — verbunden: ich sehe 4 Lampen',
    '• 3D-Drucker (Creality) — ich sehe seinen Fortschritt',
    '• Fernseher Wohnzimmer (TCL) — gefunden',
    '• TV-Stick (Xiaomi) — gefunden',
    '• Laptop von Beispiel — gefunden',
    '• MacBook Pro von Beispiel — gefunden',
    '• Router (Technicolor) — gefunden',
    'Verbinden: je ein Knopf in der Nachricht „Geräte gefunden“.',
].join('\n')
const DETAILS = ['So habe ich deine Geräte gefunden:', ...Array.from({ length: 9 }, (_, i) => `• Gerät ${i + 1}: 192.0.2.${10 + i} · meldet sich selbst im Netz · nur gefunden`), 'Mehr zu jedem Gerät steht in der App unter „Verbindungen“.'].join('\n')
/** The old giant inventory (node capabilities, work routes, connections, raw observations). */
const TECHNIK = Array.from({ length: 120 }, (_, i) => `Knoten nova-${i}: chat, tools, memory, MCP-Server ${i} (Werkzeugkatalog, Zugang, Freigabe), Arbeitsweg mesh_delegate, Rohbeobachtung Port ${8000 + i}`).join('\n')

const executions = [
    { toolName: 'environment_inventory', success: true, result: { owner: OWNER, details: DETAILS, formatted: TECHNIK } },
    { toolName: 'mesh_status', success: true, result: TECHNIK.slice(0, 4000) },
]

describe('2.86.1 Punkt 1: keine 32 Seiten', () => {
    it('Übersicht = eine Seite, „Details“ = höchstens zwei kurze Seiten, keine Technik', () => {
        const text = environmentOverviewResponse(executions)
        const pages = paginate(text)
        expect(pages.length).toBeLessThanOrEqual(3)
        expect(pages[0]).toBe(OWNER)
        expect(text).not.toMatch(/MCP|Knoten|Arbeitsweg|Rohbeobachtung|mesh_/)
        expect(text).toContain('So habe ich deine Geräte gefunden:')
    })

    it('das technische Inventar nur auf ausdrückliche Nachfrage', () => {
        expect(wantsTechnicalDetails('Welche smarten Geräte findest du?')).toBe(false)
        expect(wantsTechnicalDetails('Zeig mir die technischen Details zu den Geräten')).toBe(true)
        expect(environmentOverviewResponse(executions, { technisch: true })).toContain('Arbeitsweg mesh_delegate')
    })

    it('Telegram: die Geräte-Antwort hat höchstens 3 Seiten', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'p17-pages-'))
        const view = pagedView('1413797900', environmentOverviewResponse(executions), { dataDir })
        const mehr = view.keyboard.flat().map(button => button.text).find(label => label.startsWith('Mehr'))
        expect(mehr).toMatch(/\(1\/[1-3]\)/)
    })

    it('Owner-Systemnachrichten haben in Telegram nie mehr als 3 Seiten', async () => {
        const tg = { hasCardAuthority: vi.fn(async () => true), getOwnerChatIds: vi.fn(() => ['1413797900']), sendApprovalCard: vi.fn(async (_chat: string, _text: string, _keyboard: unknown) => 42) }
        await createPlannerTelegramPort(tg).deliver({ id: 'out-0000000000p17', kind: 'job', title: 'Nachtlauf', text: TECHNIK, createdAt: new Date().toISOString(), urgency: 'normal' } as any)
        const keyboard = tg.sendApprovalCard.mock.calls[0][2] as Array<Array<{ text: string }>>
        const mehr = keyboard.flat().map(button => button.text).find(label => label.startsWith('Mehr'))
        expect(mehr).toMatch(/\(1\/[1-3]\)/)
    })
})
