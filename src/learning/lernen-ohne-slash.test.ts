import express from 'express'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProcedureStore, setProcedureStore } from './procedure-store.js'

vi.mock('../synthesis/self-evolution.js', () => ({ getPatchProposals: () => [], approveEvolutionProposal: vi.fn() }))

// 2.86 Punkt 9: „Was hast du gelernt?“ ohne Slash-Befehl. Fragen (nova_introspect),
// Desktop „Gedächtnis“ und das Telegram-Menü zeigen dieselbe, aktuelle Auskunft
// aus den echten Speichern — nicht aus stillgelegten Dateien.

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'lernen-ohne-slash-'))
const TOKEN = ['lernen-ohne-', 'slash-token-13579'].join('')
const OWNER = 'owner-1'
const RETIRED_MARKER = 'STILLGELEGTES-MUSTER-AUS-PATTERNS-JSON'

function procedure(userId: string, problem: string, toolName: string) {
    return { userId, problem, solution: `Tool ${toolName}: {"success":true,"output":"ok"}`, toolName, learnedAt: Date.now() - 60_000, successCount: 2, source: 'verifiziert', verified: true, uses: 3, failures: 1 }
}

function writeStores(userId: string) {
    mkdirSync(join(root, '.nova-data', 'learning'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'learning', 'procedures.json'), JSON.stringify({
        version: 1, updatedAt: new Date().toISOString(), signatures: [],
        procedures: [procedure(userId, 'Backup-Ordner auf example.com prüfen', 'read_file'), procedure(userId, 'Dienststatus des Webservers abfragen', 'health_status')],
    }))
    writeFileSync(join(root, '.nova-data', 'patterns.json'), JSON.stringify([{ pattern: RETIRED_MARKER, confidence: 1 }]))
    mkdirSync(join(root, '.nova-data', 'skills'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'skills', 'skills.json'), JSON.stringify([{ name: RETIRED_MARKER, description: 'alt' }]))
    setProcedureStore(null)
}

beforeAll(() => { vi.stubEnv('NOVA_RUNTIME_ROOT', root) })
afterAll(() => { vi.unstubAllEnvs(); setProcedureStore(null) })

describe('Selbstauskunft aus den echten Speichern', () => {
    beforeEach(() => writeStores(OWNER))

    it('nova_introspect(type=skills) nennt beide Prozeduren und liest keine stillgelegten Dateien', async () => {
        const { getToolRegistry } = await import('../tools/complete-registry.js')
        const output = String(await getToolRegistry().get('nova_introspect')!.handler({ type: 'skills', userId: OWNER }))
        expect(output).toContain('Backup-Ordner auf example.com prüfen')
        expect(output).toContain('Dienststatus des Webservers abfragen')
        expect(output).not.toContain(RETIRED_MARKER)
        expect(output).not.toMatch(/Learned Patterns|Tool Usage Examples/)
    }, 60_000)

    it('Prozeduren eines anderen Benutzers erscheinen nicht', async () => {
        const { selfIntrospect } = await import('../tools/self-introspect.js')
        const output = await selfIntrospect('skills', undefined, { userId: 'someone-else' })
        expect(output).not.toContain('Backup-Ordner auf example.com prüfen')
    })

    it('collectGedaechtnis enthält die Prozeduren mit Nummer und an/aus sowie den Lern-Puls', async () => {
        const { collectGedaechtnis } = await import('../desktop/desktop-views.js')
        const view: any = await collectGedaechtnis({ principalId: OWNER })
        expect(view.prozeduren).toHaveLength(2)
        expect(view.prozeduren[0]).toMatchObject({ nr: 1, problem: 'Backup-Ordner auf example.com prüfen', werkzeug: 'read_file', abrufe: 3, ok: 2, an: true })
        expect(view.prozeduren[0]).not.toHaveProperty('solution')
        expect(view).toHaveProperty('lernPuls')
    })
})

describe('Desktop: Prozedur an/aus über denselben Owner-Schalter', () => {
    async function withServer(run: (base: string) => Promise<void>) {
        const { registerDesktopApi } = await import('../desktop/desktop-api.js')
        const app = express(); app.use(express.json()); registerDesktopApi(app, () => null)
        const server = app.listen(0, '127.0.0.1')
        await new Promise<void>(resolve => server.once('listening', resolve))
        try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/desktop`) } finally {
            server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    it('Owner schaltet Prozedur 1 aus, die Ansicht zeigt sie aus; ohne Owner 403', async () => {
        const { desktopExecutionPrincipal } = await import('../desktop/desktop-api.js')
        const ownerPrincipal = desktopExecutionPrincipal('desktop-owner')
        writeStores(ownerPrincipal)
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', TOKEN)
        vi.stubEnv('NOVA_DESKTOP_OWNER_ID', 'desktop-owner')
        await withServer(async base => {
            const owner = { authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
            const denied = await fetch(`${base}/prozeduren/1`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer wrong-token-wrong-token-1' }, body: JSON.stringify({ an: false }) })
            expect([401, 403]).toContain(denied.status)
            const off = await fetch(`${base}/prozeduren/1`, { method: 'POST', headers: owner, body: JSON.stringify({ an: false }) })
            expect(off.status).toBe(200)
            expect((await off.json()).message).toMatch(/ist aus/)
            expect(getProcedureStore().list(ownerPrincipal)[0].disabledByOwner).toBe(true)
            const view = await (await fetch(`${base}/gedaechtnis`, { headers: owner })).json()
            expect(view.prozeduren[0]).toMatchObject({ nr: 1, an: false })
            const missing = await fetch(`${base}/prozeduren/9`, { method: 'POST', headers: owner, body: JSON.stringify({ an: true }) })
            expect(missing.status).toBe(404)
        })
        vi.stubEnv('NOVA_DESKTOP_API_TOKEN', '')
    })
})

describe('Telegram-Menü aus einer Liste', () => {
    const slash = readFileSync(src('../core/slash-commands.ts'), 'utf8')
    const telegram = readFileSync(src('../channels/telegram.ts'), 'utf8')
    const handlers = new Set([...slash.matchAll(/^\s+case '([^']+)'/gm)].map(match => match[1]))

    it('die Liste enthält die fehlenden Owner-Befehle und jeder Eintrag hat einen Handler', async () => {
        const { COMMAND_MENU } = await import('../core/slash-commands.js')
        const commands = COMMAND_MENU.map(entry => entry.command)
        for (const needed of ['prozeduren', 'arbeit', 'waechter', 'geraete']) expect(commands).toContain(needed)
        for (const command of commands) {
            expect(handlers.has(command), `/${command} ohne Handler`).toBe(true)
            expect(command).toMatch(/^[a-z0-9_]{1,32}$/)
        }
        expect(new Set(commands).size).toBe(commands.length)
    })

    it('Telegram tippt keine eigene Liste mehr, sondern nimmt die eine', () => {
        expect(telegram).not.toMatch(/\{ command: '/)
        expect(telegram).toMatch(/setMyCommands\(COMMAND_MENU\.map/)
        expect(telegram).toMatch(/formatCommandMenu\(\)/)
    })

    it('Befehle, auf die Lern-Antworten verweisen, stehen im Menü', async () => {
        const { COMMAND_MENU, formatCommandMenu } = await import('../core/slash-commands.js')
        const commands = new Set(COMMAND_MENU.map(entry => entry.command))
        const block = (from: string) => { const start = slash.indexOf(from); return slash.slice(start, slash.indexOf("\n        case '", start + from.length)) }
        const referenced = [...`${block("case 'skills': {")}${block("case 'gelernt': {")}`.matchAll(/[\s(]\/([a-zäöü]+)\b(?![./-])/g)]
            .map(match => match[1]).filter(name => handlers.has(name))
        expect(referenced).toEqual(expect.arrayContaining(['prozeduren', 'werkzeuge', 'entscheidungen']))
        for (const name of referenced) expect(commands.has(name), `/${name} wird genannt, fehlt im Menü`).toBe(true)
        const help = formatCommandMenu()
        for (const command of commands) expect(help).toContain(`/${command}`)
    })
})
