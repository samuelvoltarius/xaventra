/**
 * 2.89.2 Gesprächszusammenhang: the live failures of 08.10.2026 over the REAL entry
 * (Telegram -> daemon entry -> message-pipeline -> runNovaAgent). The model is the only fake
 * and records what it receives; every check reads that prompt, not an internal field.
 *
 *  - Photo + "Was ist das" -> "Was sagst du zu dem Foto ?" was answered "Ich sehe kein Foto".
 *  - Screenshot of all nodes -> "Was ist mit dem lab ?" ignored the screenshot.
 *  - Autonomy runs every 10 minutes ran next to the owner's turns.
 *  - A restart (config change) must not lose the last minutes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createE2EHarness, OWNER_TELEGRAM_ID, type E2EHarness, type HarnessOptions, type TurnResult } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })
async function harness(options: HarnessOptions = {}): Promise<E2EHarness> {
    h = await createE2EHarness(options)
    return h
}

const T = 60_000
const PHOTO = { data: Buffer.from('not-a-real-jpeg-but-bytes').toString('base64'), mimeType: 'image/jpeg' }

/** Everything the model was shown in the agent call of this turn, as one string. */
function prompt(result: TurnResult): string {
    const call = result.rounds[0]
    expect(call, 'the agent never called the model').toBeDefined()
    return call.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n---\n')
}

async function owner(e2e: E2EHarness, text: string, script: any[] = [], extra: Record<string, unknown> = {}): Promise<TurnResult> {
    return e2e.send('Telegram', OWNER_TELEGRAM_ID, text, script, { messageContext: { chatId: OWNER_TELEGRAM_ID }, ...extra })
}

describe('2.89.2 conversation continuity over the real entry', () => {
    it('(a) photo + "Was ist das" then "Was sagst du zu dem Foto ?": the second prompt knows the photo and the first answer', async () => {
        const e2e = await harness()
        const first = await owner(e2e, 'Was ist das', [{ text: 'Das ist der Wischernebel (NGC 6960), ein Supernova-Überrest im Schwan.' }], { image: PHOTO })
        expect(first.error).toBeUndefined()
        const second = await owner(e2e, 'Was sagst du zu dem Foto ?', [{ text: 'Es ist ein schönes Astrofoto.' }])
        expect(second.error).toBeUndefined()
        const seen = prompt(second)
        expect(seen).toContain('Bild angehängt')
        expect(seen).toContain('Wischernebel')
        expect(seen).toContain('Was ist das')
        // The picture is also a file (tools like plate solving need a path) and the history names it.
        const stored = seen.match(/Datei: ([^\s,)\]]+inbox-media[^\s,)\]]+)/)?.[1]
        expect(stored, seen.slice(-1500)).toBeDefined()
        expect(existsSync(stored!)).toBe(true)
        expect(readFileSync(stored!).toString()).toBe('not-a-real-jpeg-but-bytes')
        expect(prompt(first)).toContain('Das Bild dieser Nachricht liegt als Datei unter')
    }, T)

    it('(b) screenshot request then "Was ist mit dem lab ?": the prompt holds what the user received and the tool digest', async () => {
        const e2e = await harness()
        const first = await owner(e2e, 'Send mir einen Screenshot von allen nodes und Main', [
            { tool: 'mesh_screenshot', args: {} }, { text: 'Alle Bilder gesendet.' },
        ])
        expect(first.error).toBeUndefined()
        const received = first.final
        expect(received.length).toBeGreaterThan(10)
        const second = await owner(e2e, 'Was ist mit dem lab ?', [{ text: 'Zum lab liegt kein Bild vor.' }])
        const seen = prompt(second)
        expect(seen).toContain(received.slice(0, 60))
        expect(seen).not.toContain('Alle Bilder gesendet.')
        expect(seen).toContain('Werkzeuge: mesh_screenshot')
    }, T)

    // 2.89.2 (live 08.10.2026): the tool note of the history was copied by the model into the answer,
    // and "Was ist mit dem lab ?" after a screenshot of all nodes lost its reference.
    const meshSeed = (root: string) => {
        const beat = new Date().toISOString()
        const node = (id: string) => ({ node_id: id, hostname: id, platform: 'linux', version: '2.89.2', tools_count: 1, status: 'online', capabilities: [], last_heartbeat: beat })
        mkdirSync(join(root, '.nova-data'), { recursive: true })
        writeFileSync(join(root, '.nova-data', 'mesh.json'), JSON.stringify({ nodes: [node('lab'), node('xaventra-ns1')], tasks: [] }))
    }

    it('(f) screenshot of all nodes (lab: no capture) then "Was ist mit dem lab ?": the prompt names the lab result and says it refers to it', async () => {
        const e2e = await harness({ seed: meshSeed })
        const first = await owner(e2e, 'Send mir einen Screenshot von allen nodes und Main', [
            { tool: 'mesh_screenshot', args: { node_id: 'all' } }, { text: 'Alle Bilder gesendet.' },
        ])
        expect(first.error).toBeUndefined()
        expect(first.final).toMatch(/lab/)
        const second = await owner(e2e, 'Was ist mit dem lab ?', [{ text: 'Zum lab liegt kein Bild vor.' }])
        expect(second.error).toBeUndefined()
        const seen = prompt(second)
        expect(seen).toMatch(/Hinweis zum Gesprächszusammenhang/)
        expect(seen).toMatch(/sehr wahrscheinlich auf deine vorige Antwort/)
        const hint = second.rounds[0].messages.map(m => String(m.content)).find(c => c.startsWith('Hinweis zum Gesprächszusammenhang')) || ''
        expect(hint).toContain('lab')
        // The tool digest is context on the request side, never an assistant line that looks like answer text.
        const history = second.rounds[0].messages
        expect(history.filter(m => m.role === 'assistant').map(m => String(m.content)).join(' ')).not.toMatch(/Verlaufsnotiz|\(Kontext:/)
        expect(second.final).not.toMatch(/Verlaufsnotiz|nicht an den Nutzer gesendet|\(Kontext:/)
    }, T)

    it('(g) the model copies the internal note into its answer: the user never sees it', async () => {
        const e2e = await harness()
        await owner(e2e, 'Send mir einen Screenshot von allen nodes und Main', [{ tool: 'mesh_screenshot', args: {} }, { text: 'Alle Bilder gesendet.' }])
        const second = await owner(e2e, 'Was ist mit dem lab ?', [{ text: ['Zum lab liegt kein Bild vor.', '', '[Verlaufsnotiz, nicht an den Nutzer gesendet — Werkzeuge: mesh_screenshot fehlgeschlagen]', '(Kontext: zuvor ausgeführt — Werkzeuge: x)'].join('\n') }])
        expect(second.error).toBeUndefined()
        expect(second.replies.join(' ')).not.toMatch(/Verlaufsnotiz|nicht an den Nutzer gesendet|\(Kontext:/)
        expect(second.final).toContain('Zum lab liegt kein Bild vor.')
        const runner = await e2e.module('agents/nova-runner.js')
        const { resolvePrincipalId } = await e2e.module('users/principal-id.js')
        const ownerId = resolvePrincipalId(e2e.state.config, 'Telegram', OWNER_TELEGRAM_ID)
        expect(JSON.stringify(runner.getSession(ownerId, 'Telegram').history.at(-1))).not.toMatch(/Verlaufsnotiz/)
    }, T)

    it('(b2) an early deterministic answer (fast path, no agent run) is part of the next prompt', async () => {
        const e2e = await harness()
        const environment = await e2e.module('core/environment.js')
        environment.hasInternet({ force: true, run: () => { throw new Error('e2e harness: network closed') } })
        const first = await owner(e2e, 'hast du Internet?', [], { fallback: 'Ja, Internet geht.' })
        expect(first.rounds).toHaveLength(0)
        const second = await owner(e2e, 'und woran liegt das?', [{ text: 'Vermutlich an der Verbindung.' }])
        const seen = prompt(second)
        expect(seen).toContain('hast du Internet?')
        expect(seen).toContain(first.final.slice(0, 40))
    }, T)

    it('(c) a SELF-GOAL run between two owner turns neither enters nor changes the owner history', async () => {
        const e2e = await harness()
        await owner(e2e, 'Merke dir das Wort Kirschbaum', [{ text: 'Ich merke mir: Kirschbaum.' }])
        const runner = await e2e.module('agents/nova-runner.js')
        const { resolvePrincipalId } = await e2e.module('users/principal-id.js')
        const ownerId = resolvePrincipalId(e2e.state.config, 'Telegram', OWNER_TELEGRAM_ID)
        const before = JSON.stringify(runner.getSession(ownerId, 'Telegram').history)
        for (let i = 0; i < 3; i++) {
            const goal = await e2e.send('Telegram', 'Nova-Autonomy', `[SELF-GOAL] Nova führt eine selbst gesetzte Aufgabe aus: Ziel: Plattencheck ${i}`,
                [{ text: `Platte ${i} ist in Ordnung.` }], { execution: { systemAuthored: true } })
            expect(goal.error).toBeUndefined()
        }
        expect(JSON.stringify(runner.getSession(ownerId, 'Telegram').history)).toBe(before)
        expect(runner.getSession('Nova-Autonomy', 'Telegram').history.length).toBeGreaterThanOrEqual(2)
        const next = await owner(e2e, 'Welches Wort habe ich dir genannt?', [{ text: 'Kirschbaum.' }])
        const seen = prompt(next)
        expect(seen).toContain('Kirschbaum')
        expect(seen).not.toContain('Plattencheck')
        expect(e2e.state.lastActiveUserId).not.toBe('Nova-Autonomy')
    }, T)

    it('(d) after a restart the last exchanges are still in the prompt', async () => {
        const first = await harness({ keepRoot: true })
        const root = first.root
        await owner(first, 'Was ist das', [{ text: 'Das ist der Wischernebel im Sternbild Schwan.' }], { image: PHOTO })
        await first.close()
        h = undefined
        // New process: fresh module graph, same runtime root (checkpoints on disk).
        h = await createE2EHarness({ reuseRoot: root })
        const second = await owner(h, 'Was sagst du zu dem Foto ?', [{ text: 'Schön.' }])
        const seen = prompt(second)
        expect(seen).toContain('Bild angehängt')
        expect(seen).toContain('Wischernebel')
    }, T)

    it('(e) budget pressure: very long system sections are cut, the conversation stays', async () => {
        const e2e = await harness({
            seed: root => {
                const filler = Array.from({ length: 40 }, (_, i) => `## Hintergrund ${i}\n${'Lange Hintergrundzeile mit viel Text. '.repeat(40)}`).join('\n\n')
                writeFileSync(join(root, 'USER.md'), `# Nutzer\n\n${filler}\n`)
            },
        })
        await owner(e2e, 'Mein Lieblingsberg heisst Traunstein', [{ text: 'Der Traunstein, notiert.' }])
        const second = await owner(e2e, 'Wie hiess mein Lieblingsberg?', [{ text: 'Traunstein.' }])
        expect(second.logs.some(line => /Prompt budgets|systemPrompt too large/.test(line))).toBe(true)
        const seen = prompt(second)
        expect(seen).toContain('Mein Lieblingsberg heisst Traunstein')
        expect(seen).toContain('Der Traunstein, notiert.')
    }, T)
})
