import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionContinuityStore } from './session-summarizer.js'

let root = ''
const previousRoot = process.env.NOVA_RUNTIME_ROOT

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-continuity-forget-'))
    process.env.NOVA_RUNTIME_ROOT = root
    const sessions = join(root, '.nova-data', 'sessions')
    mkdirSync(sessions, { recursive: true })
    const line = (content: string, ts: string) => JSON.stringify({ ts, channel: 'telegram', role: 'user', content })
    writeFileSync(join(sessions, 'alice.jsonl'), [
        line('Ziel ist, den alten Server Atlas zu ersetzen.', '2026-09-01T10:00:00.000Z'),
        line('Ich bevorzuge kurze Antworten auf Deutsch.', '2026-09-01T10:01:00.000Z'),
    ].join('\n') + '\n')
})

afterEach(() => {
    if (previousRoot === undefined) delete process.env.NOVA_RUNTIME_ROOT
    else process.env.NOVA_RUNTIME_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
})

const storePath = () => join(root, '.nova-data', 'memory', 'session-continuity.json')

describe('session continuity forgetting survives restarts (H8)', () => {
    it('does not replay the session log after a restart once backfilled', () => {
        const first = new SessionContinuityStore(storePath())
        expect(first.backfillFromSessionLogs('alice', ['alice'])).toBeGreaterThan(0)
        expect(first.forget('alice', 'Server Atlas')).toBeGreaterThan(0)

        const restarted = new SessionContinuityStore(storePath())
        expect(restarted.backfillFromSessionLogs('alice', ['alice'])).toBe(0)
        expect(restarted.getSessionPrompt('alice', 'Wo waren wir?')).not.toContain('Atlas')
    })

    it('skips log content that was forgotten before the first backfill', () => {
        const first = new SessionContinuityStore(storePath())
        first.forget('alice', 'Server Atlas')

        const restarted = new SessionContinuityStore(storePath())
        expect(restarted.backfillFromSessionLogs('alice', ['alice'])).toBe(1)
        const prompt = restarted.getSessionPrompt('alice', 'Wo waren wir?')
        expect(prompt).not.toContain('Atlas')
        expect(prompt).toContain('kurze Antworten')
    })

    it('skips everything logged before a forget-all', () => {
        const first = new SessionContinuityStore(storePath())
        first.forget('alice', '__all__', true)

        const restarted = new SessionContinuityStore(storePath())
        expect(restarted.backfillFromSessionLogs('alice', ['alice'])).toBe(0)
        expect(restarted.getSessionPrompt('alice', 'Wo waren wir?')).toBe('')
    })

    it('keeps the backfill marker per principal', () => {
        const first = new SessionContinuityStore(storePath())
        expect(first.backfillFromSessionLogs('alice', ['alice'])).toBeGreaterThan(0)
        const restarted = new SessionContinuityStore(storePath())
        expect(restarted.backfillFromSessionLogs('alice', ['alice'])).toBe(0)
        expect(restarted.backfillFromSessionLogs('bob', ['alice'])).toBeGreaterThan(0)
    })
})
