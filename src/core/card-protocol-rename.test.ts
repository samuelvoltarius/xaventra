/**
 * 2.82.0 Aufräumen Punkt 7: Der Name „Gedanken“ war doppelt vergeben —
 * `approval-cards/gedanken.jsonl` (Protokoll der Knopf-Karten) neben den
 * Planer-Gedanken `thoughts/thoughts.json`. Das Karten-Protokoll heißt jetzt
 * `karten-protokoll.jsonl`; eine alte Datei wird einmal umbenannt.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CARD_PROTOCOL_FILE, noteThought, readThoughts } from './approval-cards.js'

describe('Karten-Protokoll: ein Name, Migration', () => {
    it('übernimmt gedanken.jsonl einmal (nichts verloren), schreibt danach nur noch karten-protokoll.jsonl', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'card-protocol-'))
        const dir = join(dataDir, 'approval-cards')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'gedanken.jsonl'), `${JSON.stringify({ at: '2026-09-30T08:00:00.000Z', quelle: 'karte', titel: 'Alt', status: 'ja' })}\n`)
        expect(readThoughts({ dataDir }).map(entry => entry.titel)).toEqual(['Alt'])
        expect(existsSync(join(dir, 'gedanken.jsonl'))).toBe(false)
        expect(CARD_PROTOCOL_FILE).toBe('karten-protokoll.jsonl')
        noteThought({ quelle: 'karte', titel: 'Neu', status: 'offen' }, { dataDir })
        expect(readThoughts({ dataDir }).map(entry => entry.titel)).toEqual(['Alt', 'Neu'])
        expect(readFileSync(join(dir, CARD_PROTOCOL_FILE), 'utf8').trim().split('\n')).toHaveLength(2)
        expect(existsSync(join(dir, 'gedanken.jsonl'))).toBe(false)
    })

    it('ohne alte Datei passiert nichts Besonderes', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'card-protocol-'))
        expect(readThoughts({ dataDir })).toEqual([])
        noteThought({ quelle: 'karte', titel: 'Erste', status: 'offen' }, { dataDir })
        expect(existsSync(join(dataDir, 'approval-cards', CARD_PROTOCOL_FILE))).toBe(true)
    })
})
