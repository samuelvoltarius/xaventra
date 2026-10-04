/** Private Matter SDK bootstrap. Kept out of the daemon process so libraries
 * cannot consume its environment, credentials, config files or debug settings. */
import { mkdirSync } from 'node:fs'
import { fetchWithSsrfGuard } from '../resilience/ssrf-guard.js'
import { matterTargetAllowed, matterInterfaceNames, localMatterRoutes } from './matter-scope.js'
import { runMatterController } from './matter-controller.js'
import { matterRefreshRequest, matterSwitchRequests } from './matter-wire.js'

export async function createMatterSdk(storage: string, authorize: (host: string, port: number) => Promise<boolean>): Promise<any> {
    const { config } = await import('@matter/nodejs/config')
    config.loadConfigFile = false; config.loadProcessArgv = false; config.loadProcessEnv = false
    config.defaultStoragePath = storage; config.trapProcessSignals = false; config.trapUnhandledErrors = false
    mkdirSync(storage, { recursive: true, mode: 0o700 })
    const matter: any = await import('@matter/main')
    matter.Logger.level = 'fatal'
    const env = matter.Environment.default
    env.vars.set('storage.path', storage)
    const network = env.get(matter.Network)
    const interfaceNames = matterInterfaceNames(), listInterfaces = network.getNetInterfaces.bind(network)
    network.getNetInterfaces = (...args: any[]) => listInterfaces(...args).filter((entry: any) => interfaceNames.includes(entry.name))
    const createSocket = network.createUdpSocket.bind(network)
    network.createUdpSocket = async (options: any) => {
        const socket = await createSocket(options), send = socket.send.bind(socket)
        socket.send = async (host: string, port: number, data: any) => {
            if (!await authorize(host, port)) throw new Error('Matter packet authorization changed')
            return send(host, port, data)
        }
        return socket
    }
    network.connectTcp = async () => { throw new Error('Matter TCP disabled') }
    // Only public, DNS-pinned certificate GETs. No account credentials, redirects,
    // OTA, arbitrary private endpoints or inherited daemon fetch implementation.
    let certificateBytes = 0, certificateRequests = 0
    globalThis.fetch = async (resource: any, options: any = {}) => {
        const url = String(resource)
        if ((options.method && options.method !== 'GET') || options.body || ++certificateRequests > 100) throw new Error('Matter certificate request denied')
        const response = await fetchWithSsrfGuard(url, { method: 'GET', redirect: 'error', signal: AbortSignal.any([options.signal || new AbortController().signal, AbortSignal.timeout(5000)]) }, { maxRedirects: 0 })
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []
        let size = 0
        if (reader) try { for (;;) {
            const { value, done } = await reader.read(); if (done) break
            size += value.length; certificateBytes += value.length
            if (size > 4 * 1024 * 1024 || certificateBytes > 16 * 1024 * 1024) throw new Error('Matter certificate body too large')
            chunks.push(value)
        } } finally { await reader.cancel().catch(() => {}) }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers })
    }
    return {
        async create(options: any) {
            const node = await matter.ServerNode.create(matter.ServerNode.RootEndpoint.with(matter.ControllerBehavior, matter.DclBehavior), {
                environment: env, id: 'xaventra-controller',
                network: { ble: false, tcp: false, port: 0, transportPreference: 'udp' },
                controller: { ble: false, ip: true, adminFabricLabel: 'Xaventra owner-approved device' },
                commissioning: { enabled: false },
                dcl: { fetchTestCertificates: false, acceptTestCertificates: false, fetchGithubCertificates: false },
            })
            const peers = [...node.peers]
            if (peers.length > 1 || peers.some(peer => peer.id !== options.expectedPeerId)) { await node.close(); throw new Error('Matter private fabric is ambiguous; no reset or retry') }
            return node
        },
        certificates: (node: any) => node.act((agent: any) => agent.get(matter.DclBehavior).certificateService),
        async refresh(peer: any) {
            for await (const _chunk of peer.interaction.read(await matterRefreshRequest())) { /* authenticated SDK endpoint projection */ }
        },
        async switch(peer: any, endpoint: number, on: boolean) {
            const request = await matterSwitchRequests(endpoint, on)
            let ack = false
            for await (const chunk of peer.interaction.invoke(request.invoke)) {
                for (const result of chunk) {
                    if (result.kind !== 'cmd-status' || result.status !== 0) throw new Error('Matter command not acknowledged')
                    ack = true
                }
            }
            if (!ack) return false
            let confirmed = false
            for await (const chunk of peer.interaction.read(request.read)) {
                for (const result of chunk) if (result.kind === 'attr-value' && result.path?.endpointId === endpoint && result.path?.clusterId === 6 && result.path?.attributeId === 0 && result.value === on) confirmed = true
            }
            return confirmed
        },
    }
}

// No pair codes in argv/environment/logs. Child gets one private IPC message.
if (typeof process.send === 'function') {
    process.umask(0o077)
    let inputReceived = false, sequence = 0
    const waiting = new Map<number, (ok: boolean) => void>()
    process.on('message', async (message: any) => {
        if (message?.kind === 'packet-permission') { const resolve = waiting.get(message.id); waiting.delete(message.id); resolve?.(message.ok === true); return }
        if (message?.kind !== 'run' || inputReceived) return
        inputReceived = true
        const controller = new AbortController()
        try {
            if (!matterTargetAllowed(message.input.host, undefined, await localMatterRoutes())) throw new Error('Matter target outside own network')
            const authorize = (host: string, port: number) => new Promise<boolean>(resolve => {
                const id = ++sequence
                waiting.set(id, resolve); process.send?.({ kind: 'packet-permission', id, host, port })
            })
            const sdk = await createMatterSdk(message.storage, authorize)
            const result = await runMatterController(message.input, sdk, controller.signal)
            process.send?.({ kind: 'result', ok: true, ...result }, () => process.exit(0))
        } catch { process.send?.({ kind: 'result', ok: false }, () => process.exit(1)) }
    })
}
