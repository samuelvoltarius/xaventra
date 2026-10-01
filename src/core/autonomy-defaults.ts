/**
 * Standard: selbstständig (P8, Alfred 01.10.2026).
 *
 * Die Autonomie-Module (Planer + Bericht, Wahrnehmen inkl. Geräte-Suche,
 * Denken, Verantwortungen/Missionen, Delegation, Auto-Erinnerungen,
 * Software-Scout, Release-Knopf) laufen am Main ohne Config-Eintrag. Eine
 * fehlende Angabe heißt AN; nur ein ausdrückliches `enabled: false` (oder
 * "false"/"aus"/"off"/"0") schaltet ab. Ein Mesh-Worker (`NOVA_NODE_ONLY=true`)
 * bekommt aus einer fehlenden Angabe nie ein AN — Worker starten keine
 * Main-Funktionen; die Laufzeiten prüfen den Worker zusätzlich selbst.
 *
 * Bewusst NICHT über diesen Weg (bleiben aus, bis ausdrücklich `true`):
 * Selbst-Update-Aktivierung (Fencing), Stufe-3-Selbstheilung
 * (`autonomy.selfHeal`), Codex (`codex.enabled`), Nachtwache (braucht eine
 * private Proben-Datei).
 */

const OFF_WORDS = new Set(['false', 'aus', 'off', '0', 'no', 'nein'])
const ON_WORDS = new Set(['true', 'an', 'on', '1', 'yes', 'ja'])

/** true auf einem Mesh-Worker (`NOVA_NODE_ONLY=true`). */
export function isAutonomyWorker(env: NodeJS.ProcessEnv = process.env): boolean {
    return String(env?.NOVA_NODE_ONLY || '').trim().toLowerCase() === 'true'
}

/**
 * Schalter mit Standard AN am Main:
 * - `false` (oder ein Aus-Wort) → aus,
 * - `true` (oder ein An-Wort) → an,
 * - fehlt/unklar → an am Main, aus am Worker.
 */
export function defaultOn(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
    if (value === false) return false
    if (value === true) return true
    if (typeof value === 'string') {
        const word = value.trim().toLowerCase()
        if (OFF_WORDS.has(word)) return false
        if (ON_WORDS.has(word)) return true
    }
    return !isAutonomyWorker(env)
}

/** Übersicht für Doku/Status: welcher Schalter folgt welchem Standard. */
export const AUTONOMY_DEFAULTS = Object.freeze({
    standardAn: Object.freeze([
        'autonomy.planner.enabled', 'autonomy.briefing.enabled',
        'autonomy.sensing.enabled', 'autonomy.sensing.adapters.*.enabled', 'autonomy.sensing.discovery.enabled',
        'autonomy.thinking.enabled', 'autonomy.thinking.ideas|scout|bugFinder|learning.enabled',
        'autonomy.responsibilities.enabled', 'autonomy.delegation.enabled', 'autonomy.autoReminders.enabled',
        'autonomy.softwareScout.enabled', 'autonomy.releaseButton.enabled',
    ]),
    standardAus: Object.freeze([
        'autonomy.selfUpdate.enabled (Aktivierung, Fencing)', 'autonomy.selfHeal.enabled (Stufe 3)', 'codex.enabled', 'autonomy.nightwatch.enabled',
    ]),
})
