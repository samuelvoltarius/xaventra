export type ServiceRole = 'main' | 'doctor' | 'repair' | 'learning'
export type ServiceHealth = 'starting' | 'healthy' | 'degraded' | 'down'

export interface ServiceModelProfile {
    role: ServiceRole
    model: string
    provider: string
    timeoutMs: number
    dailyTokenBudget: number
    localOnly?: boolean
}

export interface ServiceRuntimeStatus {
    profile: ServiceModelProfile
    health: ServiceHealth
    calls: number
    failures: number
    estimatedTokens: number
    lastSuccess?: number
    lastError?: string
}

interface ModelClient {
    complete(input: any, tools?: any, options?: any): Promise<any>
}

class IsolatedServiceClient implements ModelClient {
    constructor(private manager: ServiceRuntimeManager, private role: ServiceRole) {}
    complete(input: any, tools?: any, options?: any): Promise<any> {
        return this.manager.complete(this.role, input, tools, options)
    }
}

/** Owns model access, timeout, budget and health independently per service.
 * Services never fall back to the main agent implicitly. */
export class ServiceRuntimeManager {
    private clients = new Map<ServiceRole, ModelClient>()
    private statuses = new Map<ServiceRole, ServiceRuntimeStatus>()
    private facades = new Map<ServiceRole, ModelClient>()

    register(profile: ServiceModelProfile, client: ModelClient): void {
        this.clients.set(profile.role, client)
        this.statuses.set(profile.role, {
            profile: { ...profile }, health: 'healthy', calls: 0, failures: 0, estimatedTokens: 0,
        })
    }

    getClient(role: ServiceRole): ModelClient | null {
        if (!this.clients.has(role)) return null
        let facade = this.facades.get(role)
        if (!facade) {
            facade = new IsolatedServiceClient(this, role)
            this.facades.set(role, facade)
        }
        return facade
    }

    async complete(role: ServiceRole, input: any, tools?: any, options?: any): Promise<any> {
        const client = this.clients.get(role)
        const status = this.statuses.get(role)
        if (!client || !status) throw new Error(`Service model not registered: ${role}`)
        if (status.estimatedTokens >= status.profile.dailyTokenBudget) {
            status.health = 'degraded'
            throw new Error(`Service token budget exhausted: ${role}`)
        }
        status.calls++
        const inputText = typeof input === 'string' ? input : JSON.stringify(input)
        // All Nova model clients use the chat-message contract. Legacy layers
        // may still pass a prompt string; normalize at the service boundary.
        const normalizedInput = typeof input === 'string'
            ? [{ role: 'user', content: input }]
            : input
        status.estimatedTokens += Math.ceil(inputText.length / 4)
        try {
            const result = await Promise.race([
                client.complete(normalizedInput, tools, options),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${role} model timeout`)), status.profile.timeoutMs)),
            ])
            status.health = 'healthy'
            status.lastSuccess = Date.now()
            status.lastError = undefined
            return result
        } catch (error) {
            status.failures++
            status.health = status.failures >= 3 ? 'down' : 'degraded'
            status.lastError = String(error).slice(0, 300)
            throw error
        }
    }

    getStatus(): Readonly<Record<string, ServiceRuntimeStatus>> {
        return Object.freeze(Object.fromEntries([...this.statuses].map(([role, status]) => [role, {
            ...status, profile: { ...status.profile },
        }])))
    }
}

let runtime: ServiceRuntimeManager | null = null
export function getServiceRuntime(): ServiceRuntimeManager {
    return runtime ||= new ServiceRuntimeManager()
}
