/**
 * Model client of one background runtime (learning, repair). Moved out of daemon.ts in 2.89.12 so the
 * choice is testable. Order: local endpoint (autonomous-endpoint.ts: nodes vLLM -> configured local
 * provider -> Ollama) -> owner-approved cloud model (cloud-service-model.ts) -> none ("offline").
 */
import { resolveAutonomousEndpoint, type ResolveDeps } from './autonomous-endpoint.js'
import { miniMaxServiceClient, resolveCloudServicePlan } from './cloud-service-model.js'

export interface AutonomousClient {
    client: { complete(input: any, tools?: any, options?: any): Promise<any> }
    model: string
    provider: string
    /** False only for the owner-approved cloud model. */
    localOnly: boolean
}

export interface AutonomousClientDeps extends ResolveDeps {
    keyOf?: (name: string, section?: any) => string
}

export async function createAutonomousClient(config: any, requested: string, timeoutMs: number, deps: AutonomousClientDeps = {}): Promise<AutonomousClient | null> {
    const endpoint = await resolveAutonomousEndpoint(config, requested, deps)
    if (endpoint) {
        if (endpoint.provider === 'ollama') {
            const { createOllamaLLM } = await import('../llm/custom.js')
            return { client: createOllamaLLM(endpoint.baseUrl, endpoint.model) as any, model: endpoint.model, provider: 'ollama', localOnly: true }
        }
        const { createLocalLLM } = await import('../llm/local-llm.js')
        return {
            // Autonomous runtimes need native function/tool calling;
            // CustomLLM's legacy signature treats the tools argument
            // as options and silently drops tool definitions.
            client: createLocalLLM({ baseUrl: endpoint.baseUrl, model: endpoint.model, apiKey: endpoint.apiKey, name: 'Nova autonomous vLLM', requestTimeoutMs: timeoutMs }),
            model: endpoint.model, provider: endpoint.provider, localOnly: true,
        }
    }
    const keyOf = deps.keyOf ?? (await import('../core/llm-factory.js')).cloudProviderKey
    const plan = resolveCloudServicePlan(config, keyOf)
    if (!plan) return null
    const { createMiniMaxLLM } = await import('../llm/providers/minimax.js')
    const llm = createMiniMaxLLM({ apiKey: plan.apiKey, model: plan.model, baseUrl: plan.baseUrl })
    return { client: miniMaxServiceClient(llm, timeoutMs), model: plan.model, provider: plan.provider, localOnly: false }
}
