import { request } from 'node:http'
import { readFileSync } from 'node:fs'

export async function callDockerHost(operation: 'list' | 'status' | 'logs' | 'action', data: object): Promise<any> {
    const socketPath = process.env.XAVENTRA_HOST_AGENT_SOCKET
    const tokenFile = process.env.XAVENTRA_HOST_AGENT_TOKEN_FILE
    if (!socketPath || !tokenFile) return { success: false, unavailable: true, error: 'Docker-Host-Zugriff ist auf diesem Node nicht eingerichtet. Ein Owner muss den authentifizierten Host-Agenten verbinden; Docker im App-Container allein reicht nicht.' }
    try {
        const token = readFileSync(tokenFile, 'utf8').trim()
        if (token.length < 32) throw Error('Invalid host credential')
        return await new Promise((resolve, reject) => {
            const req = request({ socketPath, agent: false, method: 'POST', path: `/v1/docker/${operation}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, res => {
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
