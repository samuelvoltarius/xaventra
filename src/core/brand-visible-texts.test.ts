/**
 * 2.82.0 Aufräumen Punkt 7: sichtbares „Nova“ in Nutzertexten, Bot-Texten und
 * Meldungen heißt jetzt „Xaventra“. Kompatibilitäts-Bezeichner (NOVA_*-Env,
 * .nova-data, Paketnamen, Persona-Name) bleiben (BRAND_MIGRATION.md).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

describe('sichtbarer Markenname', () => {
    it('/status, Hilfe, Bot-Texte, Berichte und Meldungen sagen Xaventra', () => {
        const slash = src('core/slash-commands.ts')
        expect(slash).toContain('*Xaventra v${NOVA_VERSION} Status*')
        expect(slash).not.toMatch(/\*Nova v\$\{NOVA_VERSION\}|✨ \*Nova Befehle\*|Nova Autonomy Status/)
        expect(src('channels/telegram-grammy.ts')).not.toMatch(/Willkommen bei Nova|\*Nova Commands\*|Nova ist online/)
        expect(src('channels/telegram.ts')).not.toMatch(/✨ \*Nova Befehle\*|⏳ Nova arbeitet/)
        expect(src('daemon.ts')).toContain("'✨ *Xaventra Online!*'")
        expect(src('core/autonomous-executor.ts')).toContain('🎯 *Xaventra: Auftrag gestartet*')
        expect(src('doctor/format.ts')).toContain('🩺 *Xaventra Doctor*')
        expect(src('layers/dream-daily-digest.ts')).toContain('*Xaventra Tagesbericht*')
    })

    it('Kompatibilitäts-Bezeichner bleiben unverändert', () => {
        expect(src('core/slash-commands.ts')).toMatch(/NOVA_VERSION/)
        expect(src('core/data-root.ts')).toMatch(/'\.nova-data'/)
        expect(src('core/soul.ts')).toMatch(/name: 'Nova'/)
    })
})
