import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
const url = process.env.NOVA_MESH_SUPABASE_URL || config.supabase?.meshUrl
const key = process.env.NOVA_MESH_SUPABASE_KEY || config.supabase?.meshKey
if (!url || !key) throw new Error('Mesh Supabase is not configured')
const headers = { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` }
const suffix = randomUUID().slice(0, 8)
const service = `live-failover:${suffix}`
const taskId = `live-failover-task-${suffix}`
const takeoverService = `live-failover-takeover:${suffix}`
const telegramEnabled = process.env.NOVA_TELEGRAM_E2E === '1'

function resolveTelegramChatId(): string | undefined {
    if (process.env.TELEGRAM_ADMIN_CHAT_ID) return process.env.TELEGRAM_ADMIN_CHAT_ID
    const queuePath = join(process.cwd(), '.nova-data', 'msg-queue.jsonl')
    if (!existsSync(queuePath)) return undefined
    const lines = readFileSync(queuePath, 'utf8').trim().split(/\r?\n/).reverse()
    for (const line of lines) {
        try {
            const event = JSON.parse(line) as { channel?: string; chatId?: string }
            if (event.channel === 'Telegram' && /^-?\d+$/.test(String(event.chatId || ''))) return String(event.chatId)
        } catch { /* ignore malformed historic queue entries */ }
    }
    return undefined
}

async function sendTelegram(holder: string, phase: string): Promise<number | undefined> {
    if (!telegramEnabled) return undefined
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = resolveTelegramChatId()
    if (!token || !chatId) throw new Error('Telegram E2E requires TELEGRAM_BOT_TOKEN and a known admin chat')
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `Nova Failover E2E · ${phase}\nAktiver Holder: ${holder}\nRun: ${suffix}` }),
        signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json() as { ok?: boolean; result?: { message_id?: number }; description?: string }
    if (!response.ok || body.ok !== true || !body.result?.message_id) {
        throw new Error(`Telegram delivery failed (${response.status}): ${body.description || 'unknown error'}`)
    }
    return body.result.message_id
}

async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${url}/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`${name} failed (${response.status}): ${(await response.text()).slice(0, 300)}`)
    return response.json() as Promise<T>
}

async function acquire(name: string, node: string, ttl = 1000) {
    return rpc<{ leader: boolean; epoch: number }>('nova_acquire_service_lease', {
        p_service: name, p_holder_node_id: node, p_holder_hostname: node, p_ttl_ms: ttl,
    })
}

async function cleanup(): Promise<void> {
    await fetch(`${url}/nova_mesh_tasks?id=eq.${encodeURIComponent(taskId)}`, { method: 'DELETE', headers }).catch(() => undefined)
    for (const name of [service, `mesh-task:${taskId}`, takeoverService]) {
        await fetch(`${url}/nova_mesh_leases?service=eq.${encodeURIComponent(name)}`, { method: 'DELETE', headers }).catch(() => undefined)
    }
}

try {
    const nodeA = `node-a-${suffix}`
    const nodeB = `node-b-${suffix}`
    const first = await acquire(service, nodeA)
    const blocked = await acquire(service, nodeB)
    if (!first.leader || blocked.leader) throw new Error('two leaders were admitted before lease expiry')
    const telegramBefore = await sendTelegram(nodeA, 'Primär-Node aktiv')
    await new Promise(resolve => setTimeout(resolve, 1150))
    const takeover = await acquire(service, nodeB)
    if (!takeover.leader || takeover.epoch <= first.epoch) throw new Error('lease takeover did not advance the fencing epoch')
    const telegramAfter = await sendTelegram(nodeB, 'Standby hat übernommen')

    const workerB = `worker-b-${suffix}`
    const taskLeaseB = await acquire(`mesh-task:${taskId}`, workerB)
    const tokenB = `mesh-task:${taskId}:${taskLeaseB.epoch}:${workerB}`
    const create = await fetch(`${url}/nova_mesh_tasks`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ id: taskId, from_node: 'live-test', to_node: workerB, task: 'live fencing test', status: 'pending', created_at: Date.now(), idempotency_key: taskId }),
    })
    if (!create.ok) throw new Error(`test task create failed (${create.status})`)
    const claimedB = await rpc<Record<string, unknown> | null>('nova_claim_mesh_task', { p_task_id: taskId, p_node_id: workerB, p_fencing_token: tokenB, p_lease_epoch: taskLeaseB.epoch })
    if (!claimedB) throw new Error('first worker could not claim task')

    await new Promise(resolve => setTimeout(resolve, 1150))
    const workerC = `worker-c-${suffix}`
    const recoveryLease = await acquire(takeoverService, workerC, 5000)
    const recoveryToken = `${takeoverService}:${recoveryLease.epoch}:${workerC}`
    const recovered = await rpc<Array<Record<string, unknown>>>('nova_recover_stale_mesh_tasks_v2', {
        p_node_id: workerC, p_fencing_token: recoveryToken, p_lease_epoch: recoveryLease.epoch, p_stale_after_ms: 0,
        p_takeover_service: takeoverService,
    })
    if (!recovered.some(item => item.id === taskId)) {
        const [taskResponse, leaseResponse] = await Promise.all([
            fetch(`${url}/nova_mesh_tasks?id=eq.${encodeURIComponent(taskId)}&select=id,status,to_node,owner_node,claimed_at,lease_epoch`, { headers }),
            fetch(`${url}/nova_mesh_leases?service=eq.${encodeURIComponent(takeoverService)}&select=service,holder_node_id,epoch,expires_at`, { headers }),
        ])
        const taskState = await taskResponse.json().catch(() => [])
        const leaseState = await leaseResponse.json().catch(() => [])
        throw new Error(`stale task was not recovered: task=${JSON.stringify(taskState)} takeoverLease=${JSON.stringify(leaseState)} now=${Date.now()}`)
    }
    const taskLeaseC = await acquire(`mesh-task:${taskId}`, workerC, 5000)
    const tokenC = `mesh-task:${taskId}:${taskLeaseC.epoch}:${workerC}`
    const claimedC = await rpc<Record<string, unknown> | null>('nova_claim_mesh_task', { p_task_id: taskId, p_node_id: workerC, p_fencing_token: tokenC, p_lease_epoch: taskLeaseC.epoch })
    if (!claimedC) throw new Error('takeover worker could not claim recovered task')
    const staleFinish = await rpc<boolean>('nova_finish_mesh_task', { p_task_id: taskId, p_node_id: workerB, p_fencing_token: tokenB, p_status: 'done', p_result: 'stale' })
    const currentFinish = await rpc<boolean>('nova_finish_mesh_task', { p_task_id: taskId, p_node_id: workerC, p_fencing_token: tokenC, p_status: 'done', p_result: 'current' })
    if (staleFinish || !currentFinish) throw new Error('fencing failed: stale worker write accepted or current worker rejected')
    console.log(JSON.stringify({
        success: true, oneLeader: true, takeover: true, epochAdvanced: true,
        singleWorker: true, staleWorkerFenced: true,
        telegramDelivered: telegramEnabled ? Boolean(telegramBefore && telegramAfter) : undefined,
        telegramMessageIds: telegramEnabled ? [telegramBefore, telegramAfter] : undefined,
    }, null, 2))
} finally {
    await cleanup()
}
