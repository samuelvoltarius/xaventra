import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createCaptureAgent, CaptureSessionLocked } from './capture-agent.js'

const token = 'capture-fixture-credential-'.repeat(3)
const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24)])
let server: ReturnType<typeof createCaptureAgent>, base: string
let capture: ReturnType<typeof vi.fn>
beforeEach(async () => {
    capture = vi.fn(async () => image)
    server = createCaptureAgent(token, capture)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
const call = (body: unknown, auth = token, path = '/v1/capture') => fetch(base + path, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
})
it('rejects wrong credentials before capture', async () => {
    expect((await call({ requestId: randomUUID() }, 'wrong')).status).toBe(401)
    expect(capture).not.toHaveBeenCalled()
})
it('rejects arbitrary commands, paths and extra fields', async () => {
    for (const body of [{ requestId: randomUUID(), command: 'id' }, { path: '/tmp/private' }, { requestId: 123 }, { requestId: [randomUUID()] }]) {
        expect((await call(body)).status).toBe(400)
    }
    expect((await call({ requestId: randomUUID() }, token, '/v1/exec')).status).toBe(404)
    expect(capture).not.toHaveBeenCalled()
})
it('returns a correlated hash-bound image only after capture succeeds', async () => {
    const id = randomUUID(), response = await call({ requestId: id })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-capture-request')).toBe(id)
    expect(response.headers.get('x-capture-sha256')).toBe(createHash('sha256').update(image).digest('hex'))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image)
    expect(capture).toHaveBeenCalledOnce()
})
it('fails closed for missing desktop and invalid image without leaking diagnostics', async () => {
    capture.mockRejectedValueOnce(new Error('private environment detail'))
    const response = await call({ requestId: randomUUID() })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private environment')
    capture.mockResolvedValueOnce(Buffer.from('not a screenshot'))
    expect((await call({ requestId: randomUUID() })).status).toBe(503)
})
it('does not permit concurrent capture effects', async () => {
    let finish!: (value: Buffer) => void
    capture.mockImplementationOnce(() => new Promise<Buffer>(resolve => { finish = resolve }))
    const first = call({ requestId: randomUUID() })
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    expect((await call({ requestId: randomUUID() })).status).toBe(409)
    finish(image)
    expect((await first).status).toBe(200)
    expect(capture).toHaveBeenCalledOnce()
})
it('reports a locked session without presenting an image or unlocking it', async () => {
    capture.mockRejectedValueOnce(new CaptureSessionLocked())
    const response = await call({ requestId: randomUUID() })
    expect(response.status).toBe(423)
    expect(response.headers.get('x-capture-sha256')).toBeNull()
    expect(await response.text()).toContain('unlock locally')
})
it('keeps input disabled on capture-only agents',async()=>{
 expect((await call({requestId:randomUUID(),action:{action:'key',key:'Tab'}},token,'/v1/input')).status).toBe(404)
})
it('authenticates input and returns only the correlated executor receipt',async()=>{
 await new Promise<void>(r=>server.close(()=>r()))
 const input=vi.fn(async(id:string)=>({requestId:id,status:'completed'}))
 server=createCaptureAgent(token,capture,input)
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as any).port}`
 const id=randomUUID(),body={requestId:id,action:{action:'key',key:'Tab'}}
 expect((await call(body,'wrong','/v1/input')).status).toBe(401);expect(input).not.toHaveBeenCalled()
 expect(await (await call(body,token,'/v1/input')).json()).toMatchObject({requestId:id,status:'completed'})
 expect(input).toHaveBeenCalledOnce();expect(capture).not.toHaveBeenCalled()
 input.mockRejectedValueOnce(new CaptureSessionLocked())
 expect((await call({...body,requestId:randomUUID()},token,'/v1/input')).status).toBe(423)
})
