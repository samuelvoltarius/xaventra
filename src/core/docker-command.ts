import { ExecutionKernel } from './execution-kernel.js'
import { getOutcomeLedger } from './outcome-ledger.js'
import type { PrincipalContext } from '../users/principal-id.js'

/** Native command and natural-language inventory share the same registry,
 * lifecycle admission, validator, telemetry and durable outcome path. No LLM. */
export async function dockerInventoryCommand(args: string, tools: { execute(name: string, params: Record<string, unknown>): Promise<any> }, principal?: PrincipalContext): Promise<string> {
    if (!principal || !['owner', 'admin'].includes(principal.permission)) return 'Docker-Host-Inventar erfordert Owner/Admin-Rechte.'
    if (!['', 'list', 'ps', 'all'].includes(args.trim())) return 'Docker: /docker list oder /docker all. Änderungen benötigen eine signierte Operator-Freigabe.'
    const started = Date.now(), all = args.trim() === 'all'
    const kernel = new ExecutionKernel('Liste lokale Docker-Container', { allowedChanges: { readOnly: true, allowedTools: ['docker_ps'], allowedPaths: [], externalSideEffects: false }, budget: { timeoutMs: 50_000, maxToolCalls: 1, maxTokens: 0 } })
    const ledger = getOutcomeLedger(), runId = ledger.start(kernel.contract, { channel: principal.channel, userId: principal.principalId, backend: 'native-docker-inventory' })
    ledger.recordRoute(runId, { backend: 'native-docker-inventory', reason: 'Explicit local read-only inventory; no model inference' })
    try {
        kernel.assertCanExecute('docker_ps')
        const result = await tools.execute('docker_ps', { all })
        const verified = kernel.verify('docker_ps', result)
        // Require the exact host observation contract, not an unrelated tool.
        const hostEvidence = result?.success === true && result.operation === 'docker.list' && typeof result.nodeId === 'string'
            && /^[a-f0-9]{64}$/.test(result.evidenceHash || '') && Array.isArray(result.containers) && result.count === result.containers.length
        ledger.recordTool(runId, { toolName: 'docker_ps', params: { all }, result, success: verified.success && hostEvidence })
        if (!verified.success || !hostEvidence) {
            ledger.fail(runId, { reason: 'docker-inventory-unavailable', tool: 'docker_ps' })
            return `Docker-Inventar nicht verfügbar: ${result?.error || 'Kein verifizierter Host-Beleg erhalten.'}`
        }
        const report = kernel.validateCompletion('Docker-Inventar gelesen', { tokens: 0, toolCalls: 1, durationMs: Date.now() - started })
        ledger.recordValidation(runId, report)
        if (!report.success) { ledger.fail(runId, { violations: report.violations }); return 'Docker-Inventar konnte nicht innerhalb des freigegebenen Auftrags validiert werden.' }
        ledger.complete(runId, { success: true, nodeId: result.nodeId, evidenceHash: result.evidenceHash })
        // JSON string escaping prevents container names/images from injecting
        // additional instructions/formatting into the deterministic reply.
        const lines = result.containers.slice(0, 100).map((c: any) => `${JSON.stringify(c.names)} — ${JSON.stringify(c.state)} — ${JSON.stringify(c.image)}`)
        return `Docker auf ${result.nodeId}: ${result.count} Container${all ? ' (inklusive gestoppter)' : ''}.\n${lines.join('\n')}${result.count > 100 ? '\nAnzeige auf 100 begrenzt.' : ''}\nVerifiziert: ${result.verifiedAt}`
    } catch {
        ledger.fail(runId, { reason: 'host-inventory-execution-failed' })
        return 'Docker-Host-Abfrage fehlgeschlagen. Keine Containerliste als erfolgreich bestätigt.'
    }
}
