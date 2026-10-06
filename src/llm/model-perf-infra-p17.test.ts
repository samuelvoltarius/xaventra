/**
 * 2.86.1 Punkt 6 (Live-Doctor 06.10.: „qwen: 16 consecutive failures (re-enables
 * at …)“): das Hauptmodell wird nie wegen Infrastruktur abgeschaltet.
 * Zeitüberschreitungen, Abbrüche und Budgetgrenzen zählen nicht (gleiche Regel
 * wie `isInfrastructureFailure` der Korrektur-Erkennung), und das letzte
 * verfügbare lokale Modell wird nie gesperrt — stattdessen eine Meldung.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDisabledModels, getHeldModels, isModelDisabled, recordModelCall, resetModelPerfDbForTests } from './model-perf-db.js'
import { isInfrastructureFailure } from '../core/correction-detector.js'
import { isInfrastructureFailure as shared } from '../core/infrastructure-failure.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'p17-perf-')); resetModelPerfDbForTests(join(dir, 'model-perf.json')) })
afterEach(() => { resetModelPerfDbForTests(null); rmSync(dir, { recursive: true, force: true }) })

const fail = (model: string, error: string, times: number, extra: Record<string, unknown> = {}) => {
    for (let i = 0; i < times; i++) recordModelCall(model, 'chat', 1000, false, { error, local: true, ...extra })
}

describe('2.86.1 Punkt 6: Hauptmodell nie wegen Infrastruktur abschalten', () => {
    it('eine Regel für Infrastruktur-Fehler (Korrektur-Erkennung und Modell-Gesundheit)', () => {
        expect(shared).toBe(isInfrastructureFailure)
    })

    it('Zeitüberschreitungen, Abbrüche und Budgetgrenzen sperren kein Modell', () => {
        recordModelCall('flash', 'chat', 100, true, { local: true })
        fail('qwen', 'AbortError: The operation was aborted due to timeout', 16)
        fail('qwen', 'fetch failed', 4)
        fail('qwen', '', 6, { finishReason: 'length' })
        expect(isModelDisabled('qwen')).toBe(false)
        expect(getDisabledModels()).toEqual([])
    })

    it('das letzte verfügbare lokale Modell wird nie gesperrt — stattdessen eine Meldung', () => {
        fail('qwen', 'LLM API error (500): engine dead', 8)
        expect(isModelDisabled('qwen')).toBe(false)
        expect(getDisabledModels()).toEqual([])
        expect(getHeldModels()).toEqual([expect.objectContaining({ model: 'qwen' })])
    })

    it('gibt es ein zweites lokales Modell, darf ein wirklich kaputtes weiterhin pausieren', () => {
        recordModelCall('flash', 'chat', 100, true, { local: true })
        fail('nano', 'LLM API error (500): engine dead', 6)
        expect(isModelDisabled('nano')).toBe(true)
        expect(isModelDisabled('flash')).toBe(false)
    })
})
