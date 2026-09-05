/**
 * Tool Chainer
 * 
 * Automatically chains tools together based on output/input compatibility.
 * Example: search → write_file → run_command
 */

// ============================================
// Types
// ============================================

export interface ToolChain {
    steps: ChainStep[]
    currentIndex: number
}

export interface ChainStep {
    tool: string
    params: Record<string, unknown>
    paramSource?: { step: number; field: string }  // Use output from previous step
}

// ============================================
// Chain Patterns
// ============================================

const CHAIN_PATTERNS: Array<{
    trigger: RegExp
    chain: (match: RegExpMatchArray, request: string) => ChainStep[]
}> = [
        {
            // "such X und installiere"
            trigger: /such(?:e)?\s+(.+?)\s+und\s+install/i,
            chain: (match) => [
                { tool: 'web_search', params: { query: `how to install ${match[1]}` } },
                { tool: 'run_command', params: { command: `npm install ${match[1]}` } },
            ]
        },
        {
            // "erstelle Datei und führe aus"
            trigger: /erstell(?:e)?\s+(.+\.(?:py|js|ts))\s+.*(?:und|dann)\s+(?:führ|run|test)/i,
            chain: (match) => [
                { tool: 'write_file', params: { path: match[1] } },
                { tool: 'run_command', params: { command: `node ${match[1]}` }, paramSource: { step: 0, field: 'path' } },
            ]
        },
        {
            // "download und extrahiere"
            trigger: /download(?:e)?\s+(.+?)\s+(?:und|dann)\s+(?:extrahier|entpack)/i,
            chain: (match) => [
                { tool: 'run_command', params: { command: `curl -O ${match[1]}` } },
                { tool: 'run_command', params: { command: 'tar -xzf downloaded.tar.gz' } },
            ]
        },
    ]

// ============================================
// Chainer Functions
// ============================================

/**
 * Detect if request implies a tool chain
 */
export function detectChain(request: string): ChainStep[] | null {
    for (const { trigger, chain } of CHAIN_PATTERNS) {
        const match = request.match(trigger)
        if (match) {
            console.log(`[ToolChainer] Detected chain pattern: ${trigger.source}`)
            return chain(match, request)
        }
    }
    return null
}

/**
 * Execute a chain of tools
 */
export async function executeChain(
    chain: ChainStep[],
    executor: (tool: string, params: Record<string, unknown>) => Promise<unknown>,
    onStep?: (step: number, tool: string, status: string) => void
): Promise<Array<{ tool: string; result: unknown; error?: string }>> {
    const results: Array<{ tool: string; result: unknown; error?: string }> = []

    for (let i = 0; i < chain.length; i++) {
        const step = chain[i]
        let params = { ...step.params }

        // Inject output from previous step if specified
        if (step.paramSource && results[step.paramSource.step]) {
            const prevResult = results[step.paramSource.step].result as Record<string, unknown>
            if (prevResult && typeof prevResult === 'object') {
                const value = prevResult[step.paramSource.field]
                if (value !== undefined) {
                    // Replace placeholder in params
                    for (const key of Object.keys(params)) {
                        if (typeof params[key] === 'string' && params[key].includes('$PREV')) {
                            params[key] = (params[key] as string).replace('$PREV', String(value))
                        }
                    }
                }
            }
        }

        onStep?.(i, step.tool, 'running')
        console.log(`[ToolChainer] Step ${i + 1}/${chain.length}: ${step.tool}`)

        try {
            const result = await executor(step.tool, params)
            results.push({ tool: step.tool, result })
            onStep?.(i, step.tool, 'done')

            // Check for error in result
            if (result && typeof result === 'object' && 'error' in result) {
                console.log(`[ToolChainer] Step failed: ${(result as any).error}`)
                results[results.length - 1].error = (result as any).error
                // Continue anyway - let next step handle it
            }
        } catch (err) {
            results.push({ tool: step.tool, result: null, error: String(err) })
            onStep?.(i, step.tool, 'failed')
            console.log(`[ToolChainer] Step exception: ${err}`)
        }
    }

    return results
}

/**
 * Format chain results for display
 */
export function formatChainResults(results: Array<{ tool: string; result: unknown; error?: string }>): string {
    return results.map((r, i) => {
        const icon = r.error ? '❌' : '✅'
        const content = r.error || JSON.stringify(r.result).slice(0, 100)
        return `${icon} Step ${i + 1} (${r.tool}): ${content}`
    }).join('\n')
}

export default {
    detectChain,
    executeChain,
    formatChainResults,
}
