import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Telegram 28.10. (2.89.11, Langtest A): "Drucker einschalten" → hass_turn_on
// verlangte die Freigabe, der Owner schickte den /freigabe-Code, die Steckdose
// blieb aus. hass_turn_on bot keinen Parameter `confirm` an, also konnte das
// Modell den Code nie durchreichen. Jedes Werkzeug, dessen Handler die
// Owner-Freigabe prüft, muss deshalb `confirm` im Schema anbieten.
const toolsDir = dirname(fileURLToPath(import.meta.url))
const sources = readdirSync(toolsDir)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'owner-approval.ts')
    .filter(file => readFileSync(join(toolsDir, file), 'utf8').includes('ownerApprovalRefusal('))

describe('Owner-Freigabe: Einmal-Code muss durchreichbar sein', () => {
    it('findet die Werkzeugdateien mit Freigabe', () => {
        expect(sources).toContain('homeassistant.ts')
    })

    it.each(sources)('%s: jedes Werkzeug mit ownerApprovalRefusal hat den Parameter confirm', async (file) => {
        const mod: Record<string, unknown> = await import(/* @vite-ignore */ `./${file.replace(/\.ts$/, '')}.js`)
        const tools = Object.values(mod)
            .filter(Array.isArray)
            .flat()
            .filter((tool: any) => tool && typeof tool.name === 'string' && typeof tool.handler === 'function' && Array.isArray(tool.parameters))
        const missing = tools
            .filter((tool: any) => String(tool.handler).includes('ownerApprovalRefusal'))
            .filter((tool: any) => !tool.parameters.some((parameter: any) => parameter.name === 'confirm'))
            .map((tool: any) => tool.name)
        expect(missing).toEqual([])
    })
})
