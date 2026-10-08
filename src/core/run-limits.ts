/**
 * 2.89: one source for how long and how many steps a normal agent run may take.
 *
 * Before 2.89 a Main without NOVA_OS_MODE ran with 3 tool rounds, 30 s per
 * tool and 300 s overall (context budget 4/12/24 calls) — multi-step tasks
 * („Heizung auf 21 Grad und sag mir dann die Temperatur“, „starte drei Helfer
 * parallel“) stopped half-done. The normal defaults below give real room;
 * NovaOS (NOVA_OS_MODE=true) keeps its larger values and stays the upper bound
 * of every default. Explicit NOVA_MAX_TOOL_ROUNDS / NOVA_AGENT_TIMEOUT_MS win.
 */

import { runtimeProfile } from './runtime-profile.js'

export type ToolTimeoutClass = 'default' | 'slow' | 'capture' | 'media' | 'browser'

export interface RunLimits {
    novaOs: boolean
    /** Model rounds that may call tools in one run. */
    maxToolRounds: number
    /** Whole agent run (pipeline deadline). */
    totalTimeoutMs: number
    /** Per tool call, by tool kind. */
    toolTimeoutMs: Readonly<Record<ToolTimeoutClass, number>>
}

const NORMAL: Omit<RunLimits, 'novaOs'> = {
    maxToolRounds: 15,
    totalTimeoutMs: 900_000,
    toolTimeoutMs: { default: 60_000, capture: 90_000, browser: 120_000, slow: 300_000, media: 300_000 },
}

const NOVA_OS: Omit<RunLimits, 'novaOs'> = {
    maxToolRounds: 50,
    totalTimeoutMs: 2_400_000,
    toolTimeoutMs: { default: 300_000, capture: 120_000, browser: 300_000, slow: 1_800_000, media: 900_000 },
}

function positive(value: string | undefined): number | undefined {
    const parsed = Number(value)
    return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function runLimits(env: NodeJS.ProcessEnv = process.env): RunLimits {
    const novaOs = runtimeProfile(env) === 'novaos'
    const base = novaOs ? NOVA_OS : NORMAL
    return {
        novaOs,
        maxToolRounds: positive(env.NOVA_MAX_TOOL_ROUNDS) ?? base.maxToolRounds,
        totalTimeoutMs: positive(env.NOVA_AGENT_TIMEOUT_MS) ?? base.totalTimeoutMs,
        toolTimeoutMs: base.toolTimeoutMs,
    }
}

// Installs, remote commands, deploys, helpers and missions take minutes.
const SLOW_TOOLS = new Set([
    'ssh_command', 'sshcommand', 'run_command', 'system_executor', 'codex_install', 'execute_python', 'code_runtime_run',
    'mesh_deploy', 'mesh_update', 'mesh_delegate', 'mesh_repo_task', 'pull_update', 'self_setup_apply', 'auto_provision',
    'research_all_capabilities', 'self_doctor', 'docker_control', 'spawn_subagent', 'spawn_subagents_parallel',
    'continuable_subagent_start', 'continuable_subagent_followup', 'start_mission', 'printer_slice', 'cad_generate', 'build_skill',
])
const CAPTURE_TOOLS = new Set(['desktop_screenshot', 'screenshot', 'check_ui', 'browse_url', 'mesh_screenshot', 'webcam_capture', 'screen_capture', 'screen_analyze', 'analyze_image'])
const MEDIA_TOOLS = new Set(['generate_image', 'minimax_image_gen', 'minimax_video_start', 'transcribe_audio', 'analyze_video', 'minimax_tts', 'speak'])

export function toolTimeoutClass(name: string): ToolTimeoutClass {
    if (MEDIA_TOOLS.has(name)) return 'media'
    if (CAPTURE_TOOLS.has(name)) return 'capture'
    if (SLOW_TOOLS.has(name)) return 'slow'
    if (name.startsWith('browser_')) return 'browser'
    return 'default'
}

export function toolTimeoutMs(name: string, limits: RunLimits = runLimits()): number {
    return limits.toolTimeoutMs[toolTimeoutClass(name)]
}

/** Honest German stop notice for a run that hit a limit, or '' for other errors. */
export function limitStopNotice(error: unknown, limits: RunLimits = runLimits()): string {
    const text = `${(error as { name?: string })?.name || ''} ${String((error as { message?: unknown })?.message ?? error ?? '')}`
    if (/MaxTurnsExceeded|max turns/i.test(text)) {
        return `Ich habe nach ${limits.maxToolRounds} Arbeitsschritten angehalten (Obergrenze erreicht) — die Aufgabe ist noch nicht fertig.`
    }
    const tool = text.match(/\[Timeout\] Tool: ([A-Za-z0-9_.-]+) exceeded (\d+)ms/)
    if (tool) return `Das Werkzeug ${tool[1]} hat länger als ${Math.round(Number(tool[2]) / 1000)} s gebraucht und wurde abgebrochen — die Aufgabe ist noch nicht fertig.`
    if (/deadline exceeded|timeout budget|Task execution deadline/i.test(text)) {
        return 'Die Zeitgrenze für diese Aufgabe ist abgelaufen — sie ist noch nicht fertig.'
    }
    if (/Capability gap/i.test(text)) {
        return 'Für einen Teil dieser Aufgabe habe ich kein passendes Werkzeug — ich habe ihn nicht weiter mit Behelfen versucht.'
    }
    if (/tool-call budget exhausted/i.test(text)) {
        return 'Die erlaubte Anzahl an Werkzeugaufrufen für diese Aufgabe ist aufgebraucht — sie ist noch nicht fertig.'
    }
    return ''
}
