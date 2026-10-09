/**
 * 2.89 Paket D — Wächter: every exit of message-pipeline.ts BEFORE the agent (each
 * early `return` of handleMessageInScope up to `traceStep('context:complete')`) is
 * one gate. Each gate here has
 *   - an anchor in the source (its early return is the first bare `return` on or after it,
 *     `if (…) return` included),
 *   - a marker (trace step, log line or reply) and
 *   - a scenario over the REAL daemon entry that runs through it.
 * A new early exit without an entry in GATES fails the static check: no new gate may
 * reach production without a live-path scenario („grün im Test, tot im Betrieb").
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    createE2EHarness, OWNER_TELEGRAM_ID, STRANGER_TELEGRAM_ID,
    type E2EHarness, type HarnessOptions, type TurnResult,
} from '../../test/helpers/e2e-harness.js'

interface Gate {
    id: string
    /** Unique source text; the gate's early return is the first bare `return` after it. */
    anchor: string
    marker: { trace?: string; log?: RegExp; reply?: RegExp }
    options?: HarnessOptions
    run: (h: E2EHarness) => Promise<TurnResult>
    /** Set when the gate is unreachable on 2.88.3 (dead path) — which package/decision fixes it. */
    dead?: string
}

const owner = (h: E2EHarness, text: string, script: any[] = []) => h.telegram(text, script)

export const GATES: Gate[] = [
    {
        id: 'entity-overflow', anchor: "await replyFn('Die Nachrichtenfolge ist zu lang.",
        marker: { reply: /Nachrichtenfolge ist zu lang/ },
        run: h => owner(h, '/__entity_overflow__'),
    },
    {
        id: 'entity-clarification', anchor: 'await answer(entityTurn.question)',
        marker: { reply: /Welches Wesen oder Objekt/ },
        run: h => owner(h, 'Er ist blau.'),
    },
    {
        id: 'login-return', anchor: 'await replyFn(owner ? await handlePastedLoginReturn(address)',
        marker: { log: /Anmelde-Rückkehr eingefügt/ },
        run: h => owner(h, `fertig: https://xaventra.example.com/verbindungen/rueckkehr?state=${'a'.repeat(48)}&code=abc123`),
    },
    {
        // 2.89.4: keys from chat (owner DM) never reach the model; the branch owns the message.
        id: 'chat-key-intake', anchor: 'Schlüssel aus dem Chat übernommen (Owner-DM, Wert maskiert)',
        marker: { log: /Schlüssel aus dem Chat übernommen/ },
        run: h => owner(h, `Hier der Home Assistant API Key: ${'x'.repeat(32)} — nimm den und trag ihn ein`),
    },
    {
        id: 'auth-blocked', anchor: "await replyFn(authResult.reason || '🔒 Zugriff verweigert.')",
        marker: { log: /\[MultiUser\] ❌ Blocked/ },
        run: async h => {
            const mu = await h.module('users/multi-user-middleware.js')
            mu.getOrCreateUser(STRANGER_TELEGRAM_ID, 'Telegram')
            mu.setUserPermission(STRANGER_TELEGRAM_ID, 'blocked')
            return h.telegram('Hallo, wie geht es dir?', [], { from: STRANGER_TELEGRAM_ID })
        },
    },
    {
        id: 'coalesced', anchor: 'if (mu.isCoalescedMarker?.(content)) {',
        marker: { log: /zusammengeführt — beendet/ },
        run: async h => {
            await owner(h, 'Wer bist du?')
            return h.burst([
                { channel: 'Telegram', from: OWNER_TELEGRAM_ID, text: 'Ich hätte noch eine Frage', messageContext: { chatId: OWNER_TELEGRAM_ID } },
                { channel: 'Telegram', from: OWNER_TELEGRAM_ID, text: 'wie wird morgen das Wetter', messageContext: { chatId: OWNER_TELEGRAM_ID }, delayMs: 300 },
            ], [{ text: 'Morgen wird es sonnig.' }])
        },
    },
    {
        id: 'auth-fail-closed', anchor: 'Middleware error before authorization — denied (fail-closed)',
        marker: { log: /Middleware error before authorization/ },
        // A broken transport fact (chat id that cannot be read) must never skip the allow-list.
        run: h => h.send('Telegram', OWNER_TELEGRAM_ID, 'Hallo', [], { messageContext: { chatId: { toString() { throw new Error('kaputter Kanal-Kontext') } } } }),
    },
    {
        id: 'owner-link', anchor: 'await replyFn(link.reply)',
        marker: { log: /Owner-Konto verknüpfen/ },
        run: h => h.send('discord', 'discord-user-1', 'verknüpfen 123456'),
    },
    {
        id: 'onboarding-greeting', anchor: 'await replyFn(getOnboardingMessage())',
        marker: { log: /First run detected/ }, options: { noSoul: true },
        run: h => owner(h, 'Hallo'),
    },
    {
        id: 'onboarding-response', anchor: 'await replyFn(getOnboardingConfirmation(soul))',
        marker: { log: /Processing onboarding response/ }, options: { noSoul: true },
        run: async h => { await owner(h, 'Hallo'); return owner(h, 'Du heißt Mira und bist freundlich und direkt') },
    },
    {
        id: 'slash-command', anchor: 'Command /${cmd} ausgeführt (kein LLM nötig)',
        marker: { log: /Command \/whoami ausgeführt/ },
        run: h => owner(h, '/whoami'),
    },
    {
        id: 'slash-unknown', anchor: 'Unknown command /${cmd} — blocked (not sent to LLM)',
        marker: { reply: /Unbekannter Befehl/ },
        run: h => owner(h, '/gibtsnicht'),
    },
    {
        id: 'fast-path', anchor: 'if (!projectStatusFirst && await runFastPath()) return',
        marker: { trace: 'fast-path:identity' },
        run: h => owner(h, 'Wer bist du?'),
    },
    {
        // 2.89 E: a project status question is asked to the projects first; with no
        // project to list it falls through to the same read-only fast path.
        id: 'fast-path-after-projects', anchor: 'if (projectStatusFirst && await runFastPath()) return',
        marker: { trace: 'fast-path:memory-recall' },
        run: h => owner(h, 'Was machen meine Projekte?'),
    },
    {
        id: 'projects', anchor: "await answer(turn.reply, 'projects:handled')",
        marker: { trace: 'projects:handled' },
        run: h => owner(h, 'Kümmer dich um die Steuerunterlagen und nebenbei um den Gartenplan'),
    },
    {
        id: 'clarification-ask', anchor: "'clarification:requested')",
        marker: { trace: 'clarification:requested' },
        run: h => owner(h, 'Installiere das bitte'),
    },
    {
        id: 'clarification-cancel', anchor: "'clarification:cancelled')",
        marker: { trace: 'clarification:cancelled' },
        run: async h => { await owner(h, 'Installiere das bitte'); return owner(h, 'abbrechen') },
    },
    {
        id: 'learned-correction', anchor: 'Using learned ${learned.source} response',
        marker: { log: /\[LearningEngine\] Using learned correction/ },
        run: async h => {
            await owner(h, 'Wie lang ist die Rundtour am Fuschlsee?', [{ text: 'Etwa 5 km.' }], )
            await owner(h, 'Eigentlich ist die Rundtour am Fuschlsee 11 km lang', [{ text: 'Danke, ich merke es mir.' }])
            return owner(h, 'Wie lang ist die Rundtour am Fuschlsee?', [{ text: 'Etwa 5 km.' }])
        },
    },
    {
        id: 'connect-already', anchor: "await answer(connectAnswer, ",
        marker: { trace: 'connect:already-connected' }, options: { searxng: true },
        run: h => owner(h, 'searxng kannst du dich mit dem verbinen ?'),
    },
    {
        id: 'capability-no', anchor: "await answer(gate.reply, 'capability:honest-no')",
        marker: { trace: 'capability:honest-no' },
        run: h => owner(h, 'Kannst du ein Fax senden?'),
    },
    {
        id: 'l7-correction', anchor: 'console.log(`[L7 Learning] Correction handled: ${correction.message}`)',
        marker: { reply: /wie wäre es richtig\?/ },
        run: async h => { await owner(h, 'Wie spät ist es?', [{ tool: 'get_current_time' }, { text: 'Es ist 12:00.' }]); return owner(h, 'Das ist falsch.') },
    },
    {
        id: 'no-llm', anchor: 'Kein LLM verbunden',
        marker: { reply: /Kein LLM verbunden/ },
        run: h => {
            h.state.llm = null
            h.state.config = undefined
            return owner(h, 'Erzähl mir einen Witz')
        },
    },
    {
        id: 'runtime-question', anchor: 'const asksMeshRuntime = question?.mesh',
        marker: { reply: /Xaventra läuft hier auf v\d/ },
        run: h => owner(h, 'Welche Version läuft hier?'),
    },
]

// ---------------------------------------------------------------------------
// static: every early exit before the agent has exactly one gate entry
// ---------------------------------------------------------------------------

function pipelineRegion(): { lines: string[]; start: number } {
    const source = readFileSync(join(process.env.NOVA_PROJECT_ROOT || process.cwd(), 'src', 'core', 'message-pipeline.ts'), 'utf8').replace(/\r\n/g, '\n')
    const lines = source.split('\n')
    const start = lines.findIndex(line => line.includes('async function handleMessageInScope('))
    const end = lines.findIndex((line, index) => index > start && line.includes("traceStep('context:complete')"))
    if (start < 0 || end < 0) throw new Error('message-pipeline.ts: handleMessageInScope or context:complete marker not found')
    return { lines: lines.slice(start, end), start }
}

describe('Wächter: gates before the agent in message-pipeline.ts', () => {
    it('every early return before the agent belongs to exactly one gate with a live-path scenario', () => {
        const { lines, start } = pipelineRegion()
        // A bare `return` on its own line or at the end of a guard (`if (…) return`). Returns
        // with a value belong to nested helpers (e.g. runFastPath) and are not exits.
        const returns = lines.map((line, index) => (/(?:^|[\s)])return\s*$/.test(line) ? index : -1)).filter(index => index >= 0)
        const claimed = new Map<number, string>()
        for (const gate of GATES) {
            const anchors = lines.map((line, index) => (line.includes(gate.anchor) ? index : -1)).filter(index => index >= 0)
            expect(anchors, `gate ${gate.id}: anchor not found (or not unique) — was the gate moved? Update GATES.`).toHaveLength(1)
            const exit = returns.find(index => index >= anchors[0])
            expect(exit, `gate ${gate.id}: no early return after its anchor`).toBeDefined()
            expect(claimed.get(exit!), `gate ${gate.id} and ${claimed.get(exit!)} claim the same exit (line ${start + exit! + 1})`).toBeUndefined()
            claimed.set(exit!, gate.id)
        }
        const unclaimed = returns.filter(index => !claimed.has(index)).map(index => `message-pipeline.ts:${start + index + 1}`)
        expect(unclaimed, 'New early exit before the agent without a live-path scenario — add it to GATES in src/e2e/live-path-gates.test.ts').toEqual([])
    })
})

// ---------------------------------------------------------------------------
// dynamic: each gate is reached over the real daemon entry
// ---------------------------------------------------------------------------

let h: E2EHarness | undefined
afterEach(async () => { await h?.close(); h = undefined })

function reached(gate: Gate, result: TurnResult): boolean {
    const { trace, log, reply } = gate.marker
    return (trace ? result.trace.includes(trace) : true)
        && (log ? result.logs.some(line => log.test(line)) : true)
        && (reply ? result.replies.some(text => reply.test(text)) : true)
}

describe('Wächter: every gate is reached over the real daemon entry', () => {
    for (const gate of GATES) {
        const title = gate.dead ? `[dead path] ${gate.id} — ${gate.dead}` : `${gate.id}`
        ;(gate.dead ? it.fails : it)(title, async () => {
            h = await createE2EHarness(gate.options)
            const result = await gate.run(h)
            expect(reached(gate, result), `gate ${gate.id} not reached. trace=${result.trace.join(',')} replies=${result.replies.join(' | ').slice(0, 300)} error=${String(result.error ?? '')}`).toBe(true)
        }, 90_000)
    }
})
