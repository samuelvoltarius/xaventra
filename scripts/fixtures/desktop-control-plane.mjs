// Isolated UI contract fixture, NOT a real agent, provider or Mesh authority.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createFixtureViews } from './desktop-views.mjs'

const RENDERER = resolve(import.meta.dirname, '../../desktop/renderer')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

export async function createDesktopFixture(options = {}) {
  const requests = []
  const views = createFixtureViews()
  const rooms = ['alpha', 'beta'].map(id => ({ id, title: `Test ${id}`, topic: 'Isolated Desktop acceptance', botIds: ['nova', 'researcher'], preferredNodeIds: [], modelMode: 'auto' }))
  const messages = Object.fromEntries(rooms.map(room => [room.id, Array.from({ length: 24 }, (_, i) => ({
    id: `${room.id}-${i}`, authorType: i % 2 ? 'bot' : 'user', authorId: i % 2 ? 'nova' : 'fixture-user',
    content: `${room.id} history ${i}: ${'Readable conversation history. '.repeat(4)}`, createdAt: '2026-01-01T12:00:00Z',
  }))]))
  // ownerViews=false simulates a client without the Desktop owner token (403 on the views).
  const controls = { bootstrapStatus: 200, postStatus: 200, delayMs: 0, roomPatchDelayMs: 0, omitAuthority: false, ownerViews: true, requests, rooms, messages, views }
  const bootstrap = () => ({
    controlPlane: controls.omitAuthority ? undefined : { nodeId: 'fixture-main', hostname: 'Test Main', authoritative: true, mainEpoch: 1 },
    rooms, bots: ['nova', 'researcher'].map(id => ({ id, name: id === 'nova' ? 'Xaventra' : 'Researcher', source: 'nova', avatar: 'X', color: '#4F7CFF' })),
    models: { activeModel: 'fixture-model', models: ['one', 'two'].map(id => ({ id: 'fixture-model', routeId: `fixture-${id}::vllm::fixture-model`, nodeId: `fixture-${id}`, runtime: 'vllm', status: 'running', supportsTools: true })) },
    inventory: { nodes: [{ id: 'fixture-main', name: 'Test Main', status: 'online', version: '2.83.0' }, { id: 'fixture-one', name: 'Testknoten', status: 'online', version: '2.83.0' }], enrollments: [] },
    security: {}, modules: [], memoryAssets: { assets: [] },
  })
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const url = new URL(req.url, 'http://fixture.invalid')
    requests.push({ method: req.method, path: url.pathname, body })
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    // Same renderer files over HTTP (browser path of the one shared UI).
    if (options.serveRenderer && req.method === 'GET' && (url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
      const name = url.pathname === '/app' || url.pathname === '/app/' ? 'index.html' : url.pathname.slice(5)
      if (!/^[a-z-]+\.(?:html|js|css)$/.test(name)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': TYPES[extname(name)] })
      return res.end(readFileSync(join(RENDERER, name)))
    }
    const viewPaths = { '/api/desktop/heute': 'heute', '/api/desktop/arbeit': 'arbeit', '/api/desktop/system': 'system', '/api/desktop/system/vms': 'vms', '/api/desktop/gedaechtnis': 'gedaechtnis', '/api/desktop/memory': 'memory', '/api/desktop/memory-assets': 'memoryAssets' }
    if (viewPaths[url.pathname] && req.method === 'GET') {
      if (!controls.ownerViews && !['/api/desktop/memory', '/api/desktop/memory-assets'].includes(url.pathname)) return reply(403, { error: 'Owner authorization required' })
      return reply(200, views[viewPaths[url.pathname]])
    }
    const answer = url.pathname.match(/^\/api\/desktop\/karten\/(k[a-f0-9]{12})\/antwort$/)
    if (answer && req.method === 'POST') {
      if (!controls.ownerViews) return reply(403, { error: 'Owner authorization required' })
      const card = views.heute.karten.find(item => item.id === answer[1])
      if (!card || card.status !== 'offen' || !card.antworten.includes(body?.answer)) return reply(409, { ok: false, error: 'Karte wurde bereits beantwortet.' })
      views.heute.karten = views.heute.karten.filter(item => item !== card)
      const decided = { ...card, status: body.answer, antwort: body.answer, antworten: [], decidedAt: new Date().toISOString(), entschiedenUeber: 'desktop', ergebnis: { ok: true, text: body.answer === 'nein' ? 'Abgelehnt.' : 'Fixture: nichts ausgeführt.' } }
      views.heute.entschieden = [decided, ...views.heute.entschieden]
      return reply(200, { ok: true, code: 'ok', message: `${body.answer === 'nein' ? 'Nein' : 'Ja'}: Fixture hat nichts ausgeführt.`, karte: decided })
    }
    if (url.pathname.startsWith('/api/desktop/direct/')) return reply(409, { error: 'Desktop-Direktverbindung ist aus.', code: 'aus' })
    if (url.pathname === '/api/desktop/trust/runs') return reply(200, { runs: [], summary: { total: 0, running: 0, awaitingApproval: 0, completed: 0, failed: 0, verified: 0 } })
    if (url.pathname === '/api/desktop/trust/repairs') return reply(200, { proposals: [], authoritative: true })
    if (url.pathname === '/api/desktop/bootstrap') return reply(controls.bootstrapStatus, controls.bootstrapStatus === 200 ? bootstrap() : { error: 'Fixture authentication rejected' })
    if (url.pathname === '/api/desktop/control') return reply(200, { commands: [] })
    if (url.pathname === '/api/desktop/fortschritt') return reply(200, { schritt: 'Fixture request pending' })
    const match = url.pathname.match(/^\/api\/desktop\/rooms\/(alpha|beta)(\/messages)?$/)
    if (match) {
      const id = match[1]
      if (req.method === 'PATCH' && !match[2]) {
        await new Promise(resolve => setTimeout(resolve, controls.roomPatchDelayMs))
        Object.assign(rooms.find(room => room.id === id), body)
        return reply(200, rooms.find(room => room.id === id))
      }
      if (req.method === 'GET' && match[2]) return reply(200, { messages: messages[id] })
      if (req.method === 'POST' && match[2]) {
        const status = controls.postStatus
        await new Promise(resolve => setTimeout(resolve, controls.delayMs))
        if (status !== 200) return reply(status, { error: 'Fixture send failed; no action executed' })
        messages[id].push({ id: `${id}-request-${requests.length}`, authorType: 'user', authorId: 'fixture-user', content: body.content },
          { id: `${id}-reply-${requests.length}`, authorType: 'bot', authorId: 'nova', content: `Fixture reply: ${body.content}` })
        return reply(200, { ok: true })
      }
    }
    if (url.pathname.startsWith('/api/desktop/control/')) return reply(200, { ok: true })
    return reply(404, { error: `Unknown fixture endpoint ${url.pathname}` })
  })
  await new Promise(resolve => server.listen(options.port || 0, '127.0.0.1', resolve))
  return { ...controls, controls, endpoint: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
