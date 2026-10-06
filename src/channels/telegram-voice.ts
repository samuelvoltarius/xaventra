/**
 * 2.86 Paket O: Sprachnachrichten in Telegram.
 *
 * 1. Verstehen: zuerst der Sprachdienst im eigenen Mesh (vom Scanner gefunden),
 *    sonst ein lokales Whisper auf diesem Rechner. Nie ein Cloud-Dienst.
 * 2. Antwort immer als Text; auf Wunsch zusätzlich als Sprachnachricht
 *    (Owner-Einstellung oder „antworte per Sprache“ im Satz), Stimme Ramona.
 * 3. Ohne Sprachdienst: ein ehrlicher Satz + ein Knopf, der die
 *    Werkzeugkasten-Karte „Lokaler Sprachdienst“ anlegt (Installation erst nach „Ja“).
 */
import { cleanForSpeech, type VoiceName } from '../voice/voice-call.js'
import { readVoicePrefs, voiceReplyRequest, writeVoicePrefs } from '../voice/voice-prefs.js'

export const VOICE_INSTALL_CALLBACK = 'vo:install'
export const VOICE_CATALOG_ID = 'sprachdienst:de'
/** Telegram-Sprachnachrichten sind kurz; längere Antworten werden gekürzt vorgelesen (Text steht ja da). */
const MAX_SPOKEN_CHARS = 1200

export async function transcribeVoiceNote(audio: Buffer, mime: string, localPath?: string): Promise<{ text: string; via: 'sprachdienst' | 'whisper' } | null> {
    try {
        const { discoverVoiceService, VoiceServiceClient } = await import('../voice/voice-mesh.js')
        const service = await discoverVoiceService()
        if (service) {
            const result = await new VoiceServiceClient(service.endpoint).transcribe(audio, mime || 'audio/ogg')
            if (result.text) return { text: result.text, via: 'sprachdienst' }
        }
    } catch (error) {
        console.warn(`[Nova Telegram] Sprachdienst: ${String((error as Error)?.message || error).slice(0, 160)}`)
    }
    if (!localPath) return null
    try {
        // Lokales Whisper auf diesem Rechner (alter Weg), nie die Cloud-Variante.
        const { transcribe } = await import('../voice/voice-input.js')
        const result = await transcribe(localPath, { model: 'whisper-local' })
        const text = String(result?.text || '').trim()
        return text ? { text, via: 'whisper' } : null
    } catch { return null }
}

export function voiceUnavailableNotice(): { text: string; keyboard: Array<Array<{ text: string; callback_data: string }>> } {
    return {
        text: '🎤 Ich habe deine Sprachnachricht bekommen, kann sie aber noch nicht anhören. '
            + 'Mit dem lokalen Sprachdienst geht das – deine Stimme bleibt dabei in deinem eigenen Netz. Bis dahin schreib mir bitte.',
        keyboard: [[{ text: '🧰 Sprachdienst einrichten', callback_data: VOICE_INSTALL_CALLBACK }]],
    }
}

/**
 * Soll die Antwort auf diesen Satz auch gesprochen werden? „ab jetzt …“ und
 * „wieder per Text“ ändern die Owner-Einstellung (nur für den Owner).
 */
export function shouldReplyByVoice(transcript: string, isOwner: boolean): { speak: boolean; voice: VoiceName } {
    const prefs = readVoicePrefs()
    const request = voiceReplyRequest(transcript)
    if (isOwner && (request === 'on' || request === 'off')) {
        const next = writeVoicePrefs({ replyByVoice: request === 'on' })
        return { speak: next.replyByVoice, voice: next.voice }
    }
    return { speak: request === 'once' || (isOwner && prefs.replyByVoice), voice: prefs.voice }
}

/** Antworttext → Ogg/Opus über den Sprachdienst; null wenn keiner da ist. */
export async function speakReply(text: string, voice: VoiceName): Promise<Buffer | null> {
    let spoken = cleanForSpeech(text)
    if (!spoken) return null
    if (spoken.length > MAX_SPOKEN_CHARS) spoken = `${spoken.slice(0, spoken.lastIndexOf(' ', MAX_SPOKEN_CHARS)).trim()} … Den Rest findest du im Text.`
    try {
        const { discoverVoiceService, VoiceServiceClient } = await import('../voice/voice-mesh.js')
        const service = await discoverVoiceService()
        if (!service) return null
        const audio = await new VoiceServiceClient(service.endpoint).speak(spoken, voice, 'ogg')
        return audio.audio.length ? audio.audio : null
    } catch (error) {
        console.warn(`[Nova Telegram] Sprachantwort: ${String((error as Error)?.message || error).slice(0, 160)}`)
        return null
    }
}

/** Knopf „Sprachdienst einrichten“: legt die Werkzeugkasten-Karte an (Ja/Nein kommt als eigene Karte). */
export async function pressVoiceInstall(isOwner: boolean): Promise<string> {
    if (!isOwner) return '🔒 Das kann nur der Besitzer einrichten.'
    try {
        const { defaultToolboxActionDeps, requestToolboxInstall } = await import('../install/toolbox-actions.js')
        const result = await requestToolboxInstall(VOICE_CATALOG_ID, await defaultToolboxActionDeps())
        return result.ok ? 'Ich habe dir die Karte zum Einrichten geschickt – ein „Ja“ genügt.' : String(result.message || 'Das geht gerade nicht.').slice(0, 180)
    } catch {
        return 'Das geht gerade nicht – bitte später noch einmal.'
    }
}
