import { parseNaturalMemoryForget } from '../memory/memory-quality.js'
import { parseRoutineSatz, parseSchaltSatz } from '../sensing/device-sentences.js'
import { isFreshnessQuestion } from '../mesh/recommendation-truth.js'
import { detectServiceStateCorrection } from './service-run-truth.js'

export type NaturalCommandRisk = 'read-only' | 'controlled-action'

export interface DeterministicCommand {
    command: string
    args: string
    reason: string
    risk: NaturalCommandRisk
}

function route(command: string, args: string, reason: string, risk: NaturalCommandRisk = 'read-only'): DeterministicCommand {
    return { command, args, reason, risk }
}

function normalize(input: string): string {
    return input.toLocaleLowerCase('de-DE')
        .normalize('NFKC')
        .replace(/[?!.,:;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Maps unambiguous natural-language requests to the existing RBAC-aware
 * command handlers. Controlled actions are only routed when the current
 * message contains the complete action and target; the command handler keeps
 * ownership, approval, PATCH_GATE and release-gate authority.
 */
export function detectDeterministicCommand(input: string): DeterministicCommand | null {
    const text = normalize(input)
    if (!text) return null

    if (/^(?:scan|scanne|prüfe|pruefe)(?: doch)?(?: mal)? (?:deine |die |alle )?docker[ -]container(?: (?:hier|lokal|local))?$/.test(text)) {
        return route('docker', 'list', 'local-docker-inventory')
    }

    // Only complete local inventory queries: mixed write instructions and remote
    // targets do not inherit this read-only shortcut.
    if (/^(?:(?:sag|zeig) mir |zeige mir |liste |list |show )?(?:welche |die |alle )?(?:docker[ -])?container(?: laufen| sind aktiv)?(?: (?:local|lokal|hier)(?: laufen| sind aktiv)?)?$/.test(text)
        && /docker/.test(text)) return route('docker', 'list', 'local-docker-inventory')

    if (/^(?:wer|was) bist du$/.test(text)) return route('identity', '', 'identity')
    // 2.89: „Hast du Internet?“ from the one internet question (core/environment.ts hasInternet),
    // never a model claim. Only the whole status question — searches „im Internet“ stay with the model.
    if (/^(?:hast du|habt ihr)(?: gerade| jetzt| noch| überhaupt| ueberhaupt)? (?:internet|(?:eine )?internetverbindung|internetzugang|(?:eine )?verbindung (?:zum|ins) internet)$/.test(text)
        || /^bist du (?:gerade |jetzt |noch )?online$/.test(text)
        || /^(?:geht|funktioniert) (?:dein |das |euer )?internet(?: gerade| noch| jetzt)?$/.test(text)
        || /^ist (?:das )?internet (?:da|erreichbar|verfügbar|verfuegbar)$/.test(text)) return route('internet', '', 'internet-status')
    if (/^(?:was kannst du(?: alles)?|welche fähigkeiten hast du|what can you do)$/.test(text)) return route('capabilities', '', 'registered-capabilities')
    if (/^(?:welche rechte habe ich|welche rolle habe ich)$/.test(text)) return route('whoami', '', 'principal-role')
    // 2.85 Paket D: Werkzeugkasten as a normal question (read-only short list, no new command).
    if (/^was (?:könntest|koenntest|kannst|solltest|würdest|wuerdest) du (?:dir )?(?:noch|zusätzlich|zusaetzlich) (?:installieren|einrichten)$/.test(text)
        || /^welche (?:programme|software|werkzeuge|tools) (?:würden|wuerden|könnten|koennten) dir (?:noch )?helfen$/.test(text)
        || /^welche (?:programme|software|werkzeuge|tools) (?:fehlen|fehlt) dir(?: noch)?$/.test(text)
        || /^(?:zeig(?:e)?(?: mir)? )?(?:den |deinen )?werkzeugkasten$/.test(text)) return route('software', 'werkzeugkasten', 'toolbox')
    // 2.85 Paket A: the connections list (read-only, owner command) without a slash.
    if (/^(?:womit|mit was|mit welchen diensten) (?:kannst|könntest) du dich (?:alles )?verbinden$/.test(text)
        || /^(?:welche|was für) verbindungen (?:hast|kennst) du(?: alles)?$/.test(text)
        || /^was ist (?:alles )?verbunden$/.test(text)
        || /^(?:zeig|zeige)(?: mir)? (?:deine |die |alle )?verbindungen$/.test(text)) return route('verbindungen', '', 'connections-list')

    // 2.89.4: service-state corrections („läuft doch schon“, „solltest du schon
    // verbunden sein“) are live-checked immediately — never accepted unverified,
    // never answered on another topic.
    if (detectServiceStateCorrection(input)) return route('dienste', 'live-check', 'service-live-check', 'read-only')

    // 2.86 Paket N: „und?“ / „hat's geklappt?“ right after connecting → the stored state of that
    // connection (handler answers '' when nothing ran lately → normal conversation).
    if (/^(?:und|und jetzt|und nun|na und|hat(?:'s|s| es) geklappt|geklappt|fertig|klappt(?:'s|s| es)|und klappt(?:'s|s| es))$/.test(text)) return route('geraete', 'stand', 'connect-progress')
    // 2.86 Paket N: switching and routines in everyday language. The handler only
    // creates a preview card (physical = card, policy unchanged); a bare device
    // name needs a switching verb, so „ich gehe heute aus“ stays conversation.
    if (/^(?:zeig(?:e)?(?: mir)? )?(?:meine |die |alle )?(?:geräte|geraete|schalt)[- ]?routinen$/.test(text)) return route('geraete', 'routinen', 'device-routines')
    const deviceRoutine = parseRoutineSatz(input)
    const deviceSwitch = deviceRoutine ? deviceRoutine.satz : parseSchaltSatz(input)
    if (deviceSwitch && (deviceRoutine || deviceSwitch.was !== 'name' || /^(?:bitte )?(?:mach|mache|schalt|schalte|knips)\b/.test(text))) {
        return route('geraete', `sag ${input.trim()}`, 'device-switch-preview', 'controlled-action')
    }

    const forgetTarget = parseNaturalMemoryForget(input)
    if (forgetTarget) return route('memory', `forget-natural ${forgetTarget}`, 'memory-forget', 'controlled-action')

    // Live world model and trust/evidence views.
    if (/\b(?:was weißt|was weisst|weltbild|world model|lagebild)\b.*\b(?:nova|system|mesh|gerade|aktuell)\b/.test(text)
        || /\b(?:zeige|erkläre|erklaere)\b.*\b(?:dein|das)\b.*\b(?:weltbild|lagebild)\b/.test(text)) {
        return route('world', '', 'world-model')
    }
    if (/\b(?:was|welche).*(?:weißt|weisst|kennst|gemerkt).*(?:über|ueber)?\s*(?:mich|mir)\b/.test(text)
        || /^(?:wer bin ich|wie hei(?:ß|ss)e ich)\b/.test(text)
        || /^woran arbeite ich\b/.test(text)
        || /^(?:was|welche).*\bmeine[nr]?\s+(?:ziele|projekte|präferenzen|praeferenzen|regeln|anweisungen)\b/.test(text)
        || /^erinnerst du dich (?:noch )?(?:an|daran)\b/.test(text)
        || /^(?:wie hei(?:ß|ss)t|was ist)\s+mein(?:e|er|en|em|es)?\s+\S+/.test(text)) {
        return route('memory', `recall-natural ${input.trim()}`, 'memory-recall')
    }

    if (/\b(?:wo|auf welchen?)(?:\s+\w+){0,4}\s+läuf(?:st|t)\b.*\b(?:nova|du|main)\b/.test(text)
        || /\bwer\b.*\bmain\b/.test(text)
        || /\bwelche nodes?\b.*\b(?:online|aktiv|erreichbar)\b/.test(text)
        || /\bwo läuft (?:der )?main\b/.test(text)) return route('nodes', '', 'mesh-status')

    if (/\b(?:welche|was für)\b.*\b(?:modelle|vllm|ollama|ki software|ai software)\b.*\b(?:nodes?|hosts?|mesh)\b/.test(text)
        || /\bwo\b.*\b(?:vllm|ollama)\b.*\b(?:läuft|verfügbar)\b/.test(text)
        || /\bwo\b.*\bläuft\b.*\b(?:vllm|ollama)\b.*\b(?:mesh|nodes?|hosts?)\b/.test(text)
        || /\bwelche (?:modelle|provider) (?:sind|hast du) (?:verfügbar|aktiv)\b/.test(text)) {
        return route('nodes', 'services', 'mesh-services')
    }

    // 2.89.4: recommendations about „aktuell / neueste / Stand der Technik /
    // Ende <Jahr>“ always go through a web search + per-node hardware gate.
    // After the mesh inventory so „welche Modelle auf den Nodes?“ stays inventory.
    if (isFreshnessQuestion(input)) return route('empfehlung', 'frisch', 'recommendation-freshness', 'read-only')

    if (/^(?:wie ist |zeige |gib mir )?(?:dein |der |den )?(?:system ?status|status)(?: jetzt)?$/.test(text)) return route('status', '', 'system-status')
    if (/\b(?:welche|was ist die)\b.*\bnova version\b|\bupdate status\b|\bist ein update\b.*\bverfügbar\b/.test(text)) return route('update', 'status', 'update-status')
    if (/\bcodex\b.*\b(?:status|verbunden|angemeldet|verfügbar)\b/.test(text)) return route('codex', 'status', 'codex-status')
    if (/\b(?:welche|zeige|liste)\b.*\b(?:user|benutzer)\b/.test(text)) return route('users', 'list', 'user-list')

    // Diagnostics and plans do not change the machine.
    if (/\b(?:prüfe|pruefe|diagnostiziere|untersuche|checke)\b.*\b(?:nova|system|fehler|gesundheit|health)\b/.test(text)
        || /\b(?:lass|starte|mach)\b.*\b(?:den )?doctor\b.*\b(?:laufen|diagnose|check)\b/.test(text)) return route('doctor', '', 'doctor-diagnose')
    if (/\b(?:erstelle|zeige|mach)\b.*\b(?:self setup|setup)\b.*\bplan\b/.test(text)
        || /\b(?:prüfe|pruefe)\b.*\bfehlende (?:software|fähigkeiten|faehigkeiten|capabilities)\b/.test(text)) return route('setup', 'plan', 'setup-plan')
    if (/\b(?:benchmark|benchmarks|testlabor)\b.*\b(?:status|bericht|report|ergebnisse?)\b/.test(text)) return route('benchmark', 'status', 'benchmark-status')
    if (/\b(?:failover|ausfallsicherung|übernahme|uebernahme)\b.*\b(?:bereit|status|funktioniert|sicher)\b/.test(text)) return route('failover', '', 'failover-readiness')

    // Mission control. A new mission requires an explicit autonomy verb; plain
    // requests continue through the normal execution kernel.
    if (/\b(?:wie weit|status)\b.*\b(?:mission|auftrag)\b/.test(text)) return route('mission', 'status', 'mission-status')
    // 2.89: actions only for the whole, anchored sentence and never when negated —
    // „brich den Auftrag bitte nicht ab“ or „ich will den Auftrag nicht beenden“ is no stop.
    const negated = /\b(?:nicht|nie|niemals|kein|keine|keinen)\b/.test(text)
    const target = String.raw`(?:die |den |meine |meinen |unsere |unseren |diese |diesen )?(?:mission|auftrag)`
    if (!negated && new RegExp(String.raw`^(?:bitte )?(?:pausiere|pause) ${target}(?: bitte)?$`).test(text)) return route('mission', 'pause', 'mission-pause', 'controlled-action')
    if (!negated && new RegExp(String.raw`^(?:bitte )?(?:setze|führe|fuehre) ${target} (?:(?:weiter )?fort|weiter)(?: bitte)?$`).test(text)) return route('mission', 'resume', 'mission-resume', 'controlled-action')
    if (!negated && new RegExp(String.raw`^(?:bitte )?(?:stoppe|beende|brich) ${target}(?: bitte)?(?: ab)?$`).test(text)) return route('mission', 'stop', 'mission-stop', 'controlled-action')
    const mission = text.match(/^(?:starte|erstelle|übernimm|uebernimm)\s+(?:eine\s+)?(?:autonome\s+)?(?:mission|auftrag)\s*(?:mit dem ziel|für|fuer|:)\s+(.+)$/)
    if (mission?.[1]) return route('mission', mission[1].trim(), 'mission-start', 'controlled-action')

    // Explicit controlled actions still execute through the same security and
    // approval gates as their slash-command equivalents.
    if (/^(?:starte|führe|fuehre)\s+(?:den\s+)?(?:signierten\s+)?(?:mesh )?(?:rollout|update deploy)(?:\s+jetzt)?$/.test(text)) {
        return route('update', 'deploy', 'signed-rollout', 'controlled-action')
    }
    if (/^(?:repariere|fixe)\s+(?:die\s+)?(?:doctor|nova)(?:\s+fehler)?$/.test(text)
        || /^(?:lass|starte)\s+(?:den\s+)?doctor\s+(?:die\s+)?(?:sichere[n]?\s+)?fixes\s+(?:vorbereiten|erstellen)$/.test(text)) {
        return route('doctor', 'fix', 'doctor-fix-proposal', 'controlled-action')
    }
    if (/^(?:räume|raeume|bereinige|konsolidiere)\s+(?:dein|das|den)?\s*(?:memory|gedächtnis|gedaechtnis)(?:\s+auf)?$/.test(text)) {
        return route('memory', 'consolidate', 'memory-consolidation', 'controlled-action')
    }
    if (/^(?:starte|führe|fuehre)\s+(?:die\s+)?(?:100\s+)?benchmarks?(?:\s+aus)?$/.test(text)) {
        return route('benchmark', 'run', 'benchmark-run', 'controlled-action')
    }

    return null
}
