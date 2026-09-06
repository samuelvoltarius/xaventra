import type { Server } from 'node:http'

/** Report an actual listener, never infer LAN reachability from host adapters. */
export function dashboardAddress(server: Server): string | null {
    const address = server.address()
    if (!address || typeof address === 'string') return null
    const host = address.address.includes(':') ? `[${address.address}]` : address.address
    return `http://${host}:${address.port}`
}

/** One configured endpoint; never silently jump ports or broaden the bind. */
export function listenDashboard(server: Server, port = 3011, host = '127.0.0.1'): Promise<string> {
    return new Promise((resolve, reject) => {
        const failed = (error: Error) => { server.off('listening', ready); reject(error) }
        const ready = () => {
            server.off('error', failed)
            const address = dashboardAddress(server)
            if (!address) return reject(new Error('Dashboard TCP address unavailable'))
            resolve(address)
        }
        server.once('error', failed)
        server.once('listening', ready)
        try { server.listen(port, host) } catch (error) { server.off('error', failed); server.off('listening', ready); reject(error) }
    })
}
