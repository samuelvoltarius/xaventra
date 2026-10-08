/**
 * 2.88.2 (live 07.10.2026): an answer claimed "habe … getestet / curl funktioniert /
 * Verbindung steht" although no tool had run in that turn. Such a claim is only allowed
 * with evidence from the same run; otherwise the owner sees plainly that it is unchecked.
 */
const CLAIM = /(?:^|[^\p{L}])(?:ich\s+)?(?:habe|hab)\s+(?:(?!nicht|noch\s+nicht|kein)[\p{L}\p{N}`:/.\-_]+\s+){0,8}?(?:getestet|geprüft|überprüft|nachgesehen|nachgeschaut|ausprobiert|verifiziert)(?![\p{L}])|curl\W*funktioniert|verbindung\s+steht/iu
const NEGATED = /(?:nicht|noch\s+nicht|kein\w*)\s+(?:\S+\s+){0,3}?(?:getestet|geprüft|überprüft|nachgesehen|nachgeschaut|ausprobiert|verifiziert)/iu

export const UNVERIFIED_NOTE = '⚠️ Ungeprüft: Dafür habe ich in diesem Durchgang kein Werkzeug benutzt — das Folgende ist nicht nachgeprüft.'

export function guardUnverifiedClaims(reply: string, toolRuns: number): string {
    if (toolRuns > 0 || !reply) return reply
    const match = CLAIM.exec(reply)
    if (!match) return reply
    const around = reply.slice(Math.max(0, match.index - 30), match.index + match[0].length)
    if (NEGATED.test(around) && !/curl|verbindung\s+steht/i.test(match[0])) return reply
    return `${UNVERIFIED_NOTE}\n\n${reply}`
}

/**
 * 2.89.3: an answer that only ANNOUNCES an action ("Ich rufe kurz die aktuelle Zeit ab ...", "einen Moment") although no
 * tool ran in this run. Short, no figures - a real answer contains its result.
 */
const ANNOUNCED_ACTION = /(?:^|[^\p{L}])ich\s+(?:rufe|ruf|schaue|schau|sehe|seh|prüfe|prüf|pruefe|hole|hol|suche|such|frage|lade|lese|checke|check|ermittle|rechne)\b[^.?!\n]{0,70}?\b(?:ab|nach|kurz|gleich|jetzt|mal|aus|an)\b|(?:^|[^\p{L}])(?:einen\s+moment|moment\s+bitte|einen\s+augenblick|gleich\s+nachgesehen)(?![\p{L}])/iu

export function announcesUnperformedAction(text: string): boolean {
    const value = String(text ?? '').trim()
    if (!value || value.length > 220 || /\d/.test(value)) return false
    return ANNOUNCED_ACTION.test(value)
}

export const ANNOUNCED_BUT_NOT_DONE_REPLY = 'Das konnte ich gerade nicht nachsehen. Magst du es noch einmal versuchen?'

/**
 * 2.89.4 (live 09.10. 00:51–00:53): „dann mach es auf und versuch es nochmal“ (DHL on
 * the workstation) ended twice in a screen description after desktop_screenshot alone.
 * Looking is not acting: only captures/status in a pure action run is no fulfillment.
 */
export const OBSERVATION_ONLY_TOOL_NAMES = new Set([
    'desktop_screenshot', 'screen_capture', 'screen_analyze', 'analyze_image',
    'desktop_status', 'mesh_screenshot', 'webcam_capture', 'minimax_vision',
    'browser_screenshot', 'browser_status',
])

/** True when every tool of this run only looked (screenshot/status). */
export function observationOnlyRun(toolNames: readonly string[]): boolean {
    const names = toolNames.map(name => String(name || '')).filter(Boolean)
    return names.length > 0 && names.every(name => OBSERVATION_ONLY_TOOL_NAMES.has(name))
}

/** A reply that only describes the screen instead of reporting the requested action. */
export function describesScreenWithoutActing(text: string): boolean {
    const value = String(text ?? '').trim()
    if (!value || value.length > 400) return false
    return /(?:kein\w*\s+(?:browserfenster|browser|fenster|programm|app)\w*\b.{0,40}(?:offen|geoeffnet|geöffnet|sichtbar)|(?:leerer?|leeren)\s+(?:desktop|bildschirm)|ich\s+(?:sehe|erkenne)\s+(?:nur|keinen|leeren)|auf\s+(?:dem\s+)?(?:desktop|bildschirm)\s+(?:ist|sind)\b.{0,40}(?:leer|nichts|kein))/iu.test(value)
}

export const SCREEN_ONLY_ACTION_REPLY = 'Ich habe nur auf den Bildschirm geschaut, aber nichts geöffnet oder bedient. Das war keine Handlung. Magst du es noch einmal versuchen — dann öffne oder bediene ich wirklich etwas.'
