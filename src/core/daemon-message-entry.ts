/**
 * External message entry of the daemon (channels, REST, voice, mesh-direct,
 * queue replays). Extracted from daemon.ts so the trust boundary is testable.
 *
 * Everything that arrives here is untrusted text. Mission protocol markers
 * (`[NOVA_MISSION_KEY:` / `[NOVA_MISSION_FENCE:`) are stripped before the
 * pipeline parses them. Only the mission engine adds such markers, and it
 * calls the pipeline directly (daemon.ts initMissionEngine → _handleMessage),
 * never through this entry.
 */

import { stripMissionProtocolMarkers } from './execution-control.js'
import { isNovaSystemAuthored } from './system-message.js'
import type { MessageContext, MessageExecutionOptions } from './message-pipeline.js'
import type { PrincipalContext } from '../users/principal-id.js'
import { startTrace, endTrace, runWithTrace, traceLog } from './request-tracer.js'
import { interactiveRequestGate } from './request-gate.js'
import { isImmediateControl } from './control-command.js'
import { getMessageBus } from './message-bus.js'
import { recordChannelMessage, recordExecutionStage, withSpan } from '../infra/telemetry.js'

export type PipelineHandler = (
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    state: any,
    handleCommand: (cmd: string, args: string, from: string, context?: PrincipalContext) => Promise<string | null>,
    image?: { data: string; mimeType: string },
    execution?: MessageExecutionOptions,
    messageContext?: MessageContext,
) => Promise<any>

export interface DaemonMessageEntryDeps {
    pipeline: PipelineHandler
    getState: () => any
    handleCommand: (cmd: string, args: string, from: string, context?: PrincipalContext) => Promise<string | null>
}

export type ExternalMessageHandler = (
    channel: string,
    from: string,
    content: string,
    replyFn: (msg: string) => Promise<void>,
    image?: { data: string; mimeType: string },
    execution?: MessageExecutionOptions,
    messageContext?: MessageContext,
) => Promise<any>

/**
 * Internal prefixes ([REMINDER], [HEARTBEAT], [SELF-THINK], ...) make the
 * pipeline treat a message as system-authored. In external text they are
 * neutralized ("[REMINDER]" -> "(REMINDER]"), so nobody can fake a system
 * message. Only producers that pass `execution.systemAuthored` keep them.
 */
export function neutralizeInternalPrefixes(content: string): string {
    let text = content
    for (let guard = 0; guard < 8 && isNovaSystemAuthored({ content: text }); guard++) {
        const start = text.length - text.trimStart().length
        text = `${text.slice(0, start)}(${text.slice(start + 1)}`
    }
    return text
}

export function createDaemonMessageEntry(deps: DaemonMessageEntryDeps): ExternalMessageHandler {
    const active = new Map<string, Set<AbortController>>()
    return async function handleMessage(channel, from, rawContent, replyFn, image, execution, messageContext) {
        // Trust boundary: external text never carries mission protocol markers.
        const stripped = stripMissionProtocolMarkers(String(rawContent ?? ''))
        const content = execution?.systemAuthored === true ? stripped : neutralizeInternalPrefixes(stripped)
        const control = isImmediateControl(content) && !execution && !image
        const scope = JSON.stringify([channel.toLowerCase(), from, messageContext?.chatId || from])
        const controller = !content.startsWith('/') && !execution ? new AbortController() : undefined
        const commandHandler = control && content.trim().toLowerCase() === '/cancel'
            ? async (cmd: string, args: string, user: string, context?: PrincipalContext) => {
                // Called only after the pipeline's authentication/admission.
                if (cmd !== 'cancel') return deps.handleCommand(cmd, args, user, context)
                const requests = active.get(scope)
                for (const request of requests || []) request.abort(new Error('AbortError: request cancelled by user'))
                return requests?.size ? 'Die laufende Anfrage wird abgebrochen.' : 'Keine laufende Anfrage in diesem Chat.'
            } : deps.handleCommand
        const traceId = startTrace(channel, from, content)
        recordChannelMessage({ channel, direction: 'inbound' })
        const { getStateMachine } = await import('./state-machine.js')
        const runtimeState = getStateMachine()
        if (!runtimeState.beginOperation(traceId, `message:${channel}`)) {
            endTrace(traceId)
            throw new Error('Runtime state authority rejected duplicate or invalid message operation')
        }
        let runtimeError: string | undefined
        try {
            if (controller) {
                const requests = active.get(scope) || new Set<AbortController>()
                requests.add(controller); active.set(scope, requests)
            }
            getMessageBus().emitSync('user:message', { channel, userId: from, content, hasImage: Boolean(image) }, { source: 'daemon', correlationId: traceId })
            const priority = channel === 'internal' || from === 'Nova-Autonomy' ? -10 : 10
            return await withSpan('nova.channel.message', {
                'nova.trace.id': traceId,
                'nova.channel': channel,
                'nova.has_image': Boolean(image),
                'nova.system_authored': channel === 'internal' || from === 'Nova-Autonomy',
            }, async () => {
              const run = () => runWithTrace(traceId, async () => {
                traceLog(traceId, 'pipeline:start')
                recordExecutionStage({ stage: 'pipeline.started', success: true })
                const observedReply = async (message: string): Promise<void> => {
                    try {
                        await replyFn(message)
                        recordChannelMessage({ channel, direction: 'outbound', success: true })
                    } catch (error) {
                        recordChannelMessage({ channel, direction: 'outbound', success: false })
                        throw error
                    }
                }
                const result = await deps.pipeline(channel, from, content, observedReply, deps.getState(), commandHandler, image, execution || (controller ? { abortSignal: controller.signal } : undefined), messageContext)
                traceLog(traceId, 'pipeline:complete')
                recordExecutionStage({ stage: 'pipeline.completed', success: true })
                getMessageBus().emitSync('llm:response', { channel, userId: from, completed: true }, { source: 'pipeline', correlationId: traceId })
                return result
              })
              return control ? run() : interactiveRequestGate.run(run, priority)
            })
        } catch (error) {
            runtimeError = String(error).slice(0, 200)
            recordExecutionStage({ stage: 'pipeline.failed', success: false })
            getMessageBus().emitSync('system:error', { channel, userId: from, error: String(error) }, { source: 'pipeline', correlationId: traceId })
            throw error
        } finally {
            if (controller) {
                const requests = active.get(scope)
                requests?.delete(controller)
                if (!requests?.size) active.delete(scope)
            }
            runtimeState.completeOperation(traceId, runtimeError)
            endTrace(traceId)
        }
    }
}
