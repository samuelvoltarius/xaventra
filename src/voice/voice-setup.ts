/**
 * Voice Self-Setup
 *
 * Nova versteht was sie für Voice braucht, warum, und wie sie es bekommt.
 * Installiert alle fehlenden Abhängigkeiten selbstständig — Python-Pakete
 * UND System-Tools (ffmpeg etc.) über den verfügbaren Package-Manager.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

interface PythonDep {
    name: string
    importName: string       // Python import name zum Testen
    pipPackage: string       // pip install name
    why: string              // Warum braucht Nova das?
    optional: boolean
    windowsFallback?: string // Alternatives Paket wenn pip install fehlschlägt
}

interface SystemDep {
    name: string
    binary: string           // Binary-Name zum Testen (ffplay, ffmpeg, ...)
    why: string              // Warum braucht Nova das?
    optional: boolean
    install: {               // Wie installieren — pro Package-Manager
        winget?: string
        choco?: string
        scoop?: string
        brew?: string
        apt?: string
        manual?: string      // Fallback-Hinweis wenn nichts klappt
    }
}

export interface SetupResult {
    ok: boolean
    installed: string[]
    failed: string[]
    skipped: string[]
    warnings: string[]
}

export interface VoiceDepsOptions {
    installMissing?: boolean
}

// ============================================
// Was Nova für Voice braucht — und warum
// ============================================

const PYTHON_DEPS: PythonDep[] = [
    {
        name: 'edge-tts',
        importName: 'edge_tts',
        pipPackage: 'edge-tts',
        why: 'Text-to-Speech — damit ich antworten kann (kostenlos, Microsoft Neural Voices)',
        optional: false,
    },
    {
        name: 'faster-whisper',
        importName: 'faster_whisper',
        pipPackage: 'faster-whisper',
        why: 'Speech-to-Text — damit ich verstehe was du sagst (8x schneller als OpenAI Whisper, nutzt GPU)',
        optional: false,
    },
    {
        name: 'PyAudio',
        importName: 'pyaudio',
        pipPackage: 'pyaudio',
        why: 'Mikrofon-Zugriff — damit ich kontinuierlich auf das Wake-Word lauschen kann',
        optional: true,
        windowsFallback: 'pipwin',  // pyaudio hat auf Windows oft Build-Probleme → pipwin als Hilfe
    },
    {
        name: 'SoundDevice',
        importName: 'sounddevice',
        pipPackage: 'sounddevice',
        why: 'Mikrofon-Zugriff als robuster Windows-Fallback wenn PyAudio nicht gebaut werden kann',
        optional: false,
    },
    {
        name: 'NumPy',
        importName: 'numpy',
        pipPackage: 'numpy',
        why: 'Audio-Signal-Verarbeitung — für Wake-Word-Erkennung und Energie-Berechnung',
        optional: false,
    },
    {
        name: 'OpenWakeWord',
        importName: 'openwakeword',
        pipPackage: 'openwakeword',
        why: 'Offline Wake-Word-Erkennung ("hey nova") — ohne Cloud, ohne Latenz',
        optional: true,  // Fallback: Energy-basierte Erkennung
    },
]

const SYSTEM_DEPS: SystemDep[] = [
    {
        name: 'ffmpeg',
        binary: 'ffplay',
        why: 'Audio-Playback auf Windows — ffplay ist der beste Player, Nova kann aber auf PowerShell-Playback zurückfallen.',
        optional: true,
        install: {
            winget: 'winget install --id Gyan.FFmpeg --source winget --accept-package-agreements --accept-source-agreements',
            choco: 'choco install ffmpeg -y',
            scoop: 'scoop install ffmpeg',
            brew: 'brew install ffmpeg',
            apt: 'apt-get install -y ffmpeg',
            manual: 'https://www.gyan.dev/ffmpeg/builds/ → ffmpeg-release-essentials.zip entpacken und zum PATH hinzufügen',
        },
    },
]

// ============================================
// Helpers — Python
// ============================================

function findPython(): string {
    const candidates = platform() === 'win32'
        ? ['python', 'py', 'python3']
        : ['python3', 'python']

    for (const bin of candidates) {
        const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
        if (r.status === 0) return bin
    }

    for (const bin of commonBinaryPaths('python')) {
        const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
        if (r.status === 0) return bin
    }

    throw new Error('Python nicht gefunden')
}

function findPip(python: string): string {
    const r = spawnSync(python, ['-m', 'pip', '--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
    if (r.status === 0) return `${python} -m pip`

    const pip = platform() === 'win32' ? 'pip' : 'pip3'
    const r2 = spawnSync(pip, ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
    if (r2.status === 0) return pip

    throw new Error('pip nicht gefunden')
}

function isImportable(python: string, importName: string): boolean {
    const r = spawnSync(python, ['-c', `import ${importName}`], {
        encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
    })
    return r.status === 0
}

function pipRun(pip: string, args: string[]): boolean {
    const [cmd, ...pipArgs] = pip.split(' ')
    const r = spawnSync(cmd, [...pipArgs, ...args], {
        encoding: 'utf-8', timeout: 180_000, stdio: 'inherit',
    })
    return r.status === 0
}

function pipInstall(pip: string, pkg: string): boolean {
    return pipRun(pip, ['install', pkg, '--quiet'])
}

// ============================================
// Helpers — System
// ============================================

function isBinaryAvailable(bin: string): boolean {
    const cmd = platform() === 'win32' ? 'where' : 'which'
    const r = spawnSync(cmd, [bin], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' })
    if (r.status === 0) return true

    return commonBinaryPaths(bin).some(path => existsSync(path))
}

function detectPackageManager(): string | null {
    // Reihenfolge: winget (built-in Win11) → choco → scoop → brew → apt
    const managers = platform() === 'win32'
        ? ['winget', 'choco', 'scoop']
        : platform() === 'darwin'
            ? ['brew']
            : ['apt-get', 'apt']

    for (const mgr of managers) {
        if (isBinaryAvailable(mgr)) return mgr
    }
    return null
}

function sysInstall(dep: SystemDep, mgr: string): boolean {
    const cmdMap: Record<string, string | undefined> = {
        winget: dep.install.winget,
        choco: dep.install.choco,
        scoop: dep.install.scoop,
        brew: dep.install.brew,
        'apt-get': dep.install.apt,
        apt: dep.install.apt,
    }

    const cmd = cmdMap[mgr]
    if (!cmd) return false

    console.log(`[VoiceSetup] 📦 ${dep.name} via ${mgr}: ${cmd}`)
    try {
        const r = spawnSync(cmd, { shell: true, encoding: 'utf-8', timeout: 300_000, stdio: 'inherit' })
        return r.status === 0
    } catch {
        return false
    }
}

function commonBinaryPaths(bin: string): string[] {
    const home = homedir()
    if (platform() === 'win32') {
        const pythonBase = join(home, 'AppData', 'Local', 'Python', 'bin')
        const windowsApps = join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps')
        const scoopFfmpeg = join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin')
        const wingetFfmpeg = join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-7.1-full_build', 'bin')

        const map: Record<string, string[]> = {
            python: [
                join(pythonBase, 'python.exe'),
                'C:\\Python312\\python.exe',
                'C:\\Python311\\python.exe',
                'C:\\Python310\\python.exe',
                join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
                join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
            ],
            python3: [
                join(pythonBase, 'python.exe'),
            ],
            py: [
                join(windowsApps, 'py.exe'),
            ],
            pip: [
                join(pythonBase, 'Scripts', 'pip.exe'),
                'C:\\Python312\\Scripts\\pip.exe',
                'C:\\Python311\\Scripts\\pip.exe',
            ],
            ffmpeg: [
                'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
                join(scoopFfmpeg, 'ffmpeg.exe'),
                join(wingetFfmpeg, 'ffmpeg.exe'),
            ],
            ffplay: [
                'C:\\ProgramData\\chocolatey\\bin\\ffplay.exe',
                join(scoopFfmpeg, 'ffplay.exe'),
                join(wingetFfmpeg, 'ffplay.exe'),
            ],
            winget: [
                join(windowsApps, 'winget.exe'),
            ],
            choco: [
                'C:\\ProgramData\\chocolatey\\bin\\choco.exe',
            ],
            scoop: [
                join(home, 'scoop', 'shims', 'scoop.cmd'),
            ],
        }
        return map[bin] ?? []
    }

    const unixMap: Record<string, string[]> = {
        python3: ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'],
        python: ['/usr/bin/python', '/usr/local/bin/python'],
        ffmpeg: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
        ffplay: ['/usr/bin/ffplay', '/usr/local/bin/ffplay', '/opt/homebrew/bin/ffplay'],
        brew: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
        apt: ['/usr/bin/apt'],
        'apt-get': ['/usr/bin/apt-get'],
    }
    return unixMap[bin] ?? []
}

// ============================================
// Main Setup
// ============================================

/**
 * Nova prüft und installiert alle Voice-Abhängigkeiten selbstständig.
 * Wird beim Start automatisch aufgerufen wenn voice.enabled = true.
 */
export async function ensureVoiceDeps(options: VoiceDepsOptions = {}): Promise<SetupResult> {
    const installMissing = options.installMissing === true
    if (!installMissing) console.log('[VoiceSetup] Check-only mode - fehlende Pakete werden beim Boot nicht installiert')
    console.log('[VoiceSetup] 🔍 Analysiere was ich für Voice brauche...')

    const result: SetupResult = { ok: true, installed: [], failed: [], skipped: [], warnings: [] }

    // ---- System-Abhängigkeiten ----
    const pkgMgr = detectPackageManager()
    console.log(`[VoiceSetup] Package-Manager: ${pkgMgr ?? 'keiner gefunden'}`)

    for (const dep of SYSTEM_DEPS) {
        if (isBinaryAvailable(dep.binary)) {
            console.log(`[VoiceSetup] ✓ ${dep.name} (${dep.binary})`)
            continue
        }

        console.log(`[VoiceSetup] ⚠ ${dep.name} fehlt`)
        console.log(`[VoiceSetup]   Warum: ${dep.why}`)

        if (!pkgMgr) {
            const warn = `${dep.name}: kein Package-Manager verfügbar. Manuell: ${dep.install.manual}`
            console.log(`[VoiceSetup] ⚠ ${warn}`)
            result.warnings.push(warn)
            if (!dep.optional) {
                result.failed.push(dep.name)
                result.ok = false
            }
            continue
        }

        console.log(`[VoiceSetup] 🔧 Installiere ${dep.name} via ${pkgMgr}...`)
        if (!installMissing) {
            const warn = `${dep.name} fehlt. Installation uebersprungen (check-only). Manuell: ${dep.install.manual}`
            console.log(`[VoiceSetup] ${warn}`)
            result.warnings.push(warn)
            result.skipped.push(dep.name)
            if (!dep.optional) {
                result.failed.push(dep.name)
                result.ok = false
            }
            continue
        }

        const success = sysInstall(dep, pkgMgr)

        if (success && isBinaryAvailable(dep.binary)) {
            console.log(`[VoiceSetup] ✅ ${dep.name} installiert`)
            result.installed.push(dep.name)
        } else if (dep.optional) {
            result.skipped.push(dep.name)
            result.warnings.push(`${dep.name} nicht installiert — PowerShell-Fallback aktiv`)
        } else {
            console.error(`[VoiceSetup] ❌ ${dep.name} Installation fehlgeschlagen`)
            console.log(`[VoiceSetup]   Manuell: ${dep.install.manual}`)
            result.failed.push(dep.name)
            result.ok = false
        }
    }

    // ---- Python-Abhängigkeiten ----
    let python: string
    let pip: string
    try {
        python = findPython()
        pip = findPip(python)
        console.log(`[VoiceSetup] ✓ Python: ${python}`)
    } catch (err) {
        console.error(`[VoiceSetup] ❌ ${err}`)
        result.ok = false
        result.failed.push('Python/pip')
        return result
    }

    for (const dep of PYTHON_DEPS) {
        if (isImportable(python, dep.importName)) {
            console.log(`[VoiceSetup] ✓ ${dep.name}`)
            continue
        }

        console.log(`[VoiceSetup] ⚠ ${dep.name} fehlt`)
        console.log(`[VoiceSetup]   Warum: ${dep.why}`)
        console.log(`[VoiceSetup] 🔧 pip install ${dep.pipPackage}...`)

        if (!installMissing) {
            console.log(`[VoiceSetup] ${dep.name} Installation uebersprungen (check-only). Paket: ${dep.pipPackage}`)
            result.skipped.push(dep.name)
            if (!dep.optional) {
                result.failed.push(dep.name)
                result.ok = false
            }
            continue
        }

        let success = pipInstall(pip, dep.pipPackage)

        // PyAudio Windows-Fallback: erst pipwin installieren, dann damit pyaudio
        if (!success && platform() === 'win32' && dep.windowsFallback) {
            console.log(`[VoiceSetup] Versuche Windows-Fallback (${dep.windowsFallback})...`)
            pipInstall(pip, dep.windowsFallback)
            success = pipRun(pip, ['-m', dep.windowsFallback, 'install', dep.importName])
            // Letzter Versuch: direkter pip mit vorinstalliertem Build-Tool
            if (!success) success = pipInstall(pip, dep.pipPackage)
        }

        if (success && isImportable(python, dep.importName)) {
            console.log(`[VoiceSetup] ✅ ${dep.name} installiert`)
            result.installed.push(dep.name)
        } else if (dep.optional) {
            console.log(`[VoiceSetup] ⚠ ${dep.name} optional — übersprungen`)
            result.skipped.push(dep.name)
        } else {
            console.error(`[VoiceSetup] ❌ ${dep.name} konnte nicht installiert werden`)
            result.failed.push(dep.name)
            result.ok = false
        }
    }

    // Summary
    if (result.installed.length > 0)
        console.log(`[VoiceSetup] ✅ Installiert: ${result.installed.join(', ')}`)
    if (result.skipped.length > 0)
        console.log(`[VoiceSetup] ⏭ Übersprungen: ${result.skipped.join(', ')}`)
    if (result.failed.length > 0)
        console.error(`[VoiceSetup] ❌ Fehlgeschlagen: ${result.failed.join(', ')}`)
    if (result.ok)
        console.log('[VoiceSetup] ✅ Voice-Setup abgeschlossen')

    return result
}

export default { ensureVoiceDeps }
