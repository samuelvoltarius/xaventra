import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LifecyclePolicy } from '../core/lifecycle-policy.js'
import { MissionWorkspaceManager } from '../runtime/mission-workspace.js'
import { BlueTeamService } from './blue-team.js'
import { evaluatePluginTrust } from '../plugins/plugin-security.js'

export interface ChaosCheck { id: string; passed: boolean; detail: string }
export interface ChaosAssuranceReport { createdAt: string; passed: boolean; checks: ChaosCheck[] }

// macOS may report /private/var/... for a workspace created through /var/....
// Compare filesystem identity, not path spelling. This checks cwd only; it is
// not evidence that a temporary workspace confines arbitrary filesystem access.
export function isExpectedWorkingDirectory(expected: string, actual: string): boolean {
    try {
        return realpathSync.native(expected) === realpathSync.native(actual) && statSync(actual).isDirectory()
    } catch {
        return false
    }
}

export async function runChaosAssurance(): Promise<ChaosAssuranceReport> {
    const root = mkdtempSync(join(tmpdir(), 'nova-chaos-'))
    const checks: ChaosCheck[] = []
    try {
        const policy = new LifecyclePolicy(join(root, 'lifecycle.jsonl'))
        policy.register({ id: 'chaos-failure', event: 'tool.before', failClosed: true, handler: () => { throw new Error('injected failure') } })
        const decision = await policy.run('tool.before', { toolName: 'write_file', input: { path: 'test' } })
        checks.push({ id: 'policy-fails-closed', passed: decision.decision === 'deny', detail: decision.reason || decision.decision || '' })

        const manager = new MissionWorkspaceManager(join(root, 'workspaces'))
        const workspace = await manager.create({ missionId: 'chaos', mode: 'temporary' })
        let promotionDenied = false
        try { await manager.promote(workspace.id, root, false) } catch { promotionDenied = true }
        checks.push({ id: 'workspace-promotion-gate', passed: promotionDenied, detail: promotionDenied ? 'unapproved promotion denied' : 'promotion unexpectedly allowed' })

        const pluginDir = join(root, 'external-plugin')
        const { mkdirSync } = await import('node:fs')
        mkdirSync(pluginDir, { recursive: true })
        writeFileSync(join(pluginDir, 'index.js'), 'export async function activate() {}')
        const trust = evaluatePluginTrust(pluginDir, { name: 'chaos-plugin', version: '1.0.0', main: 'index.js' })
        checks.push({ id: 'unsigned-plugin-rejected', passed: !trust.trusted, detail: trust.reason || trust.source })

        const blue = new BlueTeamService(join(root, 'incidents.json'))
        const incident = blue.createIncident('chaos evidence')
        blue.addEvidence(incident.id, 'decision', 'chaos', 'one')
        blue.addEvidence(incident.id, 'validation', 'chaos', 'two')
        const chain = blue.verifyEvidenceChain(incident.id)
        checks.push({ id: 'evidence-chain-valid', passed: chain.valid && chain.entries === 2, detail: `${chain.entries} chained entries` })

        const run = await manager.run(workspace.id, process.execPath, ['-e', 'process.stdout.write(process.cwd())'])
        checks.push({
            id: 'workspace-command-contained',
            passed: run.exitCode === 0 && isExpectedWorkingDirectory(workspace.root, run.stdout),
            detail: `exit=${run.exitCode}; expected cwd=${workspace.root}; observed cwd=${run.stdout}; stderr=${run.stderr}`,
        })
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
    return { createdAt: new Date().toISOString(), passed: checks.every(check => check.passed), checks }
}
