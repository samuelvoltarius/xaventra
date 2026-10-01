import { request } from 'node:http'
import { readFileSync } from 'node:fs'

export async function callDockerHost(operation: 'list' | 'status' | 'logs' | 'action', data: object): Promise<any> {
    return callHostAgent(`/v1/docker/${operation}`, data)
}

const HOST_AGENT_PATHS = ['/v1/docker/list', '/v1/docker/status', '/v1/docker/logs', '/v1/docker/action', '/v1/install/execute', '/v1/install/rollback', '/v1/install/status', '/v1/vllm/state', '/v1/vllm/action']

/** Local authenticated host-agent call. Fixed paths only; the body is JSON data, never a command. */
export async function callHostAgent(path: string, data: object): Promise<any> {
    if (!HOST_AGENT_PATHS.includes(path)) return { success: false, error: 'Unsupported host operation' }
    const socketPath = process.env.XAVENTRA_HOST_AGENT_SOCKET
    const tokenFile = process.env.XAVENTRA_HOST_AGENT_TOKEN_FILE
    if (!socketPath || !tokenFile) return { success: false, unavailable: true, error: 'Docker-Host-Zugriff ist auf diesem Node nicht eingerichtet. Ein Owner muss den authentifizierten Host-Agenten verbinden; Docker im App-Container allein reicht nicht.' }
    try {
        const token = readFileSync(tokenFile, 'utf8').trim()
        if (token.length < 32) throw Error('Invalid host credential')
        return await new Promise((resolve, reject) => {
            const req = request({ socketPath, agent: false, method: 'POST', path, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, res => {
                const chunks: Buffer[] = []; let size = 0
                res.on('data', c => { size += c.length; if (size > 1024 * 1024) req.destroy(Error('Host response too large')); else chunks.push(c) })
                res.on('error', reject)
                res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(Error('Invalid host response')) } })
            })
            const timer = setTimeout(() => req.destroy(Error('Host request timed out')), 45_000)
            req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end(JSON.stringify(data))
        })
    } catch { return { success: false, unavailable: true, error: 'Host-Agent nicht erreichbar oder Authentifizierung fehlgeschlagen. Keine Docker-Aktion als erfolgreich bestätigt.' } }
}
