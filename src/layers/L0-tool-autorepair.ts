/** Legacy repair entry points are diagnostic only. Error text is untrusted data,
 * never authority to write files, install packages, or repeat a tool handler.
 * Execution must enter the normal Kernel/Policy path as a new approved action. */
export interface ToolResult {
    success?: boolean
    error?: string
    action?: string
    missingFile?: string
    originalCommand?: string
    [key: string]: unknown
}
export interface RepairResult {
    repaired: boolean
    action: string
    details: string
    shouldRetry: boolean
    fixedResult?: unknown
}
export interface RepairStats {
    totalAttempts: number
    successfulRepairs: number
    failedRepairs: number
    repairsByType: Record<string, number>
}

const kinds = ['missing_script_file', 'missing_npm_package', 'missing_directory'] as const
function diagnosis(result: ToolResult): string {
    const error = String(result.error || '')
    if (result.action === 'CREATE_FILE_FIRST' || result.missingFile) return kinds[0]
    if (/Cannot find module|MODULE_NOT_FOUND|npm.*ERR!/i.test(error)) return kinds[1]
    if (/ENOENT|no such file or directory|Verzeichnis nicht gefunden/i.test(error)) return kinds[2]
    return 'unknown_tool_failure'
}

// Preserve the legacy exported shape without leaving writable alternate APIs.
const REPAIR_PATTERNS = kinds.map(name => ({
    name,
    detect: (result: ToolResult, _toolName?: string, _params?: Record<string, unknown>) => diagnosis(result) === name,
    repair: async (_result?: ToolResult, _toolName?: string, _params?: Record<string, unknown>): Promise<RepairResult> => ({
        repaired: false, action: name, shouldRetry: false,
        details: 'Diagnose only. A scoped repair plan, sandbox checks and approval are required before execution.',
    }),
}))

export class ToolAutoRepairEngine {
    private stats: RepairStats = {totalAttempts: 0, successfulRepairs: 0, failedRepairs: 0, repairsByType: {}}

    async repairAndRetry(
        toolName: string, _params: Record<string, unknown>, result: ToolResult,
        _retryFn: (params: Record<string, unknown>) => Promise<unknown>, _attempt = 1,
    ): Promise<{result: unknown; wasRepaired: boolean; repairDetails?: string}> {
        if (result?.success === true || (!result?.error && !result?.action)) return {result, wasRepaired: false}
        this.stats.totalAttempts++
        this.stats.failedRepairs++
        const kind = diagnosis(result)
        return {
            wasRepaired: false,
            repairDetails: 'Repair requires a new governed action; nothing was changed or retried.',
            result: {
                ...result, success: false,
                repairProposal: {
                    kind, toolName, status: 'requires-governed-plan', requiresApproval: true,
                    requiredChecks: ['scope-and-policy', 'sandbox-regression', 'rollback', 'PATCH_GATE'],
                    executed: false,
                },
            },
        }
    }

    wrapToolHandler(toolName: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        return async (params: Record<string, unknown>) => {
            const result = await handler(params)
            if (result && typeof result === 'object' && ('error' in result || 'action' in result)) {
                return (await this.repairAndRetry(toolName, params, result as ToolResult, handler)).result
            }
            return result
        }
    }

    getStats(): RepairStats { return {...this.stats, repairsByType: {...this.stats.repairsByType}} }
}
let instance: ToolAutoRepairEngine | null = null
export function getToolAutoRepairEngine(): ToolAutoRepairEngine {
    return instance ||= new ToolAutoRepairEngine()
}
export default {ToolAutoRepairEngine, getToolAutoRepairEngine, REPAIR_PATTERNS}
