export type ToolContractState =
    | 'healthy'
    | 'missing-from-worker-contract'
    | 'missing-from-registry'

export interface ToolContractDiagnosis {
    state: ToolContractState
    requestedTool: string
    canonicalTool?: string
    recoverable: boolean
    message: string
}

function normalizedToolName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Deterministic Doctor check for the registry -> worker contract boundary.
 * It never widens the contract and never executes a replacement command. */
export function diagnoseToolContract(
    requestedTool: string,
    workerTools: readonly string[],
    registryTools: readonly string[],
): ToolContractDiagnosis {
    const normalized = normalizedToolName(requestedTool)
    const canonicalTool = workerTools.find(name => normalizedToolName(name) === normalized)
    if (canonicalTool) {
        return {
            state: 'healthy',
            requestedTool,
            canonicalTool,
            recoverable: true,
            message: canonicalTool === requestedTool
                ? `Tool ${requestedTool} ist im Worker-Vertrag verfügbar.`
                : `Toolname ${requestedTool} wurde sicher auf ${canonicalTool} normalisiert.`,
        }
    }
    if (registryTools.includes(requestedTool)
        || registryTools.some(name => normalizedToolName(name) === normalized)) {
        return {
            state: 'missing-from-worker-contract',
            requestedTool,
            recoverable: false,
            message: `Tool ${requestedTool} ist registriert, fehlt aber im unveränderlichen Worker-Vertrag.`,
        }
    }
    return {
        state: 'missing-from-registry',
        requestedTool,
        recoverable: false,
        message: `Tool ${requestedTool} existiert nicht in der Registry und darf nicht ausgeführt werden.`,
    }
}
