/**
 * Environment Scanner
 * 
 * Scans system for available binaries (Python, Pip, Node, etc.)
 * at startup and stores their paths for reliable tool execution.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface EnvironmentMap {
    python?: string
    pip?: string
    node?: string
    npm?: string
    edge_tts?: string
    curl?: string
    git?: string
    powershell?: string
    // System tools
    ffmpeg?: string
    ffplay?: string
    // Package managers
    winget?: string
    choco?: string
    scoop?: string
    brew?: string
    apt?: string
    // Grafik / Browser / Audio — ohne diese Erkennung haelt Nova sich auf
    // einem headless System faelschlich fuer browser- und desktopfaehig,
    // ruft browser_*/desktop_* auf und laeuft in Fehler.
    browser?: string
    playwright_browsers?: string
    display?: string
    audio?: string
}

// Global environment map
let ENV_MAP: EnvironmentMap = {}
let lastScanAt = 0
let scanInFlight: Promise<EnvironmentMap> | null = null
const ENVIRONMENT_CACHE_TTL_MS = 5 * 60_000

// ============================================
// Scanner
// ============================================

/**
 * Find a binary in PATH or common locations
 */
function findBinary(names: string[], commonPaths: string[] = []): string | undefined {
    // Try 'where' on Windows, 'which' on Unix
    const isWindows = process.platform === 'win32'
    const whichCmd = isWindows ? 'where' : 'which'

    for (const name of names) {
        try {
            const result = execSync(`${whichCmd} ${name}`, {
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']  // Suppress stderr
            }).trim()

            // 'where' returns multiple lines on Windows, take first
            const path = result.split('\n')[0].trim()
            if (path && existsSync(path)) {
                return path
            }
        } catch {
            // Binary not in PATH
        }
    }

    // Check common paths
    for (const path of commonPaths) {
        if (existsSync(path)) {
            return path
        }
    }

    return undefined
}

/**
 * Scan system for available binaries
 */
async function performEnvironmentScan(): Promise<EnvironmentMap> {
    console.log('[EnvScanner] Scanning environment...')
    const startTime = Date.now()

    const map: EnvironmentMap = {}

    // Python
    map.python = findBinary(['python', 'python3', 'py'], [
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
        '/usr/bin/python3',
        '/usr/local/bin/python3'
    ])

    // Pip
    map.pip = findBinary(['pip', 'pip3'], [
        'C:\\Python311\\Scripts\\pip.exe',
        '/usr/bin/pip3',
        '/usr/local/bin/pip3'
    ])

    // Node
    map.node = findBinary(['node'], [
        'C:\\Program Files\\nodejs\\node.exe',
        '/usr/bin/node',
        '/usr/local/bin/node'
    ])

    // npm
    map.npm = findBinary(['npm'], [
        'C:\\Program Files\\nodejs\\npm.cmd',
        '/usr/bin/npm',
        '/usr/local/bin/npm'
    ])

    // edge-tts (Python module)
    if (map.python) {
        try {
            execSync(`"${map.python}" -m edge_tts --version`, {
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            })
            map.edge_tts = `"${map.python}" -m edge_tts`
        } catch {
            // edge-tts not installed
        }
    }

    // curl
    map.curl = findBinary(['curl'], [
        'C:\\Windows\\System32\\curl.exe',
        '/usr/bin/curl'
    ])

    // git
    map.git = findBinary(['git'], [
        'C:\\Program Files\\Git\\bin\\git.exe',
        '/usr/bin/git'
    ])

    // PowerShell
    map.powershell = findBinary(['powershell', 'pwsh'], [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        '/usr/bin/pwsh'
    ])

    // FFmpeg / FFplay (audio/video processing — required for voice playback on Windows)
    // Resolve per-user installations from the current home directory.
    const home = homedir()
    map.ffmpeg = findBinary(['ffmpeg'], [
        'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
        join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffmpeg.exe'),
        join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-7.1-full_build', 'bin', 'ffmpeg.exe'),
        '/usr/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
    ])
    map.ffplay = findBinary(['ffplay'], [
        'C:\\ProgramData\\chocolatey\\bin\\ffplay.exe',
        join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', 'ffplay.exe'),
        '/usr/bin/ffplay',
        '/usr/local/bin/ffplay',
    ])

    // Package managers (used for self-installing system tools)
    map.winget = findBinary(['winget'], [
        join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'winget.exe'),
    ])
    map.choco = findBinary(['choco', 'chocolatey'], [
        'C:\\ProgramData\\chocolatey\\bin\\choco.exe',
    ])
    map.scoop = findBinary(['scoop'], [])
    map.brew = findBinary(['brew'], ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'])
    map.apt = findBinary(['apt-get'], ['/usr/bin/apt-get'])

    // ── Grafik, Browser, Audio ────────────────────────────────────────
    // Ein headless Server hat nichts davon. Ohne diese Erkennung glaubt
    // Nova, sie koenne browser_*/desktop_* nutzen, und scheitert daran.
    map.browser = findBinary(
        ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'firefox'],
        ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/firefox'],
    )

    // Playwright legt seine Browser unter ~/.cache/ms-playwright ab
    try {
        const { existsSync, readdirSync } = await import('node:fs')
        const pwDir = join(homedir(), '.cache', 'ms-playwright')
        if (existsSync(pwDir) && readdirSync(pwDir).some(d => /chromium|firefox|webkit/i.test(d))) {
            map.playwright_browsers = pwDir
        }
    } catch { /* nicht vorhanden */ }

    // Grafische Oberflaeche: DISPLAY/WAYLAND oder ein X-Binary
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        map.display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY
    } else {
        const xserver = findBinary(['Xorg', 'Xwayland'], ['/usr/bin/Xorg', '/usr/lib/xorg/Xorg'])
        if (xserver) map.display = `${xserver} (installiert, nicht gestartet)`
    }

    // Audio-Ausgabe
    map.audio = findBinary(['aplay', 'pactl', 'pw-play'], ['/usr/bin/aplay', '/usr/bin/pactl'])

    const elapsed = Date.now() - startTime
    const found = Object.entries(map).filter(([, v]) => v).length
    console.log(`[EnvScanner] ✅ Found ${found} binaries in ${elapsed}ms`)

    // Log what was found
    for (const [name, path] of Object.entries(map)) {
        if (path) {
            console.log(`[EnvScanner]   ${name}: ${path}`)
        }
    }

    ENV_MAP = map
    lastScanAt = Date.now()
    return map
}

/**
 * Environment discovery is shared by boot, Doctor and Self-Setup. Coalesce
 * concurrent callers and reuse the verified map for five minutes so startup
 * never executes the same `which`/version probes twice.
 */
export async function scanEnvironment(forceFresh = false): Promise<EnvironmentMap> {
    if (!forceFresh && lastScanAt > 0 && Date.now() - lastScanAt < ENVIRONMENT_CACHE_TTL_MS) {
        return { ...ENV_MAP }
    }
    if (scanInFlight) return scanInFlight
    scanInFlight = performEnvironmentScan()
    try {
        return await scanInFlight
    } finally {
        scanInFlight = null
    }
}

/**
 * Get the current environment map
 */
export function getEnvironmentMap(): EnvironmentMap {
    return ENV_MAP
}

/**
 * Get path for a specific binary
 */
export function getBinaryPath(name: keyof EnvironmentMap): string | undefined {
    return ENV_MAP[name]
}

/**
 * Check if a binary is available
 */
export function hasBinary(name: keyof EnvironmentMap): boolean {
    return !!ENV_MAP[name]
}

export default {
    scanEnvironment,
    getEnvironmentMap,
    getBinaryPath,
    hasBinary
}
