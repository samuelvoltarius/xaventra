import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transcribe } from './voice-input.js'
import { ensureVoiceDeps } from './voice-setup.js'
import { playAudio, speak } from './voice-output.js'

export interface VoiceE2EOptions {
    audioPath?: string
    generateTts?: boolean
    playback?: boolean
    installMissing?: boolean
}

export interface VoiceE2EResult {
    ok: boolean
    depsOk: boolean
    ttsOk?: boolean
    sttOk?: boolean
    playbackOk?: boolean
    transcript?: string
    audioPath?: string
    warnings: string[]
}

export async function runVoiceE2ECheck(options: VoiceE2EOptions = {}): Promise<VoiceE2EResult> {
    const warnings: string[] = []
    const deps = await ensureVoiceDeps({ installMissing: options.installMissing === true })
    warnings.push(...deps.warnings)
    let ttsOk: boolean | undefined
    let sttOk: boolean | undefined
    let playbackOk: boolean | undefined
    let generatedAudio: string | undefined
    let transcript: string | undefined

    if (!deps.ok) {
        warnings.push(`Voice dependencies incomplete: ${deps.failed.join(', ') || 'unknown'}`)
    }

    if (options.generateTts) {
        try {
            const spoken = await speak('Nova Voice Check. Wenn du das hoerst, funktioniert Text zu Sprache.')
            generatedAudio = spoken.audioPath
            ttsOk = existsSync(spoken.audioPath) && statSync(spoken.audioPath).size > 0
            if (options.playback && ttsOk) {
                await playAudio(spoken.audioPath)
                playbackOk = true
            }
        } catch (err) {
            ttsOk = false
            warnings.push(`TTS failed: ${err}`)
        }
    }

    if (options.audioPath) {
        try {
            const result = await transcribe(options.audioPath, { model: 'faster-whisper' })
            transcript = result.text
            sttOk = transcript.trim().length > 0
        } catch (err) {
            sttOk = false
            warnings.push(`STT failed: ${err}`)
        }
    }

    const ok = deps.ok
        && (ttsOk !== false)
        && (sttOk !== false)
        && (playbackOk !== false)

    return {
        ok,
        depsOk: deps.ok,
        ttsOk,
        sttOk,
        playbackOk,
        transcript,
        audioPath: generatedAudio,
        warnings,
    }
}

async function main(): Promise<void> {
    const result = await runVoiceE2ECheck({
        generateTts: process.env.NOVA_VOICE_E2E_TTS === '1',
        playback: process.env.NOVA_VOICE_E2E_PLAYBACK === '1',
        installMissing: process.env.NOVA_VOICE_E2E_INSTALL === '1',
        audioPath: process.env.NOVA_VOICE_E2E_AUDIO,
    })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(err => {
        console.error(err)
        process.exit(1)
    })
}

export default { runVoiceE2ECheck }
