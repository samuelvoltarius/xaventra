import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 2.86 Punkt 7: Der Prompt erzieht nicht mehr zu „Soll ich …?“. Alfreds Regel
// „wenig fragen“ und soul.ts („NICHT nach jedem Satz fragen“) gelten auch für
// den Ergebnis-Block: interne, umkehrbare Schritte tut Xaventra selbst; gefragt
// wird nur bei Geld, nach außen senden, physischer Wirkung oder Löschen.
const src = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const pipelineSource = readFileSync(src('../core/message-pipeline.ts'), 'utf8')

describe('Prompt ohne „Soll ich …?“', () => {
    it('der Ergebnis-Block verlangt keine Rückfrage und nennt die vier Karten-Fälle', async () => {
        const { getProactivityPrompt } = await import('./result-analyzer.js')
        const prompt = getProactivityPrompt()
        expect(prompt).not.toMatch(/Soll ich/i)
        expect(prompt).not.toMatch(/VORSCHLAGEN/i)
        expect(prompt).toMatch(/selbst/i)
        for (const fall of [/Geld/, /nach außen/i, /physisch/i, /lösch/i]) expect(prompt).toMatch(fall)
    })

    it('im Modus deep hängt die Pipeline keinen zweiten Vorschlags-Block an', () => {
        expect(pipelineSource).not.toMatch(/proactiveSuggestions/)
        expect(pipelineSource).not.toMatch(/Biete dem User/)
        expect(existsSync(src('./proactive-suggestions.ts'))).toBe(false)
        expect(readFileSync(src('../daemon.ts'), 'utf8')).not.toMatch(/proactive-suggestions/)
    })

    it('der tote L15-Vorschlagsgenerator ist weg', () => {
        expect(readFileSync(src('../layers/L15-self-check.ts'), 'utf8')).not.toMatch(/generateProactiveSuggestion|Soll ich/)
    })
})
