export interface PromptBudgetResult {
    prompt: string
    truncated: boolean
    sections: { identity: number; context: number; critical: number }
}

/** Preserve identity and late critical execution rules with explicit budgets. */
export function applySystemPromptBudget(input: string, maxChars: number): PromptBudgetResult {
    if (input.length <= maxChars) {
        return { prompt: input, truncated: false, sections: { identity: input.length, context: 0, critical: 0 } }
    }
    const separator = '\n\n[... Kontext budgetiert ...]\n\n'
    const usable = Math.max(0, maxChars - separator.length)
    const identityBudget = Math.floor(usable * 0.25)
    const criticalBudget = Math.floor(usable * 0.55)
    const contextBudget = usable - identityBudget - criticalBudget
    const identity = input.slice(0, identityBudget)
    const context = input.slice(identityBudget, identityBudget + contextBudget)
    const critical = input.slice(-criticalBudget)
    return {
        prompt: identity + context + separator + critical,
        truncated: true,
        sections: { identity: identity.length, context: context.length, critical: critical.length },
    }
}

