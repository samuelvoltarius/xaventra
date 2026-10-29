import { createHash } from 'node:crypto'
import { requestSessionCapture, requestSessionInput } from '../host/capture-agent.js'
import { desktopActionArgs } from '../host/desktop-input.js'

export const MAX_NODE_CAPTURE_BYTES = 8 * 1024 * 1024
export interface NodeCaptureRequest { operation: 'capture'; principalId: string; runId: string }
/** One typed desktop action (move/click/type/key/scroll/open_url); requestId is the node journal key. */
export interface NodeInputRequest { operation: 'input'; principalId: string; runId: string; requestId: string; action: Record<string, unknown> }
export interface NodeCaptureReceipt { nodeId: string; capturedAt: string; bytes: number; sha256: string; base64: string; mimeType: 'image/png' }
/** Input success only names the executed step; the fresh capture is the read-back of its effect. */
export interface NodeInputReceipt { nodeId: string; input: { requestId: string; status: 'completed'; replayed: boolean }; capture: NodeCaptureReceipt }
const INPUT_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function validNodeCaptureRequest(value: unknown): value is NodeCaptureRequest | NodeInputRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const p = value as NodeInputRequest
    const context = typeof p.principalId === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(p.principalId)
        && typeof p.runId === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(p.runId)
    if ((p.operation as string) === 'capture') return context && Object.keys(p).every(k => ['operation', 'principalId', 'runId'].includes(k))
    if (p.operation !== 'input' || !context || !Object.keys(p).every(k => ['operation', 'principalId', 'runId', 'requestId', 'action'].includes(k))
        || typeof p.requestId !== 'string' || !INPUT_REQUEST_ID.test(p.requestId)) return false
    try { desktopActionArgs(p.action); return true } catch { return false }
}
export function validateNodeCapture(value: unknown, nodeId: string): NodeCaptureReceipt {
    const p = value as NodeCaptureReceipt
    if (!p || p.nodeId !== nodeId || p.mimeType !== 'image/png' || !Number.isInteger(p.bytes) || p.bytes < 24 || p.bytes > MAX_NODE_CAPTURE_BYTES
        || typeof p.base64 !== 'string' || p.base64.length > Math.ceil(MAX_NODE_CAPTURE_BYTES / 3) * 4
        || typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256)
        || typeof p.capturedAt !== 'string' || !Number.isFinite(Date.parse(p.capturedAt))
        || Math.abs(Date.now() - Date.parse(p.capturedAt)) > 60_000) throw new Error('invalid or stale node capture receipt')
    const bytes = Buffer.from(p.base64, 'base64')
    if (bytes.length !== p.bytes || bytes.toString('base64') !== p.base64 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex'))
        || createHash('sha256').update(bytes).digest('hex') !== p.sha256) throw new Error('node capture hash/image mismatch')
    return { nodeId, capturedAt: p.capturedAt, bytes: p.bytes, sha256: p.sha256, base64: p.base64, mimeType: 'image/png' }
}
export async function captureEnrolledNode(nodeId: string, beforeCapture: () => Promise<void>, capture = requestSessionCapture): Promise<NodeCaptureReceipt> {
    // Enrollment is an explicit local operator choice. Main cannot enable a remote desktop.
    if (process.env.NOVA_MESH_CAPTURE_ENABLED !== '1') throw new Error('Node capture not enrolled; headless nodes have no desktop image')
    const socket = process.env.NOVA_CAPTURE_SOCKET, token = process.env.NOVA_CAPTURE_TOKEN_FILE
    if (!socket || !token) throw new Error('No enrolled graphical-session capture adapter on this node')
    await beforeCapture()
    const image = await capture(socket, token)
    await beforeCapture()
    if (image.length > MAX_NODE_CAPTURE_BYTES) throw new Error('Node capture exceeds size limit')
    return validateNodeCapture({ nodeId, capturedAt: new Date().toISOString(), bytes: image.length, sha256: createHash('sha256').update(image).digest('hex'), base64: image.toString('base64'), mimeType: 'image/png' }, nodeId)
}
export function validateNodeInput(value: unknown, nodeId: string, requestId: string): NodeInputReceipt {
    const p = value as NodeInputReceipt
    if (!p || p.nodeId !== nodeId || !p.input || p.input.requestId !== requestId || p.input.status !== 'completed' || typeof p.input.replayed !== 'boolean')
        throw new Error('invalid node input receipt')
    return { nodeId, input: { requestId, status: 'completed', replayed: p.input.replayed }, capture: validateNodeCapture(p.capture, nodeId) }
}
export async function inputEnrolledNode(nodeId: string, request: NodeInputRequest, beforeInput: () => Promise<void>,
    input = requestSessionInput, capture = requestSessionCapture): Promise<NodeInputReceipt> {
    // Input is a second explicit local operator choice on top of capture enrollment.
    if (process.env.NOVA_MESH_CAPTURE_ENABLED !== '1' || process.env.NOVA_DESKTOP_INPUT_ENABLED !== '1') throw new Error('Node input not enrolled on this node')
    const socket = process.env.NOVA_CAPTURE_SOCKET, token = process.env.NOVA_CAPTURE_TOKEN_FILE
    if (!socket || !token) throw new Error('No enrolled graphical-session adapter on this node')
    if (!validNodeCaptureRequest(request) || request.operation !== 'input') throw new Error('Invalid node input request')
    await beforeInput()
    const done = await input(socket, token, request.requestId, request.action)
    if (done?.requestId !== request.requestId || done?.status !== 'completed') throw new Error('Desktop input receipt mismatch; effect uncertain')
    const after = await captureEnrolledNode(nodeId, beforeInput, capture)
    return validateNodeInput({ nodeId, input: { requestId: request.requestId, status: 'completed', replayed: done.replayed === true }, capture: after }, nodeId, request.requestId)
}
