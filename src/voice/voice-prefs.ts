/**
 * 2.86 Paket O: Owner-Einstellung „Antworte per Sprache“.
 *
 * Eine kleine Datei in `.nova-data` (keine Inhalte, nur zwei Schalter). Die
 * Einstellung gilt für Telegram und die App; „antworte per Sprache“ im Satz
 * gilt einmal, „ab jetzt immer …“ / „wieder per Text“ ändert die Einstellung.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getNovaDataDir } from '../core/data-root.js'
import type { VoiceName } from './voice-call.js'

export interface VoicePrefs { replyByVoice: boolean; voice: VoiceName }
const DEFAULTS: VoicePrefs = Object.freeze({ replyByVoice: false, voice: 'female' })

export function voicePrefsPath(): string { return getNovaDataDir('voice-prefs.json') }

export function readVoicePrefs(path = voicePrefsPath()): VoicePrefs {
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'))
        return { replyByVoice: data?.replyByVoice === true, voice: data?.voice === 'male' ? 'male' : 'female' }
    } catch { return { ...DEFAULTS } }
}

export function writeVoicePrefs(change: Partial<VoicePrefs>, path = voicePrefsPath()): VoicePrefs {
    const current = readVoicePrefs(path)
    const next: VoicePrefs = {
        replyByVoice: typeof change.replyByVoice === 'boolean' ? change.replyByVoice : current.replyByVoice,
        voice: change.voice === 'male' || change.voice === 'female' ? change.voice : current.voice,
    }
    mkdirSync(dirname(path), { recursive: true })
    const part = `${path}.part`
    writeFileSync(part, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(part, path)
    return next
}

const VOICE = String.raw`(?:per|mit|als|in)\s+(?:sprache|stimme|sprachnachricht(?:en)?|audio)`
const OFF = /(?:antwort\w*|schreib\w*|sprich)\s+(?:mir\s+)?(?:bitte\s+)?(?:wieder\s+)?(?:per|als|mit|in)\s+text\b|wieder\s+schriftlich|keine\s+sprach(?:nachricht|antwort)\w*|nicht\s+mehr\s+(?:per|mit|als)\s+(?:sprache|stimme)/i
const ALWAYS = /\b(?:ab\s+(?:jetzt|sofort|heute)|immer|künftig|kuenftig|in\s+zukunft|von\s+nun\s+an)\b/i
const ASK = new RegExp(String.raw`(?:(?:antwort\w*|sag\w*|sprich|erzähl\w*|erzaehl\w*)\b[^.?!]{0,40}?${VOICE}|${VOICE}[^.?!]{0,20}?\b(?:antworten|antwortest|sagen)|\b(?:vorlesen|lies\s+(?:es|das|mir)\b))`, 'i')

/** 'once' = diese Antwort sprechen, 'on'/'off' = Einstellung ändern, null = kein Wunsch. */
export function voiceReplyRequest(text: string): 'once' | 'on' | 'off' | null {
    const value = String(text || '')
    if (OFF.test(value)) return 'off'
    if (!ASK.test(value)) return null
    return ALWAYS.test(value) ? 'on' : 'once'
}
