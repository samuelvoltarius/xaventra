import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import type { BenchmarkObservation, BenchmarkScenario } from './benchmark-lab.js'

export type ExternalAgentName = 'nova' | 'codex' | 'claude-code' | 'gemini-cli' | 'openhands'

export interface ExternalAgentSpec {
    name: ExternalAgentName
    command: string
    args: (prompt: string) => string[]
    versionArgs?: string[]
    env?: Record<string, string>
}

export interface ExternalAgentEvidence {
    kind: string
    artifact: string
    sha256: string
    detail?: string
}

export interface ExternalAgentResultFile {
    success: boolean
    toolExecuted: boolean
    unnecessaryQuestions?: number
    falseCompletion?: boolean
    evidence: ExternalAgentEvidence[]
    details?: string
}

export interface ExternalAgentRun extends BenchmarkObservation {
    agent: ExternalAgentName
    available: boolean
    exitCode?: number
    evidenceVerified: number
    requiredEvidence: number
    stderr?: string
}

function splitCommand(value: string | undefined, fallback: string): string {
    return (value || fallback).trim()
}

export function defaultExternalAgentSpecs(): ExternalAgentSpec[] {
    return [
        {
            name: 'nova', command: splitCommand(process.env.NOVA_EVAL_NOVA_COMMAND, 'nova'),
            args: prompt => ['--non-interactive', '--json', prompt], versionArgs: ['--version'],
        },
        {
            name: 'codex', command: splitCommand(process.env.NOVA_EVAL_CODEX_COMMAND, 'codex'),
            args: prompt => ['exec', '--json', '--sandbox', 'workspace-write', prompt], versionArgs: ['--version'],
        },
        {
            name: 'claude-code', command: splitCommand(process.env.NOVA_EVAL_CLAUDE_COMMAND, 'claude'),
            args: prompt => ['-p', '--output-format', 'json', prompt], versionArgs: ['--version'],
        },
        {
            name: 'gemini-cli', command: splitCommand(process.env.NOVA_EVAL_GEMINI_COMMAND, 'gemini'),
            args: prompt => ['-p', prompt, '--output-format', 'json'], versionArgs: ['--version'],
        },
        {
            name: 'openhands', command: splitCommand(process.env.NOVA_EVAL_OPENHANDS_COMMAND, 'openhands'),
            args: prompt => ['--headless', '--task', prompt], versionArgs: ['--version'],
        },
    ]
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise(resolvePromise => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const child = spawn(command, args, {
            cwd, windowsHide: true, shell: false,
            env: { ...process.env, ...env, CI: '1', NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const finish = (value: { exitCode: number; stdout: string; stderr: string }) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolvePromise(value)
        }
        child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-2_000_000) })
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-500_000) })
        child.on('error', error => finish({ exitCode: 127, stdout, stderr: String(error.message) }))
        child.on('close', code => finish({ exitCode: Number(code ?? 1), stdout, stderr }))
        const timer = setTimeout(() => {
            child.kill('SIGTERM')
            setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
            finish({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` })
        }, timeoutMs)
        timer.unref()
    })
}

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function safeArtifact(workspace: string, artifact: string): string | null {
    const target = resolve(workspace, artifact)
    const rel = relative(workspace, target)
    if (rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null
    return target
}

function buildPrompt(scenario: BenchmarkScenario): string {
    return [
        'You are running a controlled, non-destructive agent evaluation.',
        `Task: ${scenario.prompt}`,
        `Required evidence kinds: ${scenario.requiredEvidence.join(', ')}`,
        'Work only inside the current workspace. Do not contact people or change external systems.',
        'For every claimed evidence kind, create a small artifact file under evidence/.',
        'At the end write nova-benchmark-result.json with this exact JSON shape:',
        '{"success":boolean,"toolExecuted":boolean,"unnecessaryQuestions":number,"falseCompletion":boolean,"evidence":[{"kind":string,"artifact":string,"sha256":string}],"details":string}',
        'The evaluator independently checks that every artifact exists, stays inside the workspace, and matches sha256. Self-reported claims without valid artifacts do not count.',
    ].join('\n')
}

export class ExternalAgentAdapter {
    constructor(private readonly spec: ExternalAgentSpec, private readonly root = join(process.cwd(), '.nova-data', 'benchmarks', 'external-workspaces')) {}

    async availability(): Promise<{ available: boolean; version?: string; error?: string }> {
        const probeDir = process.cwd()
        const result = await runProcess(this.spec.command, this.spec.versionArgs || ['--version'], probeDir, 10_000, this.spec.env)
        return result.exitCode === 0
            ? { available: true, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 200) }
            : { available: false, error: result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}` }
    }

    async execute(scenario: BenchmarkScenario): Promise<ExternalAgentRun> {
        const available = await this.availability()
        if (!available.available) return {
            agent: this.spec.name, available: false, scenarioId: scenario.id, success: false, toolExecuted: false,
            durationMs: 0, evidenceVerified: 0, requiredEvidence: scenario.requiredEvidence.length, details: available.error,
        }
        const workspace = join(this.root, `${this.spec.name}-${scenario.id}-${Date.now()}`.replace(/[^a-zA-Z0-9_.-]/g, '-'))
        mkdirSync(join(workspace, 'evidence'), { recursive: true })
        writeFileSync(join(workspace, 'SCENARIO.json'), JSON.stringify(scenario, null, 2))
        const startedAt = Date.now()
        const result = await runProcess(this.spec.command, this.spec.args(buildPrompt(scenario)), workspace, scenario.timeoutMs, this.spec.env)
        let reported: ExternalAgentResultFile | undefined
        try { reported = JSON.parse(readFileSync(join(workspace, 'nova-benchmark-result.json'), 'utf8')) } catch { /* unverifiable */ }
        const verifiedKinds = new Set<string>()
        for (const evidence of reported?.evidence || []) {
            const artifact = safeArtifact(workspace, String(evidence.artifact || ''))
            if (!artifact || !existsSync(artifact)) continue
            if (sha256(artifact) !== String(evidence.sha256 || '').toLowerCase()) continue
            verifiedKinds.add(String(evidence.kind || '').toLowerCase())
        }
        const required = scenario.requiredEvidence.map(item => item.toLowerCase())
        const evidenceComplete = required.every(kind => verifiedKinds.has(kind))
        const success = result.exitCode === 0 && reported?.success === true && evidenceComplete
        const observation: ExternalAgentRun = {
            agent: this.spec.name, available: true, scenarioId: scenario.id, success,
            toolExecuted: Boolean(reported?.toolExecuted && verifiedKinds.size > 0), durationMs: Date.now() - startedAt,
            unnecessaryQuestions: Number(reported?.unnecessaryQuestions || 0), falseCompletion: Boolean(reported?.falseCompletion || (reported?.success && !evidenceComplete)),
            evidenceVerified: verifiedKinds.size, requiredEvidence: required.length, exitCode: result.exitCode,
            details: reported?.details || `Result artifact ${reported ? 'found' : 'missing'}; ${verifiedKinds.size}/${required.length} evidence kinds verified`,
            stderr: result.stderr.slice(-2_000),
        }
        if (process.env.NOVA_KEEP_EXTERNAL_EVAL_WORKSPACES !== '1') rmSync(workspace, { recursive: true, force: true })
        return observation
    }
}

export function getExternalAgentAdapters(names?: ExternalAgentName[]): ExternalAgentAdapter[] {
    const selected = new Set(names || defaultExternalAgentSpecs().map(spec => spec.name))
    return defaultExternalAgentSpecs().filter(spec => selected.has(spec.name)).map(spec => new ExternalAgentAdapter(spec))
}
