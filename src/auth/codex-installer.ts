import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { findCodexBinary, probeCodexCli, resolveCodexCommand } from '../llm/codex-cli-adapter.js'
import { getLocalCodexNodeId } from './codex-app-server.js'
import { sideEffectsDisabled } from '../core/side-effects.js'

const execFileAsync = promisify(execFile)
const INSTALLER_URL = 'https://chatgpt.com/codex/install.sh'

export interface CodexInstallResult {
    success: boolean
    nodeId: string
    installed: boolean
    alreadyInstalled?: boolean
    binary?: string
    version?: string
    message: string
}

export interface CodexInstallerDependencies {
    fetch: typeof fetch
    runFile: (file: string, args: string[], options: Record<string, unknown>) => Promise<{ stdout?: string; stderr?: string }>
    probe: (timeoutMs?: number) => Promise<boolean>
    findBinary: () => string | null
    allowSideEffectsInTests?: boolean
    platform?: NodeJS.Platform
}

function normalized(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function isExplicitCodexInstallRequest(requestText: string): boolean {
    const text = requestText.trim().toLowerCase()
    return /\b(?:installier(?:e|en)?|install|einricht(?:en|e)?|setup)\b[\s\S]{0,80}\bcodex\b/.test(text)
        || /\bcodex\b[\s\S]{0,80}\b(?:installier(?:e|en)?|install|einricht(?:en|e)?|setup)\b/.test(text)
}

export function extractCodexInstallTarget(requestText: string): string | undefined {
    const text = requestText.trim()
    if (/\b(?:auf|on)\s+(?:dem\s+)?(?:aktuellen|current)\s+main\b/i.test(text)) return 'current'
    const match = text.match(/\b(?:auf|am|on)\s+(?:dem\s+|den\s+|der\s+)?([a-z0-9][a-z0-9._-]*)\b/i)
    return match?.[1]
}

export function isLocalCodexInstallTarget(
    targetNode: string | undefined,
    nodeId = getLocalCodexNodeId(),
    host = hostname(),
    extraAliases: string[] = [],
): boolean {
    const target = normalized(targetNode || 'current')
    if (['current', 'local', 'hier', 'main', 'diesem-node', 'aktuellen-main'].includes(target)) return true
    const aliases = new Set([normalized(nodeId), normalized(host), ...extraAliases.map(normalized)])
    if (normalized(nodeId).startsWith('nova-')) aliases.add(normalized(nodeId).slice(5))
    if (normalized(nodeId).includes('spark')) aliases.add('spark')
    if (normalized(host).includes('gx10')) aliases.add('gpu-main')
    return aliases.has(target)
}

export function getCodexRuntimeInstallPaths(platformName: NodeJS.Platform = process.platform): { root: string; binDir: string; binary: string; installerHome: string } {
    const dataRoot = process.env.NOVA_DATA_DIR?.trim() || join(process.cwd(), '.nova-data')
    const root = process.env.NOVA_CODEX_RUNTIME_ROOT?.trim() || join(dataRoot, 'codex-runtime')
    const binDir = join(root, 'bin')
    return {
        root,
        binDir,
        binary: join(binDir, platformName === 'win32' ? 'codex.exe' : 'codex'),
        installerHome: join(root, 'installer-home'),
    }
}

function validateInstallerScript(script: string): void {
    if (script.length < 500 || script.length > 1_000_000) throw new Error('Codex-Installer hat eine unerwartete Größe')
    if (!/^#!\/(?:(?:usr\/bin\/env\s+)(?:ba)?sh|bin\/(?:ba)?sh)/m.test(script)) throw new Error('Codex-Installer ist kein Shell-Skript')
    if (!script.includes('CODEX_INSTALL_DIR') || !/codex/i.test(script)) {
        throw new Error('Codex-Installer enthält nicht den erwarteten Installationsvertrag')
    }
}

export async function installCodexOnLocalNode(
    request: { targetNode?: string; requestText: string },
    dependencies: Partial<CodexInstallerDependencies> = {},
): Promise<CodexInstallResult> {
    const nodeId = getLocalCodexNodeId()
    if (!isExplicitCodexInstallRequest(request.requestText)) {
        return {
            success: false, nodeId, installed: false,
            message: 'Codex-Installation abgelehnt: Der Benutzer hat die Installation nicht ausdrücklich angefordert.',
        }
    }
    let capabilityAliases: string[] = []
    try {
        const { getCapabilityGraph } = await import('../mesh/capability-graph.js')
        const node = getCapabilityGraph().getSnapshot().nodes.find(candidate => candidate.id === nodeId)
        capabilityAliases = node ? [node.hostname] : []
    } catch { /* bootstrap before capability graph */ }
    if (!isLocalCodexInstallTarget(request.targetNode, nodeId, hostname(), capabilityAliases)) {
        return {
            success: false, nodeId, installed: false,
            message: `Codex-Installation fail-closed: Ziel ${request.targetNode || 'unbekannt'} ist nicht der lokale Node ${nodeId}. Der Auftrag muss auf dem Ziel-Node ausgeführt werden.`,
        }
    }
    const platformName = dependencies.platform || process.platform
    if (platformName !== 'linux') {
        return {
            success: false, nodeId, installed: false,
            message: `Der sichere automatische Codex-Installer ist derzeit nur für Linux-Nodes freigegeben (${nodeId} läuft auf ${platformName}).`,
        }
    }
    if (sideEffectsDisabled() && !dependencies.allowSideEffectsInTests) {
        return { success: false, nodeId, installed: false, message: 'Codex-Installation ist in diesem isolierten Lauf deaktiviert.' }
    }

    const deps: CodexInstallerDependencies = {
        fetch: dependencies.fetch || fetch,
        runFile: dependencies.runFile || (async (file, args, options) => {
            const result = await execFileAsync(file, args, options as any)
            return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
        }),
        probe: dependencies.probe || probeCodexCli,
        findBinary: dependencies.findBinary || findCodexBinary,
        allowSideEffectsInTests: dependencies.allowSideEffectsInTests,
        platform: platformName,
    }
    const existing = deps.findBinary()
    if (existing && await deps.probe(10_000)) {
        return {
            success: true, nodeId, installed: true, alreadyInstalled: true, binary: existing,
            message: `Codex ist auf ${nodeId} bereits installiert. Nächster Schritt: /codex login`,
        }
    }

    const paths = getCodexRuntimeInstallPaths(platformName)
    mkdirSync(paths.root, { recursive: true, mode: 0o700 })
    mkdirSync(paths.binDir, { recursive: true, mode: 0o700 })
    mkdirSync(paths.installerHome, { recursive: true, mode: 0o700 })
    const installerPath = join(paths.root, `install-${randomUUID()}.sh`)

    try {
        const response = await deps.fetch(INSTALLER_URL, {
            redirect: 'follow',
            signal: AbortSignal.timeout(30_000),
            headers: { 'User-Agent': 'Nova-Codex-Installer/1' },
        })
        if (!response.ok) throw new Error(`offizieller Installer antwortete mit HTTP ${response.status}`)
        const script = await response.text()
        validateInstallerScript(script)
        writeFileSync(installerPath, script, { mode: 0o700 })
        chmodSync(installerPath, 0o700)

        await deps.runFile('sh', [installerPath], {
            cwd: paths.root,
            encoding: 'utf8',
            timeout: 300_000,
            windowsHide: true,
            maxBuffer: 10 * 1024 * 1024,
            env: {
                ...process.env,
                CODEX_NON_INTERACTIVE: '1',
                CODEX_INSTALL_DIR: paths.binDir,
                CODEX_HOME: paths.installerHome,
            },
        })
        process.env.NOVA_CODEX_BIN = paths.binary
        const binary = deps.findBinary() || (existsSync(paths.binary) ? paths.binary : null)
        if (!binary || !await deps.probe(15_000)) throw new Error('codex --version bestand die Verifikation nicht')
        const invocation = resolveCodexCommand(binary, ['--version'])
        const versionResult = await deps.runFile(invocation.command, invocation.args, {
            encoding: 'utf8', timeout: 15_000, windowsHide: true,
        })
        const version = String(versionResult.stdout || '').trim().slice(0, 200)
        return {
            success: true,
            nodeId,
            installed: true,
            binary,
            version,
            message: `Codex wurde auf ${nodeId} persistent installiert und verifiziert${version ? ` (${version})` : ''}. Nächster Schritt: /codex login`,
        }
    } catch (error) {
        return {
            success: false,
            nodeId,
            installed: false,
            message: `Codex-Installation auf ${nodeId} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
        }
    } finally {
        try { if (existsSync(installerPath)) unlinkSync(installerPath) } catch { /* cleanup best effort */ }
    }
}
