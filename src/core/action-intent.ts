import { inferRequiredToolTargets } from './tool-evidence-binding.js'

export interface ActionIntent {
    requiresTool: boolean
    kind: 'screenshot' | 'image-generation' | 'system-state' | 'file' | 'web' | 'device-action' | 'generic-action' | 'none'
}

/** Narrow speech-act projection, not a general language parser or an authority
 * grant. Clear operational announcements/explanations must reach the model as
 * conversation. Unrecognized clauses retain the existing evidence requirements.
 * Split mixed turns before filtering, so an announcement cannot hide a request.
 */
export function actionRequestText(input: string): string {
    const masked = input.replace(/„[^“]*“|“[^”]*”|"[^"\n]*"|`[^`\n]*`/g, value => ' '.repeat(value.length))
    const boundary = /[!?;]\s*|\.\s+|\n+|(?:,\s*|\s+(?:und|aber|dann|and|but|then)\s+)(?=(?:bitte\s+)?(?:installier\w*|deinstallier\w*|starte?\b|stoppe?\b|beende\b|prüfe?\b|pruefe?\b|check\b|lösche?\b|loesche?\b|entferne?\b|sende?\b|schicke?\b|mach\w*|lies\b|suche?\b|recherchier\w*|zeige?\b|kannst\b|sollst\b|du\s+sollst\b))|[, ]+\bbitte\s+(?=\S)/gi
    const clauses: string[] = []
    let start = 0
    for (const match of masked.matchAll(boundary)) {
        clauses.push(input.slice(start, match.index))
        start = match.index! + match[0].length
    }
    clauses.push(input.slice(start))
    return clauses.filter(clause => {
        const text = clause.trim().replace(/[.,]+$/, '').trim()
        if (!text) return false
        // Wishes addressed to the assistant remain requests, even when they
        // start with "I". Never treat reported future/past work as permission.
        if (/\b(?:ich (?:möchte|will)|wir (?:möchten|wollen))\b.{0,40}\b(?:du|dass)\b|\bdu (?:sollst|musst)\b/i.test(text)) return true
        const operation = /\b(?:installier\w*|deinstallier\w*|start\w*|gestartet|stopp\w*|gestoppt|deploy\w*|aktualisier\w*|konfigurier\w*|lösch\w*|gelöscht|entfern\w*|entfernt|restart\w*|updat\w*)\b/i.test(text)
        if (operation && /^(?:was bedeutet|was heißt|was heisst|what does .+ mean|erkläre?\b|erklaere?\b|explain\b)/i.test(text)) return false
        if (operation && /^(?:wie\s+\w+\s+(?:ich|man|wir)\b|how (?:do|can) (?:i|we)\b)/i.test(text)) return false
        if (operation && /^(?:(?:ich|wir)\s+(?:werde[n]?|habe[n]?|hatte[n]?|installier\w*|start\w*|aktualisier\w*|konfigurier\w*|lösch\w*|entfern\w*)\b|du\s+(?:wirst|bist|wurdest)\b|(?:der|die|das)\s+.{1,50}\s+(?:wird|werden|wurde|wurden|ist|sind)\b|(?:i|we) (?:will|have|am|are)\b|you (?:will be|are being|were)\b)/i.test(text)) return false
        return true
    }).join('\n')
}

export function isConversationOnly(input: string): boolean {
    return Boolean(input.trim()) && !actionRequestText(input).trim()
}

/** Included once by the authoritative pipeline prompt assembler, not a canned
 * response. The model still chooses an appropriate answer to the whole turn. */
export function conversationResponseGuidance(input: string): string {
    if (!isConversationOnly(input)) return ''
    return '\n\n## Gesprächsabsicht\nDie aktuelle Nachricht ist eine Mitteilung oder eine Bitte um Erklärung, kein Ausführungsauftrag. '
        + 'Verstehe zuerst, was der Mensch dir erzählt, und reagiere kurz, freundlich und natürlich darauf. '
        + 'Bei einer Ankündigung zunächst darauf eingehen; eine interessierte Rückfrage nur, wenn sie sinnvoll ist. '
        + 'Bei einer Erklärungsfrage den Sachverhalt erklären, nicht selbst ausführen. '
        + 'Technische Begriffe sind allein kein Handlungsauftrag. Umgangssprachliche Begeisterung nicht mit einem ungefragten technischen Vortrag beantworten. '
        + 'Keine feste Standardantwort, keine erzwungene Zielabfrage, keine Werkzeuge oder Behauptung, etwas ausgeführt zu haben. '
        + 'Dass dieser Gesprächszug keine Werkzeuge benötigt, sagt nichts über deine allgemeinen Fähigkeiten oder deinen Systemzugriff aus. '
        + 'Erfinde weder zusätzliche Rechte noch pauschale Einschränkungen wie "rein textbasiert" oder "kein Systemzugriff". '
        + 'Eine angekündigte Umstellung nicht als bereits verifizierten Zustand oder neue Berechtigung übernehmen.'
}

/**
 * Conservative detector for requests whose answer depends on live state or a
 * side effect. These requests must never be answered from model imagination.
 */
export function detectActionIntent(input: string): ActionIntent {
    const text = actionRequestText(input).toLowerCase().replace(/\s+/g, ' ').trim()
    const explicitFileTargets = inferRequiredToolTargets(text)
        .filter(target => !/^https?:\/\//.test(target))

    if (/\b(?:schau|prüfe|pruefe|zeige|zeig|liste|check|inspect)\b.{0,80}\b(?:docker|container|prozesse|services|dienste)\b/.test(text)
        || /\b(?:welche|wie viele)\b.{0,35}\b(?:container|dienste|prozesse)\b.{0,35}\b(?:laufen|aktiv|gestartet|vorhanden)\b/.test(text)) {
        return { requiresTool: true, kind: 'system-state' }
    }

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
        || (/\b(?:lies|lese|read|öffne|open|vergleiche|compare)\b/i.test(text) && explicitFileTargets.length > 0)
        || /\b(datei(?:en)?|ordner|verzeichnis)\b.{0,40}\b(auflisten|anzeigen|lesen|schreiben|erstellen|l[oö]schen|kopieren|verschieben|senden)\b/i.test(text)
        || /\b(?:projekt|workspace|codebase|repo(?:sitory)?)\b.{0,55}\b(?:prüf\w*|lies|les\w*|such\w*|find\w*|analysier\w*|zeig\w*|durchsuch\w*)\b/i.test(text)
        || /\b(?:prüf\w*|lies|les\w*|such\w*|find\w*|analysier\w*|zeig\w*|schau\w*|durchsuch\w*)\b.{0,55}\b(?:projekt|workspace|codebase|repo(?:sitory)?)\b/i.test(text)) {
        return { requiresTool: true, kind: 'file' }
    }
    if (/\b(?:tool|werkzeug)[-\s]?(?:aufruf|call|ausf[uü]hrung)(?:e|en|s)?\b|\b(?:tool|werkzeug)\b.{0,30}\b(?:aufrufen|ausf[uü]hren|verwenden|nutzen|wiederholen)\b/i.test(text)) {
        return { requiresTool: true, kind: 'generic-action' }
    }
    if (/\b(suche?|recherchier(?:e|en)?|google|online nachsehen|im web|im internet)\b/i.test(text)
        || /\b(?:check|prüfe|pruefe|teste|fetch|abrufen)\b.{0,100}(?:\burl\b|https?:\/\/)/i.test(text)) {
        return { requiresTool: true, kind: 'web' }
    }
    if (/\b(klick|tippe|maus|cursor|[oö]ffne|starte|beende|schlie(?:ß|ss)e|installier\w*|deinstallier\w*|lösch\w*|loesch\w*|entfern\w*|f[uü]hre .{0,20}aus|restart|neustart|sende|schicke)\b/i.test(text)) {
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

/** Explicit current-turn instruction to answer from existing conversation,
 * not to repeat an external action mentioned in that conversation. */
export function isHistoryOnlyRequest(input: string): boolean {
    const text = input.toLowerCase().replace(/\s+/g, ' ')
    return /\b(?:antworte|antwort|sage|sag)\b.{0,35}\b(?:nur|ausschließlich)\b.{0,30}\b(?:verlauf|gedächtnis|erinnerung|kontext)\b/.test(text)
        || (/\b(?:aus dem verlauf|aus der erinnerung|aus dem gedächtnis)\b/.test(text)
            && /\bohne\b.{0,40}\b(?:erneut|noch einmal|tools?|werkzeuge?)\b/.test(text))
        || /\b(?:answer|reply)\b.{0,25}\b(?:only|solely)\b.{0,25}\b(?:history|memory|conversation)\b/.test(text)
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
