/**
 * Nova Hardware Auto-Provisioning
 * 
 * When Nova detects a task is too heavy for the current node,
 * she can request additional compute resources:
 * - Spin up Hetzner cloud instances
 * - Start Docker containers on "Der Dicke" (ProLiant)
 * - Delegate to existing mesh nodes
 * 
 * Just-in-Time Computing: Start → Execute → Shutdown
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.nova-data', 'provisioning')

// ============================================
// Types
// ============================================

interface ComputeRequest {
    id: string
    task: string
    requiredRAM: number      // GB
    requiredGPU: boolean
    requiredDisk: number     // GB
    estimatedDuration: number  // seconds
    status: 'pending' | 'provisioning' | 'running' | 'completed' | 'failed'
    provider?: string
    instanceId?: string
    cost?: number
    startedAt?: number
    completedAt?: number
}

interface ProviderConfig {
    name: string
    type: 'hetzner' | 'docker' | 'mesh'
    endpoint?: string
    apiKey?: string
    maxCost?: number  // EUR per hour
}

// ============================================
// Provider Registry
// ============================================

const providers = new Map<string, ProviderConfig>()

function loadProviders(): void {
    // Hetzner Cloud
    const hetznerKey = process.env.HETZNER_API_TOKEN
    if (hetznerKey) {
        providers.set('hetzner', {
            name: 'Hetzner Cloud',
            type: 'hetzner',
            endpoint: 'https://api.hetzner.cloud/v1',
            apiKey: hetznerKey,
            maxCost: 0.5,  // Max 50 cents per hour
        })
    }

    // Docker on local network (ProLiant "Der Dicke")
    const dockerHost = process.env.DOCKER_HOST || process.env.NOVA_DOCKER_HOST
    if (dockerHost) {
        providers.set('docker', {
            name: 'Docker (Der Dicke)',
            type: 'docker',
            endpoint: dockerHost,
        })
    }

    // Mesh nodes as compute (always available)
    providers.set('mesh', {
        name: 'Mesh Delegation',
        type: 'mesh',
    })
}

// ============================================
// Compute Request Engine
// ============================================

const activeRequests = new Map<string, ComputeRequest>()

/**
 * Request additional compute for a heavy task
 */
export async function requestCompute(task: string, requirements: {
    ram?: number
    gpu?: boolean
    disk?: number
    duration?: number
}): Promise<ComputeRequest> {
    const id = `req-${Date.now().toString(36)}`

    const request: ComputeRequest = {
        id,
        task,
        requiredRAM: requirements.ram || 8,
        requiredGPU: requirements.gpu || false,
        requiredDisk: requirements.disk || 20,
        estimatedDuration: requirements.duration || 300,
        status: 'pending',
    }

    activeRequests.set(id, request)
    console.log(`[Provisioner] 📋 Compute request: ${task} (RAM: ${request.requiredRAM}GB, GPU: ${request.requiredGPU})`)

    // Find best provider
    const provider = selectProvider(request)

    if (!provider) {
        request.status = 'failed'
        console.log('[Provisioner] ❌ No provider available for this request')
        return request
    }

    request.provider = provider.name
    request.status = 'provisioning'

    // Provision based on type
    try {
        switch (provider.type) {
            case 'hetzner':
                await provisionHetzner(request, provider)
                break
            case 'docker':
                await provisionDocker(request, provider)
                break
            case 'mesh':
                await delegateToMesh(request)
                break
        }
    } catch (err: any) {
        request.status = 'failed'
        console.log(`[Provisioner] ❌ Provisioning failed: ${err.message}`)
    }

    // Persist
    saveRequest(request)
    return request
}

/**
 * Select the best provider for a compute request
 */
function selectProvider(request: ComputeRequest): ProviderConfig | null {
    // GPU tasks → try Hetzner first, then mesh
    if (request.requiredGPU) {
        if (providers.has('hetzner')) return providers.get('hetzner')!
        if (providers.has('mesh')) return providers.get('mesh')!
        return null
    }

    // Large RAM → Docker or Hetzner
    if (request.requiredRAM > 16) {
        if (providers.has('docker')) return providers.get('docker')!
        if (providers.has('hetzner')) return providers.get('hetzner')!
    }

    // Small tasks → mesh delegation
    if (providers.has('mesh')) return providers.get('mesh')!

    return null
}

// ============================================
// Provider Implementations
// ============================================

async function provisionHetzner(request: ComputeRequest, provider: ProviderConfig): Promise<void> {
    if (!provider.apiKey) throw new Error('No Hetzner API key')

    // Select server type based on requirements
    let serverType = 'cx22'  // 2 vCPU, 4GB RAM (cheapest)
    if (request.requiredRAM > 4) serverType = 'cx32'   // 4 vCPU, 8GB
    if (request.requiredRAM > 8) serverType = 'cx42'   // 8 vCPU, 16GB
    if (request.requiredRAM > 16) serverType = 'cx52'  // 16 vCPU, 32GB

    console.log(`[Provisioner] ☁️ Creating Hetzner ${serverType}...`)

    const response = await fetch(`${provider.endpoint}/servers`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name: `nova-burst-${request.id}`,
            server_type: serverType,
            image: 'ubuntu-24.04',
            location: 'nbg1',
            ssh_keys: [],  // Will use password auth
            user_data: `#!/bin/bash
# Auto-setup Nova burst compute
apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
echo "NOVA_BURST_READY" > /tmp/nova-ready
`,
            labels: { purpose: 'nova-burst', request: request.id },
        }),
    })

    if (!response.ok) {
        throw new Error(`Hetzner API error: ${response.status}`)
    }

    const data = await response.json() as any
    request.instanceId = data.server?.id?.toString()
    request.status = 'running'
    request.startedAt = Date.now()

    console.log(`[Provisioner] ✅ Hetzner server created: ${request.instanceId} (${serverType})`)
}

async function provisionDocker(request: ComputeRequest, provider: ProviderConfig): Promise<void> {
    if (!provider.endpoint) throw new Error('No Docker endpoint')

    console.log(`[Provisioner] 🐳 Starting Docker container...`)

    const response = await fetch(`${provider.endpoint}/containers/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            Image: 'node:22-slim',
            Cmd: ['sleep', request.estimatedDuration.toString()],
            HostConfig: {
                Memory: request.requiredRAM * 1024 * 1024 * 1024,
                AutoRemove: true,
            },
            Labels: { purpose: 'nova-burst', request: request.id },
        }),
    })

    if (!response.ok) throw new Error(`Docker API error: ${response.status}`)

    const data = await response.json() as any
    request.instanceId = data.Id

    // Start container
    await fetch(`${provider.endpoint}/containers/${data.Id}/start`, { method: 'POST' })

    request.status = 'running'
    request.startedAt = Date.now()

    console.log(`[Provisioner] ✅ Docker container started: ${request.instanceId?.slice(0, 12)}`)
}

async function delegateToMesh(request: ComputeRequest): Promise<void> {
    console.log(`[Provisioner] 🌐 Delegating to mesh node...`)

    // Find best mesh node
    try {
        const { emit } = await import('./event-hub.js')
        emit('mesh:compute_request', {
            requestId: request.id,
            task: request.task,
            requirements: {
                ram: request.requiredRAM,
                gpu: request.requiredGPU,
            },
        })
        request.status = 'running'
        request.startedAt = Date.now()
    } catch {
        throw new Error('Mesh Event Hub not available')
    }
}

// ============================================
// Cleanup
// ============================================

/**
 * Destroy a provisioned instance (cost control!)
 */
export async function destroyInstance(requestId: string): Promise<boolean> {
    const request = activeRequests.get(requestId)
    if (!request?.instanceId) return false

    const provider = [...providers.values()].find(p => p.name === request.provider)
    if (!provider) return false

    try {
        if (provider.type === 'hetzner' && provider.apiKey) {
            await fetch(`${provider.endpoint}/servers/${request.instanceId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${provider.apiKey}` },
            })
            console.log(`[Provisioner] 🗑️ Hetzner server destroyed: ${request.instanceId}`)
        }

        if (provider.type === 'docker' && provider.endpoint) {
            await fetch(`${provider.endpoint}/containers/${request.instanceId}?force=true`, {
                method: 'DELETE',
            })
            console.log(`[Provisioner] 🗑️ Docker container destroyed`)
        }

        request.status = 'completed'
        request.completedAt = Date.now()
        saveRequest(request)
        return true
    } catch {
        return false
    }
}

// ============================================
// Persistence & Status
// ============================================

function saveRequest(request: ComputeRequest): void {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(join(DATA_DIR, `${request.id}.json`), JSON.stringify(request, null, 2))
}

export function getActiveRequests(): ComputeRequest[] {
    return [...activeRequests.values()].filter(r => r.status === 'running' || r.status === 'provisioning')
}

export function getProviderStatus(): Array<{ name: string; type: string; available: boolean }> {
    return [...providers.values()].map(p => ({
        name: p.name,
        type: p.type,
        available: true,
    }))
}

/**
 * Initialize provisioning — load configs
 */
export function initProvisioner(): void {
    loadProviders()
    console.log(`[Provisioner] ✅ Initialized — ${providers.size} Providers (${[...providers.keys()].join(', ')})`)
}
