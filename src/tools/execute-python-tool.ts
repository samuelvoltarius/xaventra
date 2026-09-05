/**
 * Execute Python Tool
 *
 * Allows Nova to run Python scripts directly on the system.
 * Supports inline code execution and running existing .py files.
 * Output is captured and returned to the LLM.
 */

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const SCRIPTS_DIR = join(process.cwd(), '.nova-data', 'scripts')
const TIMEOUT_MS = 60_000  // 60 seconds max

// Find Python executable
function findPython(): string {
    const candidates = [
        process.env.PYTHON_PATH || '',
        join(homedir(), 'AppData', 'Local', 'Python', 'bin', 'python.exe'),
        join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'bin', 'python.exe'),
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
        'python3',
        'python',
    ]
    for (const p of candidates) {
        if (!p) continue
        if ((isAbsolute(p) || p.includes('\\')) && !existsSync(p)) continue
        return p
    }
    return 'python'
}

async function runPython(pythonPath: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
        const proc = spawn(pythonPath, args, { timeout: TIMEOUT_MS })
        let stdout = ''
        let stderr = ''

        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

        const timer = setTimeout(() => {
            proc.kill()
            resolve({ stdout, stderr: stderr + '\n[TIMEOUT after 60s]', exitCode: -1 })
        }, TIMEOUT_MS)

        proc.on('close', (code) => {
            clearTimeout(timer)
            resolve({ stdout, stderr, exitCode: code ?? 0 })
        })

        proc.on('error', (err) => {
            clearTimeout(timer)
            resolve({ stdout, stderr: String(err), exitCode: -1 })
        })
    })
}

export async function executeExecutePython(params: Record<string, unknown>): Promise<string> {
    const code = params.code as string | undefined
    const filePath = params.file as string | undefined
    const installPackages = params.install as string | undefined

    const python = findPython()

    // Optional: install packages first
    if (installPackages) {
        const packages = installPackages.split(',').map(p => p.trim()).filter(Boolean)
        console.log(`[Python] 📦 Installing: ${packages.join(', ')}`)
        const installResult = await runPython(python, ['-m', 'pip', 'install', '--quiet', ...packages])
        if (installResult.exitCode !== 0 && installResult.stderr) {
            console.log(`[Python] pip stderr: ${installResult.stderr.slice(0, 200)}`)
        }
    }

    let scriptPath = ''
    let tempFile = false

    if (filePath) {
        // Run existing file
        if (!existsSync(filePath)) return `❌ Datei nicht gefunden: ${filePath}`
        scriptPath = filePath
    } else if (code) {
        // Write inline code to temp file
        if (!existsSync(SCRIPTS_DIR)) mkdirSync(SCRIPTS_DIR, { recursive: true })
        scriptPath = join(SCRIPTS_DIR, `nova_script_${Date.now()}.py`)
        writeFileSync(scriptPath, code, 'utf-8')
        tempFile = true
    } else {
        return '❌ Entweder `code` (Python-Code als String) oder `file` (Pfad zu .py Datei) ist erforderlich.'
    }

    console.log(`[Python] 🐍 Running: ${scriptPath}`)

    try {
        const result = await runPython(python, [scriptPath])

        const output = [
            result.stdout ? `📤 Output:\n${result.stdout.trim()}` : '',
            result.stderr ? `⚠️ Stderr:\n${result.stderr.trim().slice(0, 500)}` : '',
            result.exitCode !== 0 ? `❌ Exit Code: ${result.exitCode}` : '✅ Erfolgreich ausgeführt',
        ].filter(Boolean).join('\n\n')

        console.log(`[Python] Exit: ${result.exitCode}, stdout: ${result.stdout.length} chars`)
        return output || '✅ Script ausgeführt (keine Ausgabe)'
    } finally {
        if (tempFile && existsSync(scriptPath)) {
            try { unlinkSync(scriptPath) } catch { /* ignore */ }
        }
    }
}
