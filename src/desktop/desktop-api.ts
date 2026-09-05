import type { Express, NextFunction, Request, Response } from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Stellt Nova den Verlauf des Themenraums voran.
 *
 *  Bisher bekam sie nur die aktuelle Nachricht — der Verlauf wurde zwar
 *  aus rooms.json geladen, aber nur an externe Bots gegeben. Ihr eigenes
 *  Gespraechsgedaechtnis lebt im Arbeitsspeicher und ist nach jedem
 *  Neustart des Dienstes weg, waehrend die Anzeige aus rooms.json
 *  weiterlebt. Fuer den Menschen sieht das so aus, als haette sie
 *  mitten im Gespraech vergessen, worum es ging.
 *
 *  Der Raum ist die dauerhafte Wahrheit, also kommt er von dort. */
function mitRaumVerlauf(
    aktuell: string,
    verlauf: Array<{ authorType?: string; authorId?: string; content?: string }>,
): string {
    const frueher = (verlauf || [])
        .filter(m => m && m.content && m.content !== aktuell)
        .slice(-12)
    if (frueher.length === 0) return aktuell
    const zeilen = frueher.map(m => {
        const wer = m.authorType === 'user' ? 'Mensch' : (m.authorId || 'Nova')
        return `${wer}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 400)}`
    })
    return `## Bisheriges Gespraech in diesem Raum\n${zeilen.join('\n')}\n\n`
        + `## Aktuelle Nachricht\n${aktuell}`
}

/** NovaOS-Bedienmodus aus /etc/novaos/modus.
 *  Bei jedem Aufruf frisch gelesen, damit ein Wechsel per /modus sofort
 *  in allen Oberflaechen greift. Ausserhalb von NovaOS gibt es die Datei
 *  nicht — dann bleibt der Modus leer und die Oberflaeche verhaelt sich
 *  wie bisher. */
function novaOsBedienmodus(): { modus: 'standard' | 'experte' | null; istNovaOS: boolean } {
    if (process.env.NOVA_OS_MODE !== 'true') return { modus: null, istNovaOS: false }
    try {
        const roh = readFileSync('/etc/novaos/modus', 'utf-8').trim()
        return { modus: roh === 'experte' ? 'experte' : 'standard', istNovaOS: true }
    } catch {
        return { modus: 'standard', istNovaOS: true }
    }
}
import { getBotProfileStore } from './bot-profile-store.js'
import { getTopicRoomStore } from './topic-room-store.js'
import { getExternalAgentRegistry } from './external-agent-registry.js'
import { getDesktopModelCatalog, switchDesktopModel } from './model-control.js'
import { getNodeEnrollmentService } from './node-enrollment.js'
import { runWithDesktopAgentContext, type DesktopAgentOutcome } from './desktop-agent-context.js'
import { getBlueTeamService } from '../security/blue-team.js'
import { getLatestRedTeamResult, runRedTeam } from '../security/red-team.js'
import { redactSecrets } from '../security/secret-redaction.js'
import { getOutcomeLedger } from '../core/outcome-ledger.js'
import { getMemoryGovernanceCoordinator } from '../memory/memory-governance.js'
import { getDesktopModuleCatalog } from './module-catalog.js'
import { getSkillProposals, updateSkillProposalStatus } from '../tools/skill-builder.js'
import { getDesktopControlQueue } from './desktop-control.js'
import { getLocalNodeId } from '../mesh/mesh-registry.js'
import { getServiceFencingToken, MAIN_SERVICE } from '../mesh/leader-election.js'
import { getOrCreateUser, setUserPermission } from '../users/multi-user-middleware.js'
import { getNovaDataDir } from '../core/data-root.js'
import type { DesktopControlResult } from './desktop-control.js'
import { getMemoryAssetCatalog } from '../memory/memory-asset-catalog.js'

type MessageHandler = (message: string, channel: string) => Promise<string>

/** Zeitlimit fuer einen Lauf in Nova Desktop.
 *  30 s reichen fuer eine Chatantwort, aber nicht fuer echte Arbeit:
 *  In NovaOS bedeutet eine Bitte oft apt-Installationen, Downloads und
 *  mehrstufige Werkzeugketten. Der Nutzer sah dort "Bot fehlgeschlagen:
 *  Bot-Lauf nach 30 Sekunden beendet", waehrend Nova noch arbeitete.
 *  Ausserhalb von NovaOS bleibt es bei 30 s. */
const DESKTOP_BOT_TIMEOUT_MS = Number(process.env.NOVA_DESKTOP_BOT_TIMEOUT_MS)
    || (process.env.NOVA_OS_MODE === 'true' ? 2_400_000 : 30_000)

export async function withDesktopBotTimeout<T>(work: Promise<T>, timeoutMs = DESKTOP_BOT_TIMEOUT_MS): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
        return await Promise.race([
            work,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Bot-Lauf nach ${Math.ceil(timeoutMs / 1000)} Sekunden beendet`)), timeoutMs)
                timer.unref?.()
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function isLoopback(req: Request): boolean {
    const ip = req.socket.remoteAddress || req.ip || ''
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.endsWith('127.0.0.1')
}

function tokenFrom(req: Request): string {
    const auth = String(req.headers.authorization || '')
    return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
}

function requireDesktopAuth(req: Request, res: Response, next: NextFunction): void {
    // Desktop is a separate trust surface. Loopback may run without a token;
    // remote endpoints require an explicit Desktop token and HTTPS at the app.
    // Do not silently reuse the broader REST API credential.
    const expected = process.env.NOVA_DESKTOP_API_TOKEN || ''
    if (isLoopback(req) && !expected) return next()
    const supplied = tokenFrom(req)
    if (!expected || supplied.length !== expected.length) return void res.status(401).json({ error: 'Desktop authentication required' })
    let difference = 0
    for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ supplied.charCodeAt(i)
    if (difference !== 0) return void res.status(401).json({ error: 'Desktop authentication required' })
    next()
}

function principal(req: Request): string {
    return String(req.headers['x-nova-principal'] || process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner').trim().slice(0, 200)
}

function desktopClientId(req: Request): string {
    return String(req.headers['x-nova-desktop-client'] || '').trim().slice(0, 120)
}

function safeError(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) }
function isDesktopOwner(req: Request): boolean { return principal(req) === (process.env.NOVA_DESKTOP_OWNER_ID || 'desktop-owner') }

export function pruneDesktopCaptures(captureDir: string): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000
    const entries = readdirSync(captureDir)
        .filter(name => /^desktop-[a-zA-Z0-9_.-]+\.(?:png|jpg)$/.test(name))
        .map(name => {
            const path = join(captureDir, name)
            try { const stat = lstatSync(path); return stat.isFile() ? { path, mtimeMs: stat.mtimeMs } : null } catch { return null }
        })
        .filter((entry): entry is { path: string; mtimeMs: number } => Boolean(entry))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const [index, entry] of entries.entries()) {
        if (index >= 30 || entry.mtimeMs < cutoff) try { unlinkSync(entry.path) } catch { /* bounded best-effort retention */ }
    }
}

function receiveDesktopControlResult(commandId: string, action: string, raw: unknown): DesktopControlResult | undefined {
    if (!raw || typeof raw !== 'object') throw new Error('Desktop result is required')
    const value = raw as Record<string, unknown>
    if (action === 'workspace_operation') {
        const encoded = JSON.stringify(value)
        if (Buffer.byteLength(encoded) > 220_000) throw new Error('Desktop workspace result exceeds the verified size limit')
        if (value.kind !== 'workspace_result' || !['list', 'read', 'search'].includes(String(value.operation || ''))) throw new Error('Desktop workspace result type is not allowed')
        const workspaceId = String(value.workspaceId || '').trim().slice(0, 120)
        const rootName = String(value.rootName || '').trim().slice(0, 120)
        const relativePath = String(value.relativePath || '').trim().slice(0, 1_000)
        if (!workspaceId || !rootName || !relativePath) throw new Error('Desktop workspace result identity is incomplete')
        return JSON.parse(encoded) as DesktopControlResult
    }
    if (action !== 'capture_screen') return undefined
    if (value.kind !== 'screen_capture') throw new Error('Desktop result type is not allowed')
    const mimeType = value.mimeType === 'image/png' ? 'image/png' : value.mimeType === 'image/jpeg' ? 'image/jpeg' : null
    if (!mimeType) throw new Error('Desktop capture MIME type is not allowed')
    const base64 = String(value.base64 || '')
    if (!base64 || base64.length > 180_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error('Desktop capture payload is invalid or too large')
    }
    const buffer = Buffer.from(base64, 'base64')
    if (!buffer.length || buffer.length > 140_000) throw new Error('Desktop capture exceeds the verified size limit')
    const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
    if ((mimeType === 'image/png' && !png) || (mimeType === 'image/jpeg' && !jpeg)) throw new Error('Desktop capture signature does not match MIME type')
    const captureDir = getNovaDataDir('desktop', 'captures')
    mkdirSync(captureDir, { recursive: true })
    pruneDesktopCaptures(captureDir)
    const extension = mimeType === 'image/png' ? 'png' : 'jpg'
    const filePath = join(captureDir, `${commandId.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${randomUUID()}.${extension}`)
    writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 })
    return {
        kind: 'screen_capture', path: filePath, mimeType, size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        width: Number.isInteger(value.width) ? Math.max(1, Math.min(16_384, Number(value.width))) : undefined,
        height: Number.isInteger(value.height) ? Math.max(1, Math.min(16_384, Number(value.height))) : undefined,
    }
}

export function registerDesktopApi(app: Express, resolveMessageHandler: () => MessageHandler | null): void {
    app.use('/api/desktop', requireDesktopAuth)

    app.get('/api/desktop/bootstrap', async (req, res) => {
        try {
            const ownerId = principal(req)
            const [inventory] = await Promise.all([getNodeEnrollmentService().inventory(false)])
            res.json({
                version: 1, principalId: ownerId, bots: getBotProfileStore().list(ownerId),
                rooms: getTopicRoomStore().listRooms(ownerId), models: getDesktopModelCatalog(), inventory,
                externalAgents: getExternalAgentRegistry().list(ownerId),
                modules: getDesktopModuleCatalog(),
                memoryAssets: { assets: getMemoryAssetCatalog().list(ownerId), bindings: getMemoryAssetCatalog().bindings(ownerId) },
                forge: isDesktopOwner(req) ? getSkillProposals(100) : getSkillProposals(100, ownerId),
                security: { blueTeamIncidents: getBlueTeamService().listIncidents(), redTeam: getLatestRedTeamResult(), redTeamScope: 'nova-local-self-test-only' },
                controlPlane: {
                    nodeId: getLocalNodeId(),
                    hostname: process.env.NOVA_NODE_NAME || process.env.HOSTNAME || process.env.COMPUTERNAME || getLocalNodeId(),
                    role: 'main',
                    mainEpoch: getServiceFencingToken(MAIN_SERVICE)?.epoch || null,
                    dashboardEpoch: getServiceFencingToken('dashboard')?.epoch || null,
                    authoritative: Boolean(getServiceFencingToken(MAIN_SERVICE) && getServiceFencingToken('dashboard')),
                    observedAt: new Date().toISOString(),
                },
                // NovaOS-Bedienmodus. Wird beim ersten Start gewaehlt und liegt
                // in /etc/novaos/modus. Textkonsole, Dashboard und Nova Desktop
                // muessen sich gleich verhalten — eine Quelle, drei Oberflaechen.
                // 'standard' = keine Befehle, keine Pfade, keine Rohdaten, keine
                // Auswahlfragen. 'experte' = alles sichtbar.
                novaos: novaOsBedienmodus(),
            })
        } catch (error) { res.status(500).json({ error: safeError(error) }) }
    })

    // Was Nova gerade WIRKLICH tut — geschrieben von onStepUpdate in der
    // Pipeline. Die Oberflaeche zeigte bisher nur zeitgeratene Saetze.
    app.get('/api/desktop/fortschritt', (_req, res) => {
        try {
            const text = readFileSync('/run/novaos/fortschritt', 'utf-8').trim()
            res.json({ schritt: text || null })
        } catch {
            res.json({ schritt: null })
        }
    })

    app.get('/api/desktop/bots', (req, res) => res.json({ bots: getBotProfileStore().list(principal(req)) }))
    app.post('/api/desktop/bots', (req, res) => { try { res.status(201).json(getBotProfileStore().create(principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.patch('/api/desktop/bots/:id', (req, res) => { try { res.json(getBotProfileStore().update(req.params.id, principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.delete('/api/desktop/bots/:id', (req, res) => { const removed = getBotProfileStore().remove(req.params.id, principal(req)); res.status(removed ? 200 : 404).json({ removed }) })

    app.get('/api/desktop/rooms', (req, res) => res.json({ rooms: getTopicRoomStore().listRooms(principal(req), req.query.all === '1') }))
    app.post('/api/desktop/rooms', (req, res) => { try { res.status(201).json(getTopicRoomStore().createRoom(principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.patch('/api/desktop/rooms/:id', (req, res) => { try { res.json(getTopicRoomStore().updateRoom(req.params.id, principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.get('/api/desktop/rooms/:id/messages', (req, res) => { try { res.json({ messages: getTopicRoomStore().listMessages(principal(req), req.params.id, Number(req.query.limit || 200)) }) } catch (error) { res.status(404).json({ error: safeError(error) }) } })

    app.post('/api/desktop/rooms/:id/messages', async (req, res) => {
        const ownerId = principal(req)
        try {
            const roomStore = getTopicRoomStore()
            const room = roomStore.getRoom(req.params.id, ownerId)
            if (!room) return void res.status(404).json({ error: 'Room not found' })
            const content = String(req.body?.content || '').trim().slice(0, 100_000)
            if (!content) return void res.status(400).json({ error: 'Message content is required' })
            const selectedBotIds = Array.isArray(req.body?.botIds) ? req.body.botIds.map(String).filter((id: string) => room.botIds.includes(id)) : room.botIds
            if (selectedBotIds.length === 0) return void res.status(400).json({ error: 'Select at least one room bot' })
            const requestedNodes = Array.isArray(req.body?.nodeIds) ? req.body.nodeIds.map(String).filter((id: string) => room.preferredNodeIds.includes(id)) : room.preferredNodeIds
            const userMessage = roomStore.addMessage(ownerId, room.id, { authorType: 'user', authorId: ownerId, content, verifiedEvidence: 0 })
            const botStore = getBotProfileStore()
            const handler = resolveMessageHandler()
            const history = roomStore.listMessages(ownerId, room.id, 40)
            const authorizationUserId = `desktop:${ownerId}`
            getOrCreateUser(authorizationUserId, 'desktop', ownerId)
            if (isDesktopOwner(req)) setUserPermission(authorizationUserId, 'owner')

            const replies = await Promise.all(selectedBotIds.slice(0, 8).map(async (botId: string) => {
                const bot = botStore.get(botId, ownerId)
                if (!bot?.enabled) return { botId, error: 'Bot unavailable' }
                try {
                    if (bot.source !== 'nova') {
                        const external = await withDesktopBotTimeout(getExternalAgentRegistry().complete(bot.externalConnectionId || '', ownerId, [
                            { role: 'system', content: `${bot.instructions}\nDu bist als externer ${bot.source}-Bot in einem Nova-Themenraum. Behaupte niemals, Nova-Tools ausgefuehrt zu haben.` },
                            { role: 'user', content: history.map(item => `[${item.authorId}] ${item.content}`).join('\n').slice(-30_000) },
                        ]))
                        const stored = roomStore.addMessage(ownerId, room.id, { authorType: 'bot', authorId: bot.id, content: external.content, model: external.model, node: bot.source, verifiedEvidence: 0 })
                        return { botId, message: stored, external: true }
                    }
                    if (!handler) throw new Error('Nova message handler is not ready')
                    let outcome: DesktopAgentOutcome | undefined
                    const modelCatalog = getDesktopModelCatalog().models
                    const pinnedRoute = room.modelMode === 'pinned'
                        ? modelCatalog.find(item => item.routeId === room.pinnedRouteId)
                            || modelCatalog.find(item => item.id === room.pinnedModel && (requestedNodes.length === 0 || requestedNodes.includes(item.nodeId)))
                        : undefined
                    if (room.modelMode === 'pinned' && !pinnedRoute) throw new Error('Pinned model route is no longer verified')
                    const response = await withDesktopBotTimeout(runWithDesktopAgentContext({
                        principalId: ownerId, clientId: desktopClientId(req), authorizationUserId,
                        roomId: room.id, botId: bot.id, preferredNodeIds: requestedNodes,
                        modelMode: room.modelMode, pinnedModel: pinnedRoute?.id || room.pinnedModel,
                        pinnedProvider: pinnedRoute?.provider,
                        pinnedNodeId: pinnedRoute?.nodeId,
                        pinnedEndpoint: pinnedRoute?.endpoint,
                        workspaceId: room.workspaceId,
                        memoryAssetIds: getMemoryAssetCatalog().resolve(ownerId, [
                            { type: 'principal', id: ownerId }, { type: 'bot', id: bot.id }, { type: 'room', id: room.id },
                        ], room.memoryAssetIds).map(asset => asset.id),
                        onOutcome: value => { outcome = value },
                    }, () => handler(mitRaumVerlauf(content, history), 'desktop')))
                    const state = (globalThis as any).__novaState
                    const stored = roomStore.addMessage(ownerId, room.id, {
                        authorType: 'bot', authorId: bot.id, content: response,
                        model: outcome?.model || state?.llm?.modelId,
                        node: outcome?.node || process.env.NOVA_NODE_ID || 'local',
                        runId: outcome?.runId,
                        verifiedEvidence: outcome?.verifiedEvidence || 0,
                        evidence: outcome ? {
                            durationMs: outcome.durationMs, tools: outcome.tools, action: outcome.action,
                        } : undefined,
                    })
                    return { botId, message: stored, external: false }
                } catch (error) {
                    const message = roomStore.addMessage(ownerId, room.id, { authorType: 'system', authorId: bot.id, content: `Bot fehlgeschlagen: ${safeError(error)}`, verifiedEvidence: 0 })
                    return { botId, message, error: safeError(error) }
                }
            }))
            res.json({ accepted: userMessage, replies })
        } catch (error) { res.status(500).json({ error: safeError(error) }) }
    })

    app.get('/api/desktop/models', (_req, res) => res.json(getDesktopModelCatalog()))
    app.post('/api/desktop/models/switch', async (req, res) => { try { res.json(await switchDesktopModel(req.body?.model, req.body?.provider)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })

    app.get('/api/desktop/memory-assets', (req, res) => res.json({ assets: getMemoryAssetCatalog().list(principal(req)), bindings: getMemoryAssetCatalog().bindings(principal(req)) }))
    app.post('/api/desktop/memory-assets', (req, res) => { try { res.status(201).json(getMemoryAssetCatalog().create(principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.patch('/api/desktop/memory-assets/:id', (req, res) => { try { res.json(getMemoryAssetCatalog().update(req.params.id, principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.post('/api/desktop/memory-assets/:id/bind', (req, res) => { try { res.json(getMemoryAssetCatalog().bind(principal(req), req.body?.targetType, req.body?.targetId, req.params.id, req.body?.enabled !== false, Number(req.body?.priority || 50))) } catch (error) { res.status(400).json({ error: safeError(error) }) } })

    app.get('/api/desktop/external-agents', (req, res) => res.json({ connections: getExternalAgentRegistry().list(principal(req)) }))
    app.post('/api/desktop/external-agents', (req, res) => { try { res.status(201).json(getExternalAgentRegistry().create(principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.post('/api/desktop/external-agents/:id/health', async (req, res) => { try { res.json(await getExternalAgentRegistry().health(req.params.id, principal(req))) } catch (error) { res.status(400).json({ error: safeError(error) }) } })

    app.get('/api/desktop/nodes', async (req, res) => { try { res.json(await getNodeEnrollmentService().inventory(req.query.all === '1')) } catch (error) { res.status(500).json({ error: safeError(error) }) } })
    app.post('/api/desktop/nodes/enrollments', (req, res) => { try { res.status(201).json(getNodeEnrollmentService().create(principal(req), req.body)) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.post('/api/desktop/nodes/enrollments/:id/approve', (req, res) => { try { res.json(getNodeEnrollmentService().approve(req.params.id, principal(req))) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.post('/api/desktop/nodes/enrollments/:id/ready', (req, res) => { try { res.json(getNodeEnrollmentService().markAwaitingNode(req.params.id, principal(req))) } catch (error) { res.status(400).json({ error: safeError(error) }) } })
    app.post('/api/desktop/nodes/enrollments/:id/cancel', (req, res) => { try { res.json(getNodeEnrollmentService().cancel(req.params.id, principal(req))) } catch (error) { res.status(400).json({ error: safeError(error) }) } })

    app.get('/api/desktop/control/next', (req, res) => {
        const clientId = String(req.query.clientId || '').trim()
        if (!clientId) return void res.status(400).json({ error: 'clientId is required' })
        res.json({ command: getDesktopControlQueue().next(principal(req), clientId) })
    })
    app.post('/api/desktop/control/:id/ack', (req, res) => {
        try {
            const queue = getDesktopControlQueue()
            const pending = queue.get(principal(req), req.params.id)
            if (!pending) return void res.status(404).json({ error: 'Desktop command not found' })
            const clientId = String(req.body?.clientId || '').trim().slice(0, 120)
            if (pending.status !== 'delivered' || pending.clientId !== clientId) {
                return void res.status(409).json({ error: 'Desktop command delivery does not match this client' })
            }
            const result = req.body?.success === true && ['capture_screen', 'workspace_operation'].includes(pending.action)
                ? receiveDesktopControlResult(pending.id, pending.action, req.body?.result)
                : undefined
            res.json(getDesktopControlQueue().acknowledge(
                principal(req), req.params.id, clientId,
                req.body?.success === true, req.body?.error ? String(req.body.error) : undefined, result,
            ))
        } catch (error) { res.status(409).json({ error: safeError(error) }) }
    })
    app.get('/api/desktop/control/history', (req, res) => {
        res.json({ commands: getDesktopControlQueue().list(principal(req), Number(req.query.limit || 50)) })
    })

    app.get('/api/desktop/security', (_req, res) => res.json({ blueTeamIncidents: getBlueTeamService().listIncidents(), redTeam: getLatestRedTeamResult(), redTeamScope: 'nova-local-self-test-only' }))
    app.post('/api/desktop/security/red-team/run', async (_req, res) => { try { res.json(await runRedTeam()) } catch (error) { res.status(500).json({ error: safeError(error) }) } })
    app.get('/api/desktop/modules', (_req, res) => res.json({ modules: getDesktopModuleCatalog() }))
    app.get('/api/desktop/forge', (req, res) => {
        const ownerId = principal(req)
        res.json({ proposals: isDesktopOwner(req) ? getSkillProposals(200) : getSkillProposals(200, ownerId) })
    })
    app.post('/api/desktop/forge/:id/authorize-sandbox', (req, res) => {
        if (!isDesktopOwner(req)) return void res.status(403).json({ error: 'Owner authorization required' })
        const proposal = getSkillProposals(500).find(item => item.id === req.params.id)
        if (!proposal) return void res.status(404).json({ error: 'Forge proposal not found' })
        const updated = updateSkillProposalStatus(proposal.id, 'approved', proposal.ownerId)
        if (!updated) return void res.status(409).json({ error: 'Proposal cannot enter sandbox authorization from its current stage' })
        res.json(updated)
    })
    app.post('/api/desktop/forge/:id/reject', (req, res) => {
        if (!isDesktopOwner(req)) return void res.status(403).json({ error: 'Owner authorization required' })
        const proposal = getSkillProposals(500).find(item => item.id === req.params.id)
        if (!proposal) return void res.status(404).json({ error: 'Forge proposal not found' })
        const updated = updateSkillProposalStatus(proposal.id, 'rejected', proposal.ownerId)
        if (!updated) return void res.status(409).json({ error: 'Proposal cannot be rejected from its current stage' })
        res.json(updated)
    })

    app.get('/api/desktop/trust/runs', (req, res) => {
        const ownerId = principal(req)
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
        const runs = getOutcomeLedger().listRuns(500)
            .filter(run => !run.userId || run.userId === ownerId)
            .slice(0, limit)
        res.json({
            runs,
            summary: {
                total: runs.length,
                running: runs.filter(run => run.status === 'running').length,
                awaitingApproval: runs.filter(run => run.status === 'awaiting_approval').length,
                completed: runs.filter(run => run.status === 'completed').length,
                failed: runs.filter(run => run.status === 'failed').length,
                verified: runs.filter(run => run.validation?.success).length,
            },
        })
    })
    app.get('/api/desktop/trust/runs/:id', (req, res) => {
        const run = getOutcomeLedger().getRun(req.params.id)
        if (!run || (run.userId && run.userId !== principal(req))) return void res.status(404).json({ error: 'Outcome run not found' })
        res.json({ ...run, checkpoint: getOutcomeLedger().loadCheckpoint(run.runId) })
    })

    app.get('/api/desktop/memory', (req, res) => {
        const ownerScope = `user:${principal(req)}`
        const governance = getMemoryGovernanceCoordinator()
        const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
        const records = governance.list({ scope: ownerScope }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
        res.json({ scope: ownerScope, stats: governance.getStats(), records })
    })
}
