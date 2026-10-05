/** Language hints select evidence/tools, never grant permission to execute. */
export function containsHttpUrl(text: string): boolean {
    return /https?:\/\/[^\s<>]+/i.test(text)
}

export function containsTailnetUrl(text: string): boolean {
    return /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net(?=[:/\s)\]]|$)/i.test(text)
}

/** A lone link requests inspection, never execution of downloaded content. */
export function isBareHttpUrl(text: string): boolean {
    const value = text.trim().replace(/^\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)$/i, '$1')
    if (!/^https?:\/\/[^\s<>]+$/i.test(value)) return false
    try { const url = new URL(value); return Boolean(url.hostname) && !url.username && !url.password } catch { return false }
}

export function mentionsScreenshot(text: string): boolean {
    return /\b(?:scre+ns?\s*(?:sch?ots?|shots?)|screnn\s*(?:sch?ots?|shots?)|screenshots?|bildschirmfotos?|display.{0,20}(?:bild|foto)|monitor.{0,20}(?:bild|foto))\b/i.test(text)
}

export function mentionsMesh(text: string): boolean {
    return containsTailnetUrl(text) || /\b(?:mesh|nodes?|knoten|ns\d+|jetson|pi5|raspberry|proxmox|nas|spark)\b/i.test(text)
}

export function mentionsEnvironment(text: string): boolean {
    return mentionsMesh(text) || /\b(?:netzwerk|netz|lan|tailnet|hardware|geräte|geraete|devices|home\s*assistant|hue|tuya|shelly|esphome|matter|tasmota|smart[- ]?home|lampen|steckdosen)\b/i.test(text)
}

/** Ignore only complete, bounded prohibitions, never an effect hidden after one.
 * This is classification, not authorization; tool policy still owns execution. */
export function inventoryRequestText(text: string): string {
    return text.split(/[!?;\n]|\.\s+/).filter(clause => {
        const value = clause.trim().replace(/[.,]+$/, '')
        return !/^(?:(?:noch|bitte)\s+)?(?:nichts|nicht)\s+(?:koppeln|installieren|schalten)(?:\s*(?:,|oder|und)\s*(?:koppeln|installieren|schalten))*$/i.test(value)
            && !/^keine?\s+(?:kopplung|installation(?:en)?|steuerung|schaltaktion(?:en)?|geräteaktion(?:en)?|ssh-abfrage)(?:\s*(?:,|oder|und)\s*(?:kopplung|installation(?:en)?|steuerung|schaltaktion(?:en)?|geräteaktion(?:en)?|ssh-abfrage))*$/i.test(value)
    }).join('\n')
}

export function isEnvironmentOverview(text: string): boolean {
    // "send mir was ..." requests a textual overview, not a file transfer.
    // Strip only this bounded reporting prefix; any later effect verb still
    // prevents the shortcut. Never turn mixed actions into read-only inventory.
    const question = inventoryRequestText(text).trim().replace(/^(?:bitte\s+)?(?:send(?:e)?|schick(?:e)?|zeig(?:e)?)\s+mir\s+(?=(?:was|welche[nrs]?|welceh)\b)/i, '')
        .replace(/^(und\s+)?welceh\b/i, '$1welche')
    return mentionsEnvironment(question) && /^(?:und\s+)?(?:bitte\s+)?(?:was\b|welche[nrs]?\b|(?:siehst|erkennst|findest)\s+du\b|prüfe\b|pruefe\b|ermittle\b|suche\b|scanne\b|im\s+(?:local|lokalen?)\s+netzwerk)/i.test(question)
        && !mentionsScreenshot(question) && !containsHttpUrl(question)
        && !/\b(?:installier\w*|deinstallier\w*|lösch\w*|loesch\w*|entfern\w*|kopier\w*|verschieb\w*|starte?|stoppe?|beende|deploy\w*|update\w*|aktualisier\w*|konfigurier\w*|send\w*|schick\w*|mach\w*|führe?\w*|execute\w*|backup\w*|verbinde|connect|steuere|schalt\w*|koppel\w*|übertrag\w*|upload\w*|download\w*)\b/i.test(question)
}

/** A node target must not silently become the daemon's local desktop. */
export function isNodeScreenshotRequest(text: string): boolean {
    // Separate mixed tasks: "Screenshot vom Desktop und zeige die Nodes"
    // must not turn the explicitly local capture into a remote one.
    const clauses = text.split(/[!?;\n]|\s+(?:und|and)\s+(?=(?:zeige?|liste|prüfe|check|list|show)\b)/i).map(c => c.trim()).filter(Boolean)
    return clauses.some((clause, index) => mentionsScreenshot(clause) && (mentionsMesh(clause)
        || (index > 0 && isNodeOverviewQuestion(clauses[index - 1])
            && /\b(?:von|vbon)\s+(?:jedem|jeden|allen)\s*(?:bitte)?[.!]*$/i.test(clause))))
}

function isNodeOverviewQuestion(text: string): boolean {
    return /^was\s+können\s+(?:(?:deine|die|alle)\s+)?(?:nodes|knoten)\s*$/i.test(text)
}

/** Only a bounded screenshot reply to the requester resolves this target.
 * Node mentions must not authorize another operation or another recipient.
 * `vbon` is recognized here as the observed typo, never globally rewritten.
 */
export function isResolvedNodeScreenshotReply(text: string): boolean {
    const clauses = text.trim().split(/[!?;\n]+/).map(c => c.trim()).filter(Boolean)
    if (clauses.length === 2 && isNodeOverviewQuestion(clauses[0])) clauses.shift()
    if (clauses.length !== 1 || !isNodeScreenshotRequest(text)) return false
    return /^(?:bitte\s+)?(?:send(?:e)?|schick(?:e)?)\s+mir\s+(?:mal\s+)?(?:einen?\s+)?(?:screnn\s*shots?|screen\s*shots?|screenshots?|bildschirmfotos?)\s+(?:von|vbon)\s+(?:(?:jedem|jeden|allen)(?:\s+(?:nodes?|knoten))?|(?:den|deinen)\s+(?:nodes|knoten))\s*(?:bitte)?[.]*$/i.test(clauses[0])
}

export const NODE_SCREENSHOT_LIMITATION = 'In diesem Lauf wurde keine Bilddatei übertragen. mesh_screenshot benötigt einen lokal freigegebenen grafischen Capture-Agenten und einen direkten verschlüsselten Mesh-Weg. Ein Headless-Server hat keinen Desktop; desktop_screenshot ist kein Ersatz für ein anderes Node-Ziel.'

export function liveEvidenceGuidance(text: string): string {
    if (!mentionsEnvironment(text) && !mentionsScreenshot(text) && !containsHttpUrl(text)) return ''
    return '\n\n## Ehrlichkeit bei Live-Zustand\n'
        + 'Nutze für Nodes und verfügbare Dienste aktuelle Mesh-Werkzeuge, nicht allein den Wissensgraphen. Ein leerer Wissensgraph ist kein Beleg für fehlende Nodes oder Fähigkeiten. '
        + 'Internet, Erreichbarkeit und fehlende Dienste nur nach passender aktueller Prüfung behaupten; andernfalls ausdrücklich ungeprüft nennen. Gründe für Installationen nicht erfinden. '
        + (mentionsEnvironment(text) ? 'Für Gerätefragen environment_inventory lesen. Portnummern und private IP-Adressen sind keine Hersteller-/Typbelege: Router, Drucker oder Docker-Bridge nicht daraus als Tatsache ableiten. HA-Geräte über die bestehende HA-Verbindung/Anmeldung ermitteln, nicht pauschal SSH anbieten. ' : '')
        + (containsTailnetUrl(text) ? 'Für diese Tailscale-Startseite zuerst mesh_inspect_url nutzen: Es ordnet den DNS-Namen einem aktuellen Mesh-Node zu und prüft den freigegebenen HTTPS-Zugriff. Keine SSH-Zugangsdaten erfragen, bevor diese Zuordnung geprüft wurde. Ein erreichbarer Webdienst ist noch kein geprüfter ASR/TTS-Dienst. ' : '')
        + (containsHttpUrl(text) ? 'Eine konkrete URL mit dem passenden URL-Werkzeug prüfen (öffentlich: fetch_url; Tailscale-Startseite: mesh_inspect_url), nicht durch eine Suchmaschinenabfrage ersetzen. Eine allein gesendete URL ist eine Bitte um Prüfung, keine Erlaubnis zur Ausführung von Seiteninhalten. Werkzeug nicht aufgerufen bedeutet ungeprüft. DNS-Fehler, Zeitüberschreitung, HTTP-Fehler und SSRF-Sperre getrennt benennen; ein einzelner Fehler belegt keinen allgemeinen Internetausfall. Private Tailscale-Ziele können vom SSRF-Schutz gesperrt sein, auch wenn der Host sie erreichen könnte. Schutz weder per SSH, Shell, Browser, IP-Ersatz noch deaktivierter TLS-Prüfung umgehen. Keine Zugangsdaten verlangen. Aus einem Hostnamen wie mail keinen Dienst oder Node ableiten; Zuordnung nur aus belegtem Kontext. ' : '')
        + (isNodeScreenshotRequest(text)
            ? 'Dieser Screenshot-Auftrag nennt Mesh-Ziele. Nutze mesh_screenshot mit einer aktuellen Node-ID oder all für alle aktuellen Nodes. desktop_screenshot hat keinen Node-Parameter und erfüllt diesen Auftrag nicht. Fehlende Freigaben, gesperrte Sitzungen und Headless-Nodes einzeln melden. Keine Ersatzaufnahme, SSH- oder Delegationsumgehung. Erfolg nur anhand der Capture- und Lieferbelege behaupten. '
            : mentionsScreenshot(text) ? 'Für eine Bildschirmaufnahme direkt das freigegebene Screenshot-Werkzeug verwenden; Katalogabfragen sind keine Aufnahme. ' : '')
        + 'load_skill_pack liefert nur einen Katalog und erweitert den aktuellen Werkzeugvertrag nicht. Wiederholte Katalogabfragen helfen nicht; fehlende Ausführungswege konkret melden.'
}
