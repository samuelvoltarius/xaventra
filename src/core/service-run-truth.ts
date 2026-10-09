/**
 * 2.89.4: „Läuft“ nur mit Beleg.
 *
 * Ein Dienst zählt in Status-/Inventar-Antworten nur dann als laufend, wenn
 * eine Sonde in genau diesem Lauf erfolgreich war. Sonst „nicht geprüft“ oder
 * „nicht erreichbar“. Nutzer-Korrekturen („läuft doch schon“, „solltest du
 * schon verbunden sein“) werden nicht ungeprüft übernommen: sofort live prüfen
 * und verbinden oder das Prüfergebnis ehrlich melden — beim Thema bleiben.
 */
import { redactSecrets } from '../security/secret-redaction.js'

export type ServiceRunClaim = 'laeuft' | 'nicht-erreichbar' | 'nicht-geprueft'

export interface ServiceProbeEvidence {
    name: string
    ok: boolean
    at: number
    detail?: string
}

export interface ServiceStateCorrection {
    /** The user claims the service is already up/connected. */
    claimRunning: boolean
    /** The user claims we should already be connected. */
    claimConnected: boolean
    /** Free-text subject (service/node name) when one was named. */
    subject: string
}

export interface LiveServiceCheck {
    lines: string[]
    anyOk: boolean
    probed: ServiceProbeEvidence[]
    connected: string[]
}

/** This-run evidence only. Never persisted — a restart forgets every claim. */
const evidence = new Map<string, ServiceProbeEvidence>()

export function resetServiceProbeEvidence(): void {
    evidence.clear()
}

export function recordServiceProbe(name: string, ok: boolean, detail?: string): ServiceProbeEvidence {
    const entry: ServiceProbeEvidence = { name: String(name || '').trim() || 'dienst', ok: Boolean(ok), at: Date.now(), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) }
    evidence.set(entry.name.toLowerCase(), entry)
    return entry
}

export function getServiceProbeEvidence(name: string): ServiceProbeEvidence | null {
    return evidence.get(String(name || '').trim().toLowerCase()) || null
}

/**
 * The one wording rule: „läuft“ only after a successful probe in this run.
 * A failed probe this run is „nicht erreichbar“; without a probe „nicht geprüft“.
 */
export function serviceRunClaim(name: string, claimedRunning?: boolean): ServiceRunClaim {
    const seen = getServiceProbeEvidence(name)
    if (seen) return seen.ok ? 'laeuft' : 'nicht-erreichbar'
    if (claimedRunning === true) return 'nicht-geprueft'
    return 'nicht-geprueft'
}

export function serviceRunLabel(name: string, claimedRunning?: boolean): string {
    const claim = serviceRunClaim(name, claimedRunning)
    return claim === 'laeuft' ? 'läuft'
        : claim === 'nicht-erreichbar' ? 'nicht erreichbar'
            : 'nicht geprüft'
}

export function formatServiceStatus(name: string, options: { claimedRunning?: boolean; detail?: string } = {}): string {
    const label = serviceRunLabel(name, options.claimedRunning)
    const seen = getServiceProbeEvidence(name)
    const detail = options.detail || seen?.detail
    if (label === 'läuft') return detail ? `${name}: läuft (geprüft) — ${detail}` : `${name}: läuft (geprüft)`
    if (label === 'nicht erreichbar') return detail ? `${name}: nicht erreichbar — ${detail}` : `${name}: nicht erreichbar`
    return options.claimedRunning
        ? `${name}: nicht geprüft (Bestand sagt „läuft“, in diesem Lauf keine Sonde)`
        : `${name}: nicht geprüft`
}

/**
 * Service-state corrections from the owner: „läuft doch schon“, „solltest du
 * schon verbunden sein“. Status questions („läuft alles?“) and reports stay out.
 */
const SUBJECT_STOP = new Set(['du', 'ich', 'es', 'das', 'die', 'der', 'wir', 'ihr', 'sie', 'man', 'nicht', 'nichts', 'alles', 'etwas', 'deren', 'dessen'])

export function detectServiceStateCorrection(text: unknown): ServiceStateCorrection | null {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim()
    if (!value || value.length > 400) return null
    // A lone status question is no correction.
    if (/^(?:läuft|laeuft|geht|funktioniert|ist|sind|bist)\b[^.!?]{0,40}\?$/i.test(value)) return null

    const prefix = String.raw`(?:doch\s+|ja\s+|eigentlich\s+|wohl\s+|schon\s+|bereits\s+|längst\s+|laengst\s+)*`
    const down = new RegExp(String.raw`\b(?:läuft|laeuft|geht|funktioniert)\s+(?:wirklich\s+|gar\s+|ja\s+)?(?:nicht|mehr\s+nicht|noch\s+nicht)|\b(?:ist|bist)\s+(?:noch\s+|ja\s+)?(?:nicht|gar\s+nicht)\s+(?:verbunden|online|erreichbar|aktiv|dabei)|\b(?:solltest|sollte)\s+(?:du\s+)?(?:doch\s+|eigentlich\s+)?(?:nicht|nie)`, 'i').test(value)
    const up = new RegExp(String.raw`\b(?:läuft|laeuft)\s+${prefix}(?:schon|bereits|wieder|längst|laengst)|\b(?:läuft|laeuft)\s+doch\b|\b(?:ist|bist)\s+${prefix}(?:online|verbunden|erreichbar|aktiv|dabei)|\b(?:solltest|sollte)\s+(?:du\s+)?${prefix}(?:verbunden(?:\s+sein)?|online\s+sein|erreichbar\s+sein|laufen|dabei(?:\s+sein)?)|\b(?:du\s+)?(?:bist|sollst)\s+${prefix}(?:verbunden|online|dabei)|\bwarum\s+bist\s+du\s+(?:noch\s+)?(?:nicht|nicht\s+mehr)\s+(?:verbunden|online|dabei)|\b(?:bin|ist)\s+(?:doch\s+)?(?:schon\s+)?(?:eingerichtet|konfiguriert)\b`, 'i').test(value)
    // A quoted voice notice followed by the owner's correction is common in
    // Telegram. Require a speech subject; "du hast die Sachen schon" alone is
    // not evidence that the user is talking about a service.
    const speechSubject = /\b(?:stt|tts|sprachdienst(?:e)?|spracherkennung|sprachausgabe|whisper|pocket[-_ ]?tts)\b/i.test(value)
    const localCorrection = speechSubject && !/\?\s*$/.test(value) && !/\b(?:nicht|nie)\b/i.test(value.split(/Du hast/i).at(-1) || '') && (
        /\bdu\s+hast\s+(?:local|lokal)\b[^.!?]{0,80}\b(?:schon|bereits)\b/i.test(value)
        || /\b(?:laufen|läuft|laeuft)\b[^.!?]{0,80}\b(?:local|lokal|schon|bereits)\b/i.test(value)
        || /\b(?:local|lokal|schon|bereits)\b[^.!?]{0,80}\blaufen\b/i.test(value)
    )
    const runningClaim = up || localCorrection
    if (!runningClaim && !down) return null
    if (runningClaim && down) return null

    let subject = ''
    const named = value.match(/\b(pocket[-_ ]?tts|whisper(?:[-_ ]?gpu)?|xaventra[-_ ]?voice|kokoro|piper|ollama|vllm|lm[-_ ]?studio|searxng|home[-_ ]?assistant|proxmox|telegram|whatsapp|discord|sprachdienst(?:e)?|spracherkennung|sprachausgabe|stt|tts)\b/i)
        || value.match(/\b([A-Za-z][\w.-]{1,40})\s+(?:läuft|laeuft|ist|solltest|sollte)\b/i)
        || value.match(/\b(?:von|für|fuer|zum|zur|mit|bei|auf)\s+(?:dem\s+|den\s+|der\s+)?([A-Za-z][\w.-]{1,40})\b/i)
    if (named?.[1]) {
        const candidate = named[1].trim()
        if (!SUBJECT_STOP.has(candidate.toLowerCase())) subject = candidate
    }
    // A named subject this live-check cannot probe (Home Assistant, Proxmox, …)
    // has its own tools. Never answer about speech/model when the user named those.
    if (subject && !isLiveCheckSubject(subject)) return null
    return {
        claimRunning: Boolean(runningClaim) && !down,
        claimConnected: /\b(?:verbunden|dabei|online|eingerichtet|konfiguriert)\b/i.test(value) || (Boolean(up) && /\b(?:solltest|sollte)\b/i.test(value)),
        subject,
    }
}

/** Subjects `liveCheckServices` can actually probe (speech + model runtime). */
const LIVE_CHECK_SUBJECTS = new Set([
    'sprachdienst', 'spracherkennung', 'sprachausgabe', 'sprachmodell', 'sprachdienste', 'stt', 'tts',
    'whisper', 'whispergpu', 'pockettts', 'pocket-tts', 'pocket_tts',
    'xaventravoice', 'xaventra-voice', 'xaventra_voice',
    'kokoro', 'piper', 'ollama', 'vllm', 'lmstudio', 'lm-studio', 'lm_studio',
])

function isLiveCheckSubject(subject: string): boolean {
    const key = subject.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
    const plain = key.replace(/-/g, '')
    return LIVE_CHECK_SUBJECTS.has(key) || LIVE_CHECK_SUBJECTS.has(plain)
        || [...LIVE_CHECK_SUBJECTS].some(item => item.replace(/-/g, '') === plain)
}

export interface LiveCheckOptions {
    fetchImpl?: typeof fetch
    timeoutMs?: number
    /** Skip network (tests that only want the wording helpers). */
    probe?: boolean
}

/**
 * Live-check the services this node can actually ask right now: speech
 * (xaventra-voice / OpenAI-compatible TTS+STT) and the configured model
 * runtime. A probe that answers becomes this-run evidence and is treated as
 * connected (the discovery path already uses it).
 */
export async function liveCheckServices(options: LiveCheckOptions = {}): Promise<LiveServiceCheck> {
    const probed: ServiceProbeEvidence[] = []
    const connected: string[] = []
    const lines: string[] = []
    if (options.probe === false) {
        return { lines: [formatServiceStatus('Sprachdienste'), formatServiceStatus('Sprachmodell')], anyOk: false, probed, connected }
    }

    // 1) Speech — the same live probes the voice path uses.
    const STT_NAME = 'Spracherkennung (STT)'
    const TTS_NAME = 'Sprachausgabe (TTS)'
    try {
        const { probeSpeechServices, discoverOpenAiStt, discoverOpenAiTts, OPENAI_AUDIO_STT_NAME, POCKET_TTS_NAME } = await import('../voice/openai-audio.js')
        const speech = await probeSpeechServices({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
        const stt = recordServiceProbe(STT_NAME, Boolean(speech.anyStt), speech.anyStt ? 'Spracherkennung antwortet' : 'keine Spracherkennung erreichbar')
        const tts = recordServiceProbe(TTS_NAME, Boolean(speech.anyTts), speech.anyTts ? 'Sprachausgabe antwortet' : 'keine Sprachausgabe erreichbar')
        probed.push(stt, tts)
        lines.push(formatServiceStatus(STT_NAME, { claimedRunning: true }))
        lines.push(formatServiceStatus(TTS_NAME, { claimedRunning: true }))
        if (speech.anyStt) {
            try {
                const found = await discoverOpenAiStt({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
                if (found) {
                    recordServiceProbe(OPENAI_AUDIO_STT_NAME, true, found.endpoint)
                    connected.push(`${OPENAI_AUDIO_STT_NAME} (${found.endpoint})`)
                }
            } catch { /* discovery is optional */ }
        }
        if (speech.anyTts) {
            try {
                const found = await discoverOpenAiTts({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
                if (found) {
                    recordServiceProbe(POCKET_TTS_NAME, true, found.endpoint)
                    connected.push(`${POCKET_TTS_NAME} (${found.endpoint})`)
                }
            } catch { /* discovery is optional */ }
        }
        if (speech.details?.length) lines.push(`Sprach-Sonden: ${speech.details.slice(0, 6).join('; ')}`)
    } catch (error) {
        recordServiceProbe(STT_NAME, false, 'Sprachprüfung fehlgeschlagen')
        recordServiceProbe(TTS_NAME, false, 'Sprachprüfung fehlgeschlagen')
        lines.push(formatServiceStatus('Sprachdienste', { claimedRunning: false, detail: redactSecrets(String((error as Error)?.message || error)).slice(0, 80) }))
    }

    // 2) The configured model runtime (this-run HTTP probe).
    try {
        const { describeActiveRuntime } = await import('../llm/active-runtime.js')
        const runtime = await describeActiveRuntime({ probe: true, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs })
        const name = runtime.model ? `${runtime.provider}/${runtime.model}` : runtime.kind === 'none' ? 'Sprachmodell' : `Sprachmodell (${runtime.provider})`
        if (runtime.kind === 'local') {
            const ok = runtime.reachable === true
            const entry = recordServiceProbe(name, ok, ok ? `antwortet (${runtime.localModels.length} Modell${runtime.localModels.length === 1 ? '' : 'e'})` : 'antwortet gerade nicht')
            probed.push(entry)
            lines.push(formatServiceStatus(name, { claimedRunning: true, detail: entry.detail }))
            if (ok) connected.push(name)
        } else if (runtime.kind === 'cloud') {
            // Cloud is never claimed „läuft“ without a live call (there is none here).
            recordServiceProbe(name, false, 'Cloud ohne Live-Prüfung')
            lines.push(`${name}: nicht geprüft (Cloud — in diesem Lauf keine Live-Sonde; ${runtime.keyPresent ? 'Schlüssel vorhanden' : 'kein Schlüssel'})`)
        } else {
            recordServiceProbe(name, false, 'kein Modell eingestellt')
            lines.push(`${name}: nicht geprüft (nichts eingestellt)`)
        }
    } catch (error) {
        probed.push(recordServiceProbe('Sprachmodell', false, 'Laufzeitprüfung fehlgeschlagen'))
        lines.push(formatServiceStatus('Sprachmodell', { claimedRunning: false, detail: redactSecrets(String((error as Error)?.message || error)).slice(0, 80) }))
    }

    return { lines, anyOk: probed.some(item => item.ok), probed, connected }
}

/**
 * One honest reply to a service-state correction. Stays on that topic: probe
 * result first, then what was connected. Never accepts the claim unverified.
 */
export function formatServiceCorrectionReply(check: LiveServiceCheck, correction: ServiceStateCorrection | null, userText = ''): string {
    const subject = correction?.subject ? ` (${correction.subject})` : ''
    const header = correction?.claimConnected
        ? `Ich habe das gerade live geprüft${subject} und melde nur, was eine Sonde in diesem Lauf bestätigt:`
        : `Ich habe deine Angabe nicht ungeprüft übernommen, sondern live geprüft${subject}:`
    const body = check.lines.map(line => `• ${line}`).join('\n')
    const connected = check.connected.length
        ? `\n\nVerbunden und ab jetzt nutzbar: ${check.connected.join(', ')}.`
        : ''
    let verdict = ''
    if (correction?.claimRunning && !check.anyOk) {
        verdict = '\n\nDeine Angabe („läuft schon“) konnte ich in diesem Lauf nicht bestätigen — die Sonden antworten gerade nicht. Ich behaupte das Gegenteil auch nicht ohne Beleg.'
    } else if (correction?.claimRunning && check.anyOk) {
        verdict = '\n\nDu hattest recht: etwas davon antwortet. Ich habe es geprüft und nehme es in Betrieb.'
    } else if (correction && !correction.claimRunning) {
        verdict = check.anyOk
            ? '\n\nEine Sonde antwortet gerade doch — ich habe das oben mit Beleg notiert.'
            : '\n\nDas deckt sich mit dem Prüfergebnis: gerade nicht erreichbar.'
    }
    const user = userText && userText.length <= 120 ? `\n\n(Bezug: „${userText.trim()}“)` : ''
    return redactSecrets(`${header}\n${body}${connected}${verdict}${user}`)
}
