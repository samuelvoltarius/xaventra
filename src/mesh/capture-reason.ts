/** Raw capture errors in one plain sentence for the owner (no "Error: Error:", no internals). */
export function captureReason(raw: unknown): string {
    const text = String(raw ?? '').replace(/^(?:\s*(?:Error|TypeError):\s*)+/i, '').trim()
    if (/not enrolled|headless|NOVA_MESH_CAPTURE/i.test(text)) return 'keine Bildschirmaufnahme möglich (Server ohne Bildschirm oder Aufnahme noch nicht freigeschaltet)'
    if (/timed out|timeout/i.test(text)) return 'keine Antwort rechtzeitig, kein Bild bestätigt'
    if (/delivery was not verified/i.test(text)) return 'Bild aufgenommen, aber die Zustellung wurde nicht bestätigt'
    if (/quota/i.test(text)) return 'Bild aufgenommen, aber der private Speicher ist voll'
    return text ? `Aufnahme fehlgeschlagen: ${text.slice(0, 160)}` : 'Aufnahme fehlgeschlagen'
}
