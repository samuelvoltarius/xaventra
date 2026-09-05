/** Central OpenTelemetry pipeline for Nova's control and data planes. */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { trace, metrics, SpanStatusCode, type Tracer, type Meter, type Histogram, type Counter, type Span } from '@opentelemetry/api'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { resolveConfigPath } from '../config/config-path.js'


export interface TelemetryConfig {
    enabled?: boolean
    endpoint?: string
    fallbackEndpoints?: string[]
    serviceName?: string
    prometheusPort?: number
    exportIntervalMs?: number
}

type Attributes = Record<string, string | number | boolean>

let _sdk: NodeSDK | null = null
let _enabled = false
let _endpoint: string | null = null
let _tracer: Tracer | null = null
let _meter: Meter | null = null

let _llmRequestCounter: Counter | null = null
let _llmTokenHistogram: Histogram | null = null
let _llmLatencyHistogram: Histogram | null = null
let _toolCallCounter: Counter | null = null
let _toolLatencyHistogram: Histogram | null = null
let _channelMessageCounter: Counter | null = null
let _meshEventCounter: Counter | null = null
let _executionCounter: Counter | null = null
let _outcomeCounter: Counter | null = null
let _evidenceCounter: Counter | null = null
let _mainRoleCounter: Counter | null = null

function packageVersion(): string {
    try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' }
}

function normalizeEndpoint(value: string): string {
    return value.trim().replace(/\/$/, '').replace(/\/v1\/(traces|metrics)$/, '')
}

function configuredEndpoints(config: TelemetryConfig): string[] {
    const env = [process.env.NOVA_OTEL_ENDPOINT, process.env.OTEL_EXPORTER_OTLP_ENDPOINT]
    const configured = [config.endpoint, ...(config.fallbackEndpoints || []), ...env]
    return [...new Set(configured.filter((value): value is string => Boolean(value)).map(normalizeEndpoint))]
}

async function endpointReachable(endpoint: string): Promise<boolean> {
    try {
        // Any HTTP response proves that the collector is reachable. An OTLP
        // endpoint commonly answers GET with 404/405, which is still healthy.
        await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(1500) })
        return true
    } catch { return false }
}

async function selectEndpoint(config: TelemetryConfig): Promise<string> {
    const candidates = configuredEndpoints(config)
    if (!candidates.length) candidates.push('http://localhost:4318')
    for (const candidate of candidates) if (await endpointReachable(candidate)) return candidate
    // Exporters retry asynchronously. Keep the preferred endpoint even if it
    // is temporarily down instead of blocking Nova's startup.
    return candidates[0]
}

function loadConfig(): TelemetryConfig | undefined {
    try {
        const path = resolveConfigPath()
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).telemetry : undefined
    } catch { return undefined }
}

export const initTelemetry = async (provided?: TelemetryConfig): Promise<void> => {
    if (_sdk) return
    const config = provided || loadConfig()
    const enabledByEnv = process.env.NOVA_OTEL_ENABLED === 'true' || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.NOVA_OTEL_ENDPOINT
    if (!config?.enabled && !enabledByEnv) {
        console.log('[OTel] Telemetry disabled (set telemetry.enabled=true to activate)')
        return
    }

    const endpoint = await selectEndpoint(config || {})
    const serviceName = config?.serviceName || 'nova'
    const exportInterval = Math.max(5_000, config?.exportIntervalMs || 15_000)
    const nodeId = process.env.NOVA_NODE_ID || hostname()
    const nodeOnly = process.env.NOVA_NODE_ONLY === 'true'
    const role = nodeOnly ? 'standby-worker' : 'control-main-candidate'
    const resource = resourceFromAttributes({
        'service.name': serviceName,
        'service.version': packageVersion(),
        'service.instance.id': nodeId,
        'host.name': hostname(),
        'os.type': process.platform,
        'nova.node.id': nodeId,
        'nova.node.role': role,
        'nova.mesh.mode': process.env.NOVA_MESH_MODE || 'unknown',
    })

    const sdk = new NodeSDK({
        resource,
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
        metricReader: new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
            exportIntervalMillis: exportInterval,
        }),
    })
    await sdk.start()
    _sdk = sdk
    _endpoint = endpoint
    _tracer = trace.getTracer(serviceName, packageVersion())
    _meter = metrics.getMeter(serviceName, packageVersion())

    _llmRequestCounter = _meter.createCounter('nova.llm.requests', { description: 'LLM requests' })
    _llmTokenHistogram = _meter.createHistogram('nova.llm.tokens', { description: 'LLM tokens', unit: 'tokens' })
    _llmLatencyHistogram = _meter.createHistogram('nova.llm.latency', { description: 'LLM latency', unit: 'ms' })
    _toolCallCounter = _meter.createCounter('nova.tool.calls', { description: 'Tool calls' })
    _toolLatencyHistogram = _meter.createHistogram('nova.tool.latency', { description: 'Tool latency', unit: 'ms' })
    _channelMessageCounter = _meter.createCounter('nova.channel.messages', { description: 'Channel messages' })
    _meshEventCounter = _meter.createCounter('nova.mesh.events', { description: 'Mesh envelope and node events' })
    _executionCounter = _meter.createCounter('nova.execution.events', { description: 'Execution Kernel events' })
    _outcomeCounter = _meter.createCounter('nova.outcome.events', { description: 'Outcome Ledger events' })
    _evidenceCounter = _meter.createCounter('nova.tool.evidence', { description: 'Verified and rejected tool evidence' })
    _mainRoleCounter = _meter.createCounter('nova.main.role_events', { description: 'Main role and lease events' })
    _enabled = true

    console.log(`[OTel] Telemetry initialized -> ${endpoint} (service: ${serviceName}, node: ${nodeId})`)
    const shutdown = () => { void shutdownTelemetry() }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
}

export const shutdownTelemetry = async (): Promise<void> => {
    const sdk = _sdk
    _sdk = null
    _enabled = false
    if (sdk) await sdk.shutdown().catch(() => undefined)
}

export const getTracer = (): Tracer | null => _tracer

export const withSpan = async <T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> => {
    if (!_enabled || !_tracer) return fn({ setAttribute: () => undefined, setStatus: () => undefined, recordException: () => undefined, end: () => undefined } as unknown as Span)
    return _tracer.startActiveSpan(name, { attributes }, async span => {
        try {
            const result = await fn(span)
            span.setStatus({ code: SpanStatusCode.OK })
            return result
        } catch (error) {
            span.recordException(error instanceof Error ? error : new Error(String(error)))
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) })
            throw error
        } finally { span.end() }
    })
}

export const recordLlmRequest = (params: { model: string; provider: string; inputTokens: number; outputTokens: number; latencyMs: number; success: boolean; failover?: boolean }): void => {
    if (!_enabled) return
    const attrs = { model: params.model || 'unknown', provider: params.provider || 'unknown', success: params.success, failover: Boolean(params.failover) }
    _llmRequestCounter?.add(1, attrs)
    _llmTokenHistogram?.record(params.inputTokens + params.outputTokens, { ...attrs, type: 'total' })
    _llmTokenHistogram?.record(params.inputTokens, { ...attrs, type: 'input' })
    _llmTokenHistogram?.record(params.outputTokens, { ...attrs, type: 'output' })
    _llmLatencyHistogram?.record(params.latencyMs, attrs)
}

export const recordToolCall = (params: { tool: string; latencyMs: number; success: boolean; verified?: boolean }): void => {
    if (!_enabled) return
    const attrs = { tool: params.tool || 'unknown', success: params.success, verified: Boolean(params.verified) }
    _toolCallCounter?.add(1, attrs)
    _toolLatencyHistogram?.record(params.latencyMs, attrs)
}

export const recordChannelMessage = (params: { channel: string; direction: 'inbound' | 'outbound'; success?: boolean }): void => {
    if (_enabled) _channelMessageCounter?.add(1, { channel: params.channel, direction: params.direction, success: params.success !== false })
}

export const recordMeshEvent = (params: { event: string; nodeId: string; kind?: string; direction?: string; transport?: string; status?: string }): void => {
    if (_enabled) _meshEventCounter?.add(1, {
        event: params.event, node_id: params.nodeId, kind: params.kind || 'unknown', direction: params.direction || 'internal',
        transport: params.transport || 'unknown', status: params.status || 'unknown',
    })
}

export const recordExecutionStage = (params: { stage: string; success: boolean; intent?: string }): void => {
    if (_enabled) _executionCounter?.add(1, { stage: params.stage, success: params.success, intent: params.intent || 'unknown' })
}

export const recordOutcomeEvent = (params: { type: string; status?: string; backend?: string }): void => {
    if (!_enabled) return
    const attributes = { type: params.type, status: params.status || 'unknown', backend: params.backend || 'unknown' }
    _outcomeCounter?.add(1, attributes)
    const span = _tracer?.startSpan('nova.outcome.event', { attributes })
    span?.end()
}

export const recordToolEvidence = (params: { tool: string; verified: boolean; source?: string }): void => {
    if (!_enabled) return
    const attributes = { tool: params.tool || 'unknown', verified: params.verified, source: params.source || 'outcome-ledger' }
    _evidenceCounter?.add(1, attributes)
    const span = _tracer?.startSpan('nova.tool.evidence', { attributes })
    span?.end()
}

export const recordMainRole = (params: { event: string; service: string; leader: boolean; coordinator?: string }): void => {
    if (_enabled) _mainRoleCounter?.add(1, { event: params.event, service: params.service, leader: params.leader, coordinator: params.coordinator || 'unknown' })
}

export const telemetryHealth = (): { enabled: boolean; endpoint: string | null; nodeId: string } => ({
    enabled: _enabled, endpoint: _endpoint, nodeId: process.env.NOVA_NODE_ID || hostname(),
})

export const isTelemetryEnabled = (): boolean => _enabled
