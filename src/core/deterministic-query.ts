import { parseNaturalMemoryForget } from '../memory/memory-quality.js'

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
    if (/\b(?:pausiere|pause)\b.*\b(?:mission|auftrag)\b/.test(text)) return route('mission', 'pause', 'mission-pause', 'controlled-action')
    if (/\b(?:setze|führe|fuehre)\b.*\b(?:mission|auftrag)\b.*\b(?:fort|weiter)\b/.test(text)) return route('mission', 'resume', 'mission-resume', 'controlled-action')
    if (/\b(?:stoppe|beende|brich)\b.*\b(?:mission|auftrag)\b/.test(text)) return route('mission', 'stop', 'mission-stop', 'controlled-action')
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
