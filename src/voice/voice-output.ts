/**
 * Voice Output - Edge-TTS
 * 
 * Converts text to speech using Edge-TTS (free, high quality).
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { execSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { platform } from 'node:os'

// ============================================
// Types
// ============================================

export interface TTSConfig {
    voice: string
    rate?: string  // e.g. '+10%', '-20%'
    pitch?: string // e.g. '+5Hz', '-10Hz'
    volume?: string // e.g. '+20%'
}

export interface TTSResult {
    audioPath: string
    duration?: number
}

// ============================================
// Voice Presets
// ============================================

export const VOICES = {
    // German
    'de-female': 'de-DE-KatjaNeural',
    'de-male': 'de-DE-ConradNeural',
    'de-nova': 'de-AT-IngridNeural',  // Austrian, sounds friendly

    // English
    'en-female': 'en-US-JennyNeural',
    'en-male': 'en-US-GuyNeural',
    'en-nova': 'en-GB-SoniaNeural',  // British, sounds professional
}

const DEFAULT_CONFIG: TTSConfig = {
    voice: VOICES['de-nova'],
    rate: '+0%',
    pitch: '+0Hz',
    volume: '+0%',
}

// ============================================
// TTS Functions
// ============================================

const VOICE_DIR = '.nova-voice'

function ensureDir(): string {
    const dir = join(process.cwd(), VOICE_DIR)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
}

/**
 * Generate speech using edge-tts (Python)
 */
export async function speak(
    text: string,
    config: Partial<TTSConfig> = {}
): Promise<TTSResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config }
    const dir = ensureDir()
    const outputPath = join(dir, `speech_${Date.now()}.mp3`)

    // Build edge-tts command
    const args = [
        '-m', 'edge_tts',
        '--voice', cfg.voice,
        '--rate', cfg.rate || '+0%',
        '--pitch', cfg.pitch || '+0Hz',
        '--volume', cfg.volume || '+0%',
        '--text', text,
        '--write-media', outputPath,
    ]

    console.log(`[VoiceOutput] Generating speech: "${text.slice(0, 50)}..."`)

    return new Promise((resolve, reject) => {
        const proc = spawn('python', args, { stdio: 'pipe' })

        let stderr = ''
        proc.stderr?.on('data', (d) => { stderr += d.toString() })

        proc.on('close', (code) => {
            if (code === 0 && existsSync(outputPath)) {
                console.log(`[VoiceOutput] Generated: ${outputPath}`)
                resolve({ audioPath: outputPath })
            } else {
                reject(new Error(`edge-tts failed: ${stderr}`))
            }
        })

        proc.on('error', reject)

        // Timeout after 30s
        setTimeout(() => {
            proc.kill()
            reject(new Error('edge-tts timeout'))
        }, 30000)
    })
}

/**
 * Speak and return audio buffer (for Telegram)
 */
export async function speakToBuffer(
    text: string,
    config: Partial<TTSConfig> = {}
): Promise<Buffer> {
    const { audioPath } = await speak(text, config)
    const { readFileSync } = await import('node:fs')
    const buffer = readFileSync(audioPath)

    // Cleanup temp file
    try { unlinkSync(audioPath) } catch { }

    return buffer
}

/**
 * Get audio duration in milliseconds using ffprobe.
 * Returns null if ffprobe is not available.
 */
function getAudioDurationMs(audioPath: string): Promise<number | null> {
    return new Promise(resolve => {
        const p = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            audioPath,
        ], { stdio: ['ignore', 'pipe', 'ignore'] })
        let out = ''
        p.stdout?.on('data', (d: Buffer) => { out += d.toString() })
        p.on('close', (code) => {
            if (code === 0) {
                const secs = parseFloat(out.trim())
                resolve(isNaN(secs) ? null : Math.ceil(secs * 1000))
            } else {
                resolve(null)
            }
        })
        p.on('error', () => resolve(null))
        setTimeout(() => { p.kill(); resolve(null) }, 3000)
    })
}

/**
 * Play an audio file (MP3/WAV) — cross-platform.
 * Waits until playback is actually finished (no fixed sleeps).
 */
export async function playAudio(audioPath: string): Promise<void> {
    return new Promise((resolve) => {
        if (platform() === 'darwin') {
            // afplay blocks until done — perfect
            const p = spawn('afplay', [audioPath], { stdio: 'ignore' })
            p.on('close', resolve)
            p.on('error', () => resolve())

        } else if (platform() === 'win32') {
            // ffplay blocks until done (best option)
            const ff = spawn('ffplay', ['-nodisp', '-autoexit', audioPath], { stdio: 'ignore' })
            ff.on('close', resolve)
            ff.on('error', () => {
                // PowerShell fallback: get actual duration via ffprobe, wait that long
                // Instead of a fixed sleep, we poll $mp.NaturalDuration then sleep exactly that
                const psScript = [
                    `Add-Type -AssemblyName PresentationCore`,
                    `$mp = New-Object System.Windows.Media.MediaPlayer`,
                    `$mp.Open([uri]"file:///${audioPath.replace(/\\/g, '/').replace(/^\//, '')}")`,
                    `$mp.Play()`,
                    // Wait up to 3s for NaturalDuration to become available
                    `$waited = 0`,
                    `while (-not $mp.NaturalDuration.HasTimeSpan -and $waited -lt 30) { Start-Sleep -Milliseconds 100; $waited++ }`,
                    `if ($mp.NaturalDuration.HasTimeSpan) {`,
                    `  $ms = [int]$mp.NaturalDuration.TimeSpan.TotalMilliseconds + 300`,
                    `  Start-Sleep -Milliseconds $ms`,
                    `} else {`,
                    // NaturalDuration never resolved — use a longer safety timeout
                    `  Start-Sleep -Seconds 15`,
                    `}`,
                    `$mp.Close()`,
                ].join('; ')

                const ps = spawn('powershell', [
                    '-NoProfile', '-NonInteractive', '-Command', psScript,
                ], { stdio: 'ignore' })
                ps.on('close', resolve)
                ps.on('error', () => resolve())
            })

        } else {
            // Linux: aplay blocks until done for WAV; mpv --no-video also blocks
            const p = spawn('aplay', [audioPath], { stdio: 'ignore' })
            p.on('close', resolve)
            p.on('error', () => {
                const mpv = spawn('mpv', ['--no-video', audioPath], { stdio: 'ignore' })
                mpv.on('close', resolve)
                mpv.on('error', () => resolve())
            })
        }
    })
}

/**
 * Check if edge-tts is available
 */
export function isEdgeTTSAvailable(): boolean {
    try {
        execSync('python -m edge_tts --help', { encoding: 'utf-8', stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

/**
 * Install edge-tts if not available
 */
export async function installEdgeTTS(): Promise<boolean> {
    try {
        console.log('[VoiceOutput] Installing edge-tts...')
        execSync('pip install edge-tts', { encoding: 'utf-8', stdio: 'inherit' })
        return true
    } catch {
        return false
    }
}

/**
 * List available voices
 */
export async function listVoices(): Promise<string[]> {
    try {
        const output = execSync('python -m edge_tts --list-voices', { encoding: 'utf-8' })
        return output.split('\n').filter(l => l.includes('Neural'))
    } catch {
        return Object.values(VOICES)
    }
}

export default {
    speak,
    speakToBuffer,
    isEdgeTTSAvailable,
    installEdgeTTS,
    listVoices,
    VOICES,
}
