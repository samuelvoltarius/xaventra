// Isolated UI contract fixture, NOT a real agent, provider or Mesh authority.
import { createServer } from 'node:http'

export async function createDesktopFixture() {
  const requests = []
  const rooms = ['alpha', 'beta'].map(id => ({ id, title: `Test ${id}`, topic: 'Isolated Desktop acceptance', botIds: ['nova', 'researcher'], preferredNodeIds: [], modelMode: 'auto' }))
  const messages = Object.fromEntries(rooms.map(room => [room.id, Array.from({ length: 24 }, (_, i) => ({
    id: `${room.id}-${i}`, authorType: i % 2 ? 'bot' : 'user', authorId: i % 2 ? 'nova' : 'fixture-user',
    content: `${room.id} history ${i}: ${'Readable conversation history. '.repeat(4)}`, createdAt: '2026-01-01T12:00:00Z',
  }))]))
  const controls = { bootstrapStatus: 200, postStatus: 200, delayMs: 0, requests, rooms, messages }
  const bootstrap = () => ({
    controlPlane: { nodeId: 'fixture-main', hostname: 'Test Main', authoritative: true, mainEpoch: 1 },
    rooms, bots: ['nova', 'researcher'].map(id => ({ id, name: id === 'nova' ? 'Xaventra' : 'Researcher', source: 'nova', avatar: 'X', color: '#4F7CFF' })),
    models: { activeModel: 'fixture-model', models: ['one', 'two'].map(id => ({ id: 'fixture-model', routeId: `fixture-${id}::vllm::fixture-model`, nodeId: `fixture-${id}`, runtime: 'vllm', status: 'running', supportsTools: true })) },
    inventory: { nodes: [{ id: 'fixture-main', name: 'Test Main', status: 'online' }], enrollments: [] },
    security: {}, modules: [], memoryAssets: { assets: [] },
  })
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const url = new URL(req.url, 'http://fixture.invalid')
    requests.push({ method: req.method, path: url.pathname, body })
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/api/desktop/bootstrap') return reply(controls.bootstrapStatus, controls.bootstrapStatus === 200 ? bootstrap() : { error: 'Fixture authentication rejected' })
    if (url.pathname === '/api/desktop/control') return reply(200, { commands: [] })
    if (url.pathname === '/api/desktop/fortschritt') return reply(200, { schritt: 'Fixture request pending' })
    const match = url.pathname.match(/^\/api\/desktop\/rooms\/(alpha|beta)(\/messages)?$/)
    if (match) {
      const id = match[1]
      if (req.method === 'PATCH' && !match[2]) { Object.assign(rooms.find(room => room.id === id), body); return reply(200, rooms.find(room => room.id === id)) }
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { ...controls, controls, endpoint: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
