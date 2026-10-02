/**
 * 2.85 Integration: one model recommendation. The Doctor hint for „Ollama läuft,
 * aber kein Modell“ used its own fixed `ollama pull qwen3:7b` (a tag Ollama does
 * not have) next to the first-start choice and the Scout catalog. Now it asks the
 * same place as the first start (`chooseFirstStartModel`, signed catalog).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { recommendedOllamaPull } from './collect.js'

const file = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

describe('Doctor: Modell-Empfehlung aus derselben Stelle wie der Erste Start', () => {
    it('passt zum Speicher dieses Rechners, aus dem geprüften Katalog', async () => {
        expect(await recommendedOllamaPull(8)).toBe('ollama pull qwen3.5:4b')
        expect(await recommendedOllamaPull(64)).toBe('ollama pull qwen3.5:9b')
        expect(await recommendedOllamaPull(2)).toBeNull()
    })
    it('keine eigene feste Modell-Empfehlung mehr im Doctor', () => {
        expect(file('src/doctor/collect.ts')).not.toMatch(/qwen3:7b/)
    })
})
