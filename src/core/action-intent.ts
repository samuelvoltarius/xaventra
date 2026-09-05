export interface ActionIntent {
    requiresTool: boolean
    kind: 'screenshot' | 'image-generation' | 'system-state' | 'file' | 'web' | 'device-action' | 'generic-action' | 'none'
}

/**
 * Conservative detector for requests whose answer depends on live state or a
 * side effect. These requests must never be answered from model imagination.
 */
export function detectActionIntent(input: string): ActionIntent {
    const text = input.toLowerCase().replace(/\s+/g, ' ').trim()

    if (/\b(screen\s*shot|scre+ns?\s*shot|screnn\s*shot|screenshot|bildschirmfoto|display.{0,20}(?:bild|foto)|monitor.{0,20}(?:bild|foto))\b/i.test(text)) {
        return { requiresTool: true, kind: 'screenshot' }
    }
    if (/\b(?:erstel+l\w*|generier\w*|mach\w*)\b.{0,50}\b(?:bild|foto|illustration|grafik)\b|\b(?:bild|foto|illustration|grafik)\b.{0,50}\b(?:erstel+l\w*|generier\w*|mach\w*)\b/i.test(text)) {
        return { requiresTool: true, kind: 'image-generation' }
    }
    if (/\b(wie sp[aä]t|uhrzeit|welche (?:programme|prozesse|fenster).{0,20}(?:offen|laufen)|was l[aä]uft|tasklist|systemstatus|system status)\b/i.test(text)
        || /\b(?:welche|welches|was für)\b.{0,35}\b(?:modell(?:e|en)?|llms?|provider|runtime)\b.{0,35}\b(?:läuft|laufen|aktiv|verfügbar|geladen|erkannt)\b/i.test(text)
        || /\b(?:modell(?:e|en)?|llms?|vllm|provider|runtime)\b.{0,45}\b(?:läuft|laufen|online|aktiv|verfügbar|geladen|erkannt|erreichbar)\b/i.test(text)
        || /\b(?:wer|wo|welcher node)\b.{0,30}\bmain\b|\bmain\b.{0,30}\b(?:wer|wo|welcher node|aktiv|läuft)\b/i.test(text)
        || /\b(?:welche|wie viele|zeige|zeig)\b.{0,25}\bnodes?\b.{0,30}\b(?:online|aktiv|erreichbar|laufen|status)\b/i.test(text)) {
        return { requiresTool: true, kind: 'system-state' }
    }
    if (/\b(?:lies|lese|read|öffne|open|vergleiche|compare)\b.{0,80}\b(?:datei(?:en)?|files?|ordner|verzeichnisse?)\b/i.test(text)
        || /\b(datei(?:en)?|ordner|verzeichnis)\b.{0,40}\b(auflisten|anzeigen|lesen|schreiben|erstellen|l[oö]schen|kopieren|verschieben|senden)\b/i.test(text)
        || /\b(?:projekt|workspace|codebase|repo(?:sitory)?)\b.{0,55}\b(?:prüf\w*|lies|les\w*|such\w*|find\w*|analysier\w*|zeig\w*|durchsuch\w*)\b/i.test(text)
        || /\b(?:prüf\w*|lies|les\w*|such\w*|find\w*|analysier\w*|zeig\w*|schau\w*|durchsuch\w*)\b.{0,55}\b(?:projekt|workspace|codebase|repo(?:sitory)?)\b/i.test(text)) {
        return { requiresTool: true, kind: 'file' }
    }
    if (/\b(?:tool|werkzeug)[-\s]?(?:aufruf|call|ausf[uü]hrung)(?:e|en|s)?\b|\b(?:tool|werkzeug)\b.{0,30}\b(?:aufrufen|ausf[uü]hren|verwenden|nutzen|wiederholen)\b/i.test(text)) {
        return { requiresTool: true, kind: 'generic-action' }
    }
    if (/\b(such|recherchier|google|online nachsehen|im web|im internet)\b/i.test(text)) {
        return { requiresTool: true, kind: 'web' }
    }
    if (/\b(klick|tippe|maus|cursor|[oö]ffne|starte|beende|schlie(?:ß|ss)e|installier\w*|deinstallier\w*|f[uü]hre .{0,20}aus|restart|neustart|sende|schicke)\b/i.test(text)) {
        return { requiresTool: true, kind: 'device-action' }
    }
    if (/\b(mach\w*|erstel+l\w*|[aä]nder\w*|aktualisier\w*|konfigurier\w*)\b.{0,60}\b(jetzt|bitte|mir|das|die|den)\b/i.test(text)) {
        return { requiresTool: true, kind: 'generic-action' }
    }
    return { requiresTool: false, kind: 'none' }
}

/** Short social acknowledgements close the previous task. They must not inherit
 * its tool pack merely because recent conversation context mentions an action. */
export function isConversationalClosure(input: string): boolean {
    const text = input.toLowerCase().replace(/[!?.😊👍🙏✨]+/g, '').replace(/\s+/g, ' ').trim()
    return /^(?:danke(?: dir)?|vielen dank|super(?: gut gemacht)?|perfekt|sehr gut|gut gemacht|klasse|top|passt|okay|ok|alles klar|freut mich)$/.test(text)
}

const NON_FULFILLING_TOOLS = new Set([
    'nova_capabilities', 'find_capability', 'resolve_capability',
    'health_status', 'nova_introspect', 'list_custom_tools',
    'load_skills', 'load_skill_pack', 'build_skill', 'create_skill',
    'self_setup_status', 'self_setup_plan', 'self_setup_research',
    'research_capability_plan', 'research_all_capabilities',
])

/** Discovery, diagnosis and planning are useful progress, but not evidence that
 * the requested side effect was completed. */
export function toolProvidesActionEvidence(toolName: string): boolean {
    return !NON_FULFILLING_TOOLS.has(toolName)
}

export function responseClaimsCompletedAction(response: string): boolean {
    return /\b(?:ich habe|hab ich|wurde|ist jetzt|soeben|gerade)\b.{0,100}\b(?:gesendet|geschickt|ge[oö]ffnet|gestartet|beendet|geklickt|ausgef[uü]hrt|erstellt|geschrieben|gel[oö]scht|installiert|aktualisiert|konfiguriert|erledigt|fertig)\b/i.test(response)
        || /\b(?:screenshot|datei|foto)\b.{0,60}\b(?:gesendet|geschickt|hochgeladen|erstellt)\b/i.test(response)
}

export function honestNoToolResponse(kind: ActionIntent['kind']): string {
    if (kind === 'screenshot') {
        return 'Ich konnte den Screenshot nicht zuverlässig erstellen oder senden. Es wurde keine Bilddatei übertragen.'
    }
    return 'Ich konnte die angeforderte Aktion nicht zuverlässig ausführen. Es wurde kein passendes Tool erfolgreich ausgeführt.'
}
