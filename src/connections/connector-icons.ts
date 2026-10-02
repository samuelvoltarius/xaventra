/**
 * Stufe-1 icons, shipped with the release (no network when the view is shown).
 * Own neutral monograms (no third-party brand artwork in the package); each
 * manifest carries the sha256 of exactly these bytes (`icon_hash`), so a
 * changed icon never resolves. Static, script-free SVG.
 */

const monogram = (letters: string, color: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48"><rect width="48" height="48" rx="12" fill="${color}"/>`
    + `<text x="24" y="31" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" fill="#ffffff">${letters}</text></svg>`

/** Key = path behind `xaventra:icons/` in `icon_url`. */
export const BUILTIN_CONNECTOR_ICONS: Readonly<Record<string, string>> = Object.freeze({
    'home-assistant.svg': monogram('HA', '#1f8fd6'),
    'google-calendar.svg': monogram('Ka', '#2f6fde'),
    'gmail.svg': monogram('Gm', '#c5372c'),
    'github.svg': monogram('GH', '#24292f'),
    'proxmox.svg': monogram('PX', '#d9631e'),
    'dateien.svg': monogram('Da', '#5a6b7b'),
})
