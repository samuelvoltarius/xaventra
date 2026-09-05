/**
 * Nova Slash Commands - Extracted from daemon.ts
 * 
 * All /command handlers for Nova. Extracted to keep daemon.ts manageable.
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { compatiblePrincipalScopes, principalScope, resolvePrincipalId, type PrincipalContext } from '../users/principal-id.js'
import type { CodexDisplayModel } from '../auth/codex-runtime.js'
import { resolveConfigPath } from '../config/config-path.js'


// Dynamic version from package.json
const NOVA_VERSION = (() => {
    try {
        const pkgPath = join(process.cwd(), 'package.json')
        if (existsSync(pkgPath)) {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
            return pkg.version || '0.0.0'
        }
        return '0.0.0'
    } catch {
        return '0.0.0'
    }
})()

// ============================================
// Types
// ============================================

export interface DaemonState {
    running: boolean
    channels: { telegram: any; whatsapp: any; discord: any }
    llm: any
    internalLlm: any
    memory: any
    learning: any
    tools: any
    resilience: any
    startTime: number
    [key: string]: any
}

export interface LLMEntry {
    provider: string
    model: string
    local: boolean
}

// ============================================
// Command Handler
// ============================================

export async function handleCommand(
    cmd: string,
    args: string,
    from: string,
    state: DaemonState,
    availableLLMs: LLMEntry[],
    principalContext?: PrincipalContext,
): Promise<string | null> {
    // Store state globally for Telegram inline button callbacks
    ; (globalThis as any).__novaState = state
    const requestPermission = principalContext?.permission || 'guest'

    switch (cmd) {
        case 'world':
        case 'worldmodel':
        case 'lagebild': {
            try {
                const { buildNovaWorldModel, formatNovaWorldModel } = await import('./world-model.js')
                const principalId = principalContext?.principalId
                    || resolvePrincipalId((state as any).config, principalContext?.channel || 'unknown', from)
                return formatNovaWorldModel(await buildNovaWorldModel(principalId))
            } catch (error) {
                return `❌ Lagebild nicht verfügbar: ${String(error)}`
            }
        }

        case 'failover': {
            try {
                const { inspectFailoverReadiness, formatFailoverReadiness } = await import('../mesh/failover-readiness.js')
                return formatFailoverReadiness(await inspectFailoverReadiness())
            } catch (error) {
                return `❌ Failover-Readiness nicht verfügbar: ${String(error)}`
            }
        }

        case 'benchmark': {
            const sub = args.trim().toLowerCase() || 'status'
            try {
                if (sub === 'run' || sub === 'start' || sub === 'full') {
                    if (requestPermission !== 'owner' && requestPermission !== 'admin') return '🔒 Benchmarks dürfen nur Owner/Admin starten.'
                    const { runNovaBenchmark } = await import('../benchmark/nova-benchmark-runner.js')
                    void runNovaBenchmark('full').catch(error => console.error(`[Benchmark] full run failed: ${error}`))
                    return '🧪 Der vollständige Benchmark läuft isoliert im Hintergrund. Das Ergebnis wird dauerhaft im Benchmark-Lab gespeichert.'
                }
                const { listBenchmarkReports } = await import('../benchmark/benchmark-lab.js')
                const latest = listBenchmarkReports(1)[0] as any
                if (!latest) return '🧪 Noch kein Benchmark-Bericht vorhanden.'
                const metrics = latest.metrics || {}
                return [
                    '🧪 Letzter Benchmark',
                    `Zeit: ${latest.createdAt || latest.file}`,
                    `Aufgaben: ${metrics.scenarios || 0}`,
                    `Erfolg: ${Math.round(Number(metrics.taskCompletionRate || 0) * 100)}%`,
                    `Tool-Ausführung: ${Math.round(Number(metrics.correctToolExecutionRate || 0) * 100)}%`,
                    `Resume: ${Math.round(Number(metrics.resumeRate || 0) * 100)}%`,
                    `Memory: ${Math.round(Number(metrics.memoryPrecision || 0) * 100)}%`,
                    `Falsche Fertigmeldungen: ${metrics.falseCompletions || 0}`,
                ].join('\n')
            } catch (error) {
                return `❌ Benchmark nicht verfügbar: ${String(error)}`
            }
        }

        case 'help':
        case 'hilfe':
        case 'befehle':
        {
            // Try Telegram buttons first
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendWithButtons(from, '✨ *Nova* — Was möchtest du tun?', [
                        [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '🧠 Layers', callback_data: 'cmd_layers' }],
                        [{ text: '🤖 Modell wechseln', callback_data: 'cmd_models' }, { text: '🎭 Persona', callback_data: 'cmd_persona' }],
                        [{ text: '💾 Memory', callback_data: 'cmd_memory' }, { text: '📚 Skills', callback_data: 'cmd_skills' }],
                        [{ text: '🖥️ Hosts', callback_data: 'cmd_hosts' }, { text: '🔍 Preflight', callback_data: 'cmd_preflight' }],
                        [{ text: '🎯 Mission', callback_data: 'cmd_mission' }, { text: '⏰ Remind', callback_data: 'cmd_remind' }],
                        [{ text: '🤖 Agents', callback_data: 'cmd_agents' }, { text: '🏭 Factory', callback_data: 'cmd_factory' }],
                        [{ text: '🌐 Nodes', callback_data: 'cmd_nodes' }, { text: '📊 Monitor', callback_data: 'cmd_monitor' }],
                        [{ text: '🤖 AI Services', callback_data: 'cmd_ai' }, { text: '📦 Update', callback_data: 'cmd_update' }],
                        [{ text: '🧠 Reasoning', callback_data: 'cmd_think' }, { text: '🔊 Verbose', callback_data: 'cmd_verbose' }],
                        [{ text: '💾 Save', callback_data: 'cmd_save' }, { text: '🧹 Clear', callback_data: 'cmd_clear' }],
                        [{ text: '📜 Log', callback_data: 'cmd_log' }, { text: '📋 Task', callback_data: 'cmd_task' }],
                        [{ text: '❤️ Heartbeat', callback_data: 'cmd_heartbeat' }, { text: '📋 Alle Befehle', callback_data: 'cmd_helptext' }],
                    ])
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            // Fallback: text-only help
            return `✨ *Nova Befehle*

*System:* /status /layers /model /models /strict /persona /info
*Reasoning:* /think /reasoning /verbose /debug
*Tasks:* /task /task history /log
*Memory:* /memory /skills /learn /lernstatus /korrektur
*SSH:* /hosts /hosts new /hosts del
*Mesh:* /nodes /nodes check /nodes models /nodes recommend /nodes scan /nodes install
*AI:* /ai scan /ai status /ai route
*Session:* /clear /save /compact /apikey
*Bots:* /bots /bot /bot team /swarm
*Agents:* /agents /subagent /factory
*Users:* /users /users list /users promote /users block
*Wave:* /wave new /wave approve /wave status
*Intelligence:* /roi /graph /scan
*Projekt:* /project
*Monitor:* /monitor
*Autonomie:* /autonom /mission /remind
*Pre-Flight:* /preflight /preflight local /preflight <host>
*Auth:* /codex status /codex login /codex logout
*Smart Home:* /hass list /hass on <entity> /hass off <entity> /hass toggle <entity>
*3D Drucker:* /printer status /printer files /printer start <file> /printer pause /printer gcode <cmd>
*Replan:* /replan /replan history`
        }

        case 'layers': {
            const coreRuntime = (state as any).coreRuntime
            const channelRouter = (state as any).channelRouter
            const metaLearning = (state as any).metaLearning

            const layerText = `📊 *Nova Layer-Status*

L8 Meta-Learning: ${metaLearning ? '✅ ' + metaLearning.getLearnedSkills().length + ' Skills' : '❌'}
L7 Learning & Swarm: ${state.learning ? '✅ aktiv' : '❌'}
L6 Memory (LanceDB): ${state.memory ? '✅ aktiv' : '❌'}
L5 LLM Adapters: ${state.llm ? '✅ ' + state.llm.modelId : '❌'}
L4 Secure Auth: ✅ (TokenManager)
L3 Core Runtime: ${coreRuntime ? '✅ State: ' + coreRuntime.getStatus().state : '❌'}
L2 Command Factory: ${state.tools ? '✅ ' + state.tools.getStats().total + ' Tools' : '❌'}
L1 Unified Channels: ${channelRouter ? '✅ aktiv' : '❌'}
L0 Resilience: ${state.resilience ? '✅ aktiv' : '❌'}

*Uptime:* ${Math.floor((Date.now() - state.startTime) / 60000)} Minuten`

            // Try Telegram buttons
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendWithButtons(from, layerText, [
                        [{ text: '🔄 Refresh', callback_data: 'cmd_layers' }, { text: '🛡️ Layer 0 Details', callback_data: 'cmd_layer0' }],
                        [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '⬅️ Menü', callback_data: 'cmd_help' }],
                    ])
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            return layerText
        }

        case 'deploy': {
            const { execSync } = await import('node:child_process')
            const config = JSON.parse((await import('node:fs')).readFileSync(
                resolveConfigPath(), 'utf-8'
            ))
            const nodes: { name: string, host: string }[] = config.nodes || []

            const progress: string[] = ['🚀 *Nova Deploy gestartet...*', '']

            // Step 1: Build
            try {
                progress.push('📦 Building TypeScript...')
                execSync('npx tsc', { cwd: process.cwd(), timeout: 60000 })
                progress.push('✅ Build erfolgreich')
            } catch (err: any) {
                return `❌ Build failed:\n\`\`\`\n${err.stderr?.toString().slice(0, 500) || err.message}\n\`\`\``
            }

            // Step 2: Deploy to nodes
            for (const node of nodes) {
                try {
                    progress.push(`📤 ${node.name} — backup + deploy...`)
                    execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${node.host} "cd ~/nova-core && rm -rf dist.bak && cp -r dist dist.bak 2>/dev/null || true"`, { timeout: 15000 })
                    execSync(`scp -o StrictHostKeyChecking=no -r dist/ xaventra.config.json ${node.host}:~/nova-core/`, { cwd: process.cwd(), timeout: 120000 })
                    progress.push(`✅ ${node.name} — files deployed`)
                } catch {
                    progress.push(`⚠️ ${node.name} — deploy fehlgeschlagen`)
                }
            }

            // Step 3: Restart remote daemons
            for (const node of nodes) {
                try {
                    execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${node.host} "cd ~/nova-core && { kill \\$(cat .nova.pid 2>/dev/null) 2>/dev/null || killall node 2>/dev/null || true; }; sleep 2; setsid bash -c 'NOVA_ROLE=edge NOVA_NODE_ONLY=true npx tsx src/daemon.ts > /tmp/nova-node.log 2>&1' &"`, { timeout: 30000 })
                    progress.push(`🔄 ${node.name} — daemon restarted`)
                } catch {
                    progress.push(`⚠️ ${node.name} — restart fehlgeschlagen`)
                }
            }

            progress.push('', '✅ *Deploy abgeschlossen!*')
            return progress.join('\n')
        }

        case 'rollback': {
            const { execSync } = await import('node:child_process')
            const config = JSON.parse((await import('node:fs')).readFileSync(
                resolveConfigPath(), 'utf-8'
            ))
            const nodes: { name: string, host: string }[] = config.nodes || []
            const results: string[] = ['🔄 *Nova Rollback...*', '']

            for (const node of nodes) {
                try {
                    const check = execSync(
                        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${node.host} "test -d ~/nova-core/dist.bak && echo yes || echo no"`,
                        { timeout: 10000 }
                    ).toString().trim()

                    if (check !== 'yes') {
                        results.push(`⚠️ ${node.name} — kein Backup vorhanden`)
                        continue
                    }

                    execSync(`ssh -o StrictHostKeyChecking=no ${node.host} "cd ~/nova-core && rm -rf dist && mv dist.bak dist && { kill \\$(cat .nova.pid 2>/dev/null) 2>/dev/null || killall node 2>/dev/null || true; }; sleep 2; setsid bash -c 'NOVA_ROLE=edge NOVA_NODE_ONLY=true npx tsx src/daemon.ts > /tmp/nova-node.log 2>&1' &"`, { timeout: 30000 })
                    results.push(`✅ ${node.name} — rollback + restart`)
                } catch {
                    results.push(`❌ ${node.name} — rollback fehlgeschlagen`)
                }
            }

            results.push('', '✅ *Rollback abgeschlossen!*')
            return results.join('\n')
        }

        case 'health':
        {
            if (args.trim().toLowerCase().startsWith('plan')) {
                const { scanAndBuildNodePlan } = await import('../mesh/node-planner.js')
                return await scanAndBuildNodePlan()
            }

            const { getNodeHealthMonitor } = await import('../layers/L21-node-health.js')
            const healthMon = getNodeHealthMonitor()

            // Force a fresh check
            const snapshots = await healthMon.checkAllNodes()
            if (snapshots.length === 0) {
                return '📡 Keine Nodes konfiguriert. Füge `nodes` zu xaventra.config.json hinzu.'
            }

            // Try Telegram buttons
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendWithButtons(from, healthMon.formatStatus(), [
                        [{ text: '🔄 Refresh', callback_data: 'cmd_health' }],
                    ])
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            return healthMon.formatStatus()
        }

        case 'models':
        case 'model':
        case 'switch': {
            const modelPrincipalId = principalContext?.principalId
                || resolvePrincipalId((state as any).config, principalContext?.channel || 'unknown', from)
            let codexDisplay: CodexDisplayModel | undefined
            try {
                const codexRuntime = await import('../auth/codex-runtime.js')
                codexDisplay = await codexRuntime.getCodexDisplayModel(modelPrincipalId)
            } catch { /* Codex is optional. */ }
            const visibleLLMs = [...availableLLMs]
            if (codexDisplay?.available && codexDisplay.authenticated && !visibleLLMs.some(entry =>
                entry.provider === codexDisplay?.provider && entry.model === codexDisplay?.model)) {
                visibleLLMs.push(codexDisplay)
            }

            // Unified handler: /models, /model, /switch all do the same thing
            // With args -> switch model directly
            if (args?.trim()) {
                const targetModel = args.trim()
                const found = visibleLLMs.find(l => l.model.toLowerCase() === targetModel.toLowerCase())

                if (found) {
                    let targetProvider = found.provider

                    if (targetProvider === 'openai-codex') {
                        return `✅ *Codex ist verbunden und wird automatisch bevorzugt.*\n\n📍 Modell: \`${found.model}\`\n📦 Provider: \`openai-codex\`\n🖥️ Node: \`${codexDisplay?.nodeId || 'local'}\`\n\nTool-Aufträge laufen weiterhin durch Novas Execution Kernel; bei Codex-Fehlern folgt das lokale vLLM.`
                    }

                    const switched = await state.llm.switchModel(found.model, targetProvider)

                    if (switched) {
                        return `\u2705 *Modell gewechselt!*\n\n\ud83d\udccd Neu: ${found.model}\n\ud83d\udce6 Provider: ${targetProvider}\n${found.local ? '\ud83d\udda5\ufe0f Lokal' : '\u2601\ufe0f Cloud'}`
                    } else {
                        return `\u274c Fehler beim Wechseln zu ${found.model}`
                    }
                }

                return `\u274c Modell "${targetModel}" nicht gefunden.\n\nVerf\u00fcgbar: ${visibleLLMs.map(l => l.model).join(', ')}`
            }

            // Try Telegram interactive model selector (provider → model → switch)
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendModelSelector(from, undefined, modelPrincipalId)
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            // Fallback: text-based listing (non-Telegram channels)
            const grouped: Record<string, string[]> = {}
            for (const l of visibleLLMs) {
                const key = l.provider
                if (!grouped[key]) grouped[key] = []
                grouped[key].push(l.model)
            }

            const activeModel = state.llm?.modelId || 'unknown'
            const activeProvider = state.llm?.provider || 'unknown'

            let text = `🤖 *Nova — Verfügbare Modelle*\n\n`
            text += `*Aktiv:* \`${activeProvider}/${activeModel}\`\n\n`

            const labels: Record<string, string> = {
                'openai': '🟢 OpenAI',
                'anthropic': '🟠 Anthropic (Claude)',
                'openrouter': '🌐 OpenRouter',
                'groq': '⚡ Groq',
                'openai-codex': '🔐 OpenAI Codex (OAuth)',
                'local': '💻 Lokal (Ollama)',
            }

            for (const [provider, models] of Object.entries(grouped)) {
                const label = labels[provider] || `📦 ${provider}`
                text += `*${label}*\n`
                for (const m of models) {
                    const marker = (m === activeModel) ? '✅ ' : '   '
                    text += `${marker}\`${m}\`\n`
                }
                text += '\n'
            }

            if (codexDisplay?.preferred) text += `_Codex ist für diesen User auf ${codexDisplay.nodeId} verbunden und wird automatisch bevorzugt._\n\n`
            text += `_${visibleLLMs.length} Modelle von ${Object.keys(grouped).length} Providern_\n`
            text += `_Wechseln: /switch <model>_`

            return text
        }

        case 'layer0': {
            // Detailed Layer 0 status - Resilience, Self-Repair, Security
            const resilience = state.resilience
            const selfRepairStats = {
                repairsAttempted: 0,
                repairsSuccessful: 0,
                lastRepair: null as number | null,
            }

            // Try to get self-repair stats
            try {
                const { getSelfRepairEngine } = await import('../layers/L0-self-repair.js')
                const engine = getSelfRepairEngine()
                const stats = engine.getStats()
                selfRepairStats.repairsAttempted = stats.totalRepairs || 0
                selfRepairStats.repairsSuccessful = stats.successfulRepairs || 0
                selfRepairStats.lastRepair = null  // Not tracked in current version
            } catch { }

            // Supervisor stats (patterns are defined in L0-supervisor.ts)
            const supervisorStats = { patternCount: 15, totalPatterns: 15 }  // Built-in patterns

            console.log('[Layer0] Status requested - showing in terminal AND chat')
            console.log(`[Layer0] Resilience: ${resilience ? 'ACTIVE' : 'INACTIVE'}`)
            console.log(`[Layer0] Self-Repair: ${selfRepairStats.repairsAttempted} attempts, ${selfRepairStats.repairsSuccessful} successful`)
            console.log(`[Layer0] Patterns: ${supervisorStats.patternCount || 0} tracked`)

            return `🛡️ *Layer 0 - Resilience & Security*

**Status:** ${resilience ? '✅ AKTIV' : '❌ INAKTIV'}

**Self-Repair Engine:**
• Reparaturen versucht: ${selfRepairStats.repairsAttempted}
• Erfolgreich: ${selfRepairStats.repairsSuccessful}
• Letzte Reparatur: ${selfRepairStats.lastRepair ? new Date(selfRepairStats.lastRepair).toLocaleString('de-DE') : 'Keine'}

**Supervisor:**
• Überwachte Patterns: ${supervisorStats.patternCount || 0}
• Pattern-Ersetzungen: ${supervisorStats.totalPatterns || 0}

**Heartbeat:** Alle 5 Minuten
**Error Handler:** Global aktiv

_Layer 0 läuft unabhängig und überwacht das gesamte System._`
        }

        case 'persona': {
            const { loadSoul, saveSoul, soulExists, parseOnboardingResponse } = await import('./soul.js')

            if (!args || args.trim() === '') {
                // Show current persona
                const soul = loadSoul()
                const personaText = `🎭 *Aktuelle Persona*

**Name:** ${soul.name}
**Sprache:** ${soul.language}

**Persönlichkeit:**
${soul.personality}

_Ändern mit: /persona Du heißt XY und bist ein ..._`

                // Try Telegram buttons
                try {
                    const { getTelegramAdapter } = await import('../channels/telegram.js')
                    const tg = getTelegramAdapter()
                    if (tg) {
                        await tg.sendWithButtons(from, personaText, [
                            [{ text: '🤖 Nova (Standard)', callback_data: 'persona_nova' }, { text: '👨‍💼 Business', callback_data: 'persona_business' }],
                            [{ text: '🎨 Kreativ', callback_data: 'persona_creative' }, { text: '💻 DevOps', callback_data: 'persona_devops' }],
                            [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '⬅️ Menü', callback_data: 'cmd_help' }],
                        ])
                        return '__HANDLED__'
                    }
                } catch { /* non-Telegram */ }

                return personaText
            }

            // Update persona
            const newSoul = parseOnboardingResponse(args)
            saveSoul(newSoul)

            console.log(`[Persona] Updated to: ${newSoul.name}`)

            return `✅ *Persona aktualisiert!*

**Neuer Name:** ${newSoul.name}
**Sprache:** ${newSoul.language}

**Persönlichkeit:**
${newSoul.personality}

_Änderung sofort aktiv._`
        }

        case 'think': {
            const { setUserThinkingLevel, getUserThinkingLevel } = await import('../intelligence/thinking.js')

            const mode = args.trim().toLowerCase()

            if (!mode) {
                // Show current mode
                const current = getUserThinkingLevel(from)
                return `🧠 *Thinking-Modus*

Aktuell: **${current.toUpperCase()}**

Optionen:
/think on - Denke immer vor Antworten
/think off - Kein explizites Denken
/think auto - Nova entscheidet selbst (Standard)

_Bei ON sieht der User mehr durchdachte Antworten.
<thinking> Tags werden NICHT angezeigt._`
            }

            if (mode === 'on' || mode === 'an') {
                setUserThinkingLevel(from, 'on')
                return '🧠✅ Thinking-Modus: **ON**\n\nNova denkt jetzt vor jeder Antwort explizit nach.'
            } else if (mode === 'off' || mode === 'aus') {
                setUserThinkingLevel(from, 'off')
                return '🧠❌ Thinking-Modus: **OFF**\n\nSchnelle Antworten ohne explizites Denken.'
            } else if (mode === 'auto') {
                setUserThinkingLevel(from, 'auto')
                return '🧠🤖 Thinking-Modus: **AUTO**\n\nNova entscheidet selbst ob Denken nötig ist.'
            }

            return `❓ Unbekannter Modus: "${mode}"\n\nGültig: on, off, auto`
        }

        case 'strict':
        case 'strict_implementation': {
            const { toggleStrictMode, isStrictMode } = await import('./strict-mode.js')

            const arg = args.trim().toLowerCase()

            if (arg === 'status') {
                const active = isStrictMode()
                return active
                    ? '🔒 Strict Implementation Mode ist **AN**\n\n_/strict zum Ausschalten_'
                    : '🔓 Strict Implementation Mode ist **AUS**\n\n_/strict zum Einschalten_'
            }

            const result = toggleStrictMode(from)
            return result.message
        }

        case 'supervisor': {
            const { getSupervisor } = await import('../supervisor/supervisor-manager.js')
            const supervisor = getSupervisor()
            const mode = args.trim().toLowerCase()

            if (mode === 'auto') {
                // Enable auto-fix mode
                ; (supervisor as any).config.autoFix = true
                return `🤖 *Supervisor: AUTO-FIX aktiviert*

Der Supervisor fixt Fehler jetzt automatisch mit LLM-Hilfe!

⚠️ Warnung: Änderungen werden ohne Bestätigung angewendet.`
            } else if (mode === 'manual') {
                ; (supervisor as any).config.autoFix = false
                return `👤 *Supervisor: MANUAL Mode*

Fehler werden erkannt, aber du musst Fixes manuell genehmigen.`
            }

            // Show status
            const status = supervisor.getStatus()
            const config = (supervisor as any).config
            return `🔧 *Supervisor Status*

**Modus:** ${config.autoFix ? '🤖 AUTO-FIX' : '👤 MANUAL'}
**Läuft:** ${status.isRunning ? '✅ Ja' : '❌ Nein'}
**Errors erkannt:** ${status.totalErrors}
**Patterns matched:** ${status.totalMatches}
**Fixes vorgeschlagen:** ${status.totalFixesProposed}
**Fixes angewendet:** ${status.totalFixesApplied}
**Fixes fehlgeschlagen:** ${status.totalFixesFailed}

*Befehle:*
/supervisor auto - Auto-Fix aktivieren
/supervisor manual - Manueller Modus`
        }

        case 'skills': {
            const ml = (state as any).metaLearning
            if (!ml) return '❌ Meta-Learning nicht aktiv'

            const skills = ml.getLearnedSkills()
            if (skills.length === 0) {
                return `📚 *Gelernte Skills*\n\nNoch keine Skills gelernt.\n\nVerwende /learn <fähigkeit> um eine neue Fähigkeit zu lernen.`
            }

            const skillList = skills.map((s: any) =>
                `• *${s.name}*\n  Quelle: ${s.source}\n  Genutzt: ${s.successCount}x`
            ).join('\n\n')

            return `📚 *Gelernte Skills (${skills.length})*\n\n${skillList}`
        }

        case 'learn': {
            if (!args) {
                const learnText = `📚 *Nova Learning*\n\nIch kann neue Skills lernen!\n\nBeispiel: \`/learn qr_code\`\n/learn screenshot\n/learn pdf_parse\n\nOder wähle eine Kategorie:`

                // Try Telegram buttons
                try {
                    const { getTelegramAdapter } = await import('../channels/telegram.js')
                    const tg = getTelegramAdapter()
                    if (tg) {
                        await tg.sendWithButtons(from, learnText, [
                            [{ text: '📸 Screenshot', callback_data: 'learn_screenshot' }, { text: '📄 PDF Parse', callback_data: 'learn_pdf_parse' }],
                            [{ text: '🔍 Web Scrape', callback_data: 'learn_web_scrape' }, { text: '📊 Data Analysis', callback_data: 'learn_data_analysis' }],
                            [{ text: '📋 Lernstatus', callback_data: 'cmd_lernstatus' }, { text: '⬅️ Menü', callback_data: 'cmd_help' }],
                        ])
                        return '__HANDLED__'
                    }
                } catch { /* non-Telegram */ }

                return learnText
            }

            const ml = (state as any).metaLearning
            if (!ml) return '❌ Meta-Learning nicht aktiv'

            const capability = args.toLowerCase().replace(/\s+/g, '_')
            const result = await ml.handleMissingCapability(capability, (msg: string) => {
                console.log(`[L8] ${msg}`)
            })

            if (result.success) {
                return `✅ *Skill gelernt!*\n\n${args}\n\n${result.toolCode ? 'Tool-Code generiert und gespeichert.' : 'Skill aktiviert.'}`
            } else {
                return `❌ Konnte Skill nicht lernen: ${result.error}`
            }
        }

        // ============================================
        // Self-Check — runs directly without LLM
        // "mach einen self check", /check, /selfcheck
        // ============================================
        case 'check':
        case 'selfcheck':
        case 'self-check': {
            const uptime = Math.floor((Date.now() - state.startTime) / 1000 / 60)
            const uptimeStr = uptime < 60 ? `${uptime}m` : `${Math.floor(uptime/60)}h ${uptime%60}m`
            const model = state.llm?.modelId || 'unbekannt'
            const provider = state.llm?.provider || 'unbekannt'

            // System health
            let health = '✅ OK'
            let disk = ''
            let ram = ''
            try {
                const { runHealthCheck } = await import('../layers/L0-health-monitor.js')
                const h = await runHealthCheck()
                if (!h.healthy) health = '⚠️ Issues'
                disk = h.disk.freeGB >= 0 ? `${h.disk.freeGB}GB frei (${h.disk.usedPercent}%)` : 'unbekannt'
                ram = h.memory.usedMB >= 0 ? `${h.memory.usedPercent}% verwendet` : 'unbekannt'
            } catch { /* ok */ }

            // LLM connectivity
            let llmStatus = '❓'
            try {
                const start = Date.now()
                await state.llm?.complete?.([{ role: 'user', content: '.' }])
                llmStatus = `✅ ${Date.now() - start}ms`
            } catch { llmStatus = '❌ Fehler' }

            // Nodes
            let nodeStatus = ''
            try {
                const { getNodeHealthMonitor } = await import('../layers/L21-node-health.js')
                const snapshots = getNodeHealthMonitor().getLastSnapshots()
                const online = snapshots.filter((n: any) => n.status === 'online').length
                const total = snapshots.length
                nodeStatus = `\n📡 Nodes: ${online}/${total} online`
            } catch { /* ok */ }

            // Tools
            const toolCount = state.tools?.getAll?.()?.length || 0

            // Cost today
            let costLine = ''
            try {
                const stats = (state as any).costTracker?.getTodayStats?.()
                if (stats) costLine = `\n💰 Heute: ${stats.totalRequests || 0} Requests, ${stats.totalTokens || 0} Tokens`
            } catch { /* ok */ }

            return `🔍 *Nova Self-Check*

🤖 Modell: ${provider}/${model}
⏱️ Uptime: ${uptimeStr}
🏥 System: ${health}
💾 Disk: ${disk}
🧠 RAM: ${ram}
🔗 LLM: ${llmStatus}
🛠️ Tools: ${toolCount}${nodeStatus}${costLine}

✅ Self-Check abgeschlossen`
        }

        case 'status': {
            const uptime = Math.floor((Date.now() - state.startTime) / 1000 / 60)
            const hours = Math.floor(uptime / 60)
            const mins = uptime % 60

            // Model info — read from config (the source of truth)
            let configModel = state.llm?.modelId || 'unknown'
            let configProvider = state.llm?.provider || 'unknown'
            try {
                const cfgPath = resolveConfigPath()
                if (existsSync(cfgPath)) {
                    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
                    configModel = cfg.model || configModel
                    configProvider = cfg.provider || configProvider
                }
            } catch { /* config read error */ }

            // Token tracking — use L14 CostTracker, then dashboard stats as fallback
            const costTracker = (state as any).costTracker
            const l14Stats = costTracker?.getTodayStats?.() || null
            let tokensIn = 0, tokensOut = 0, requestCount = 0

            if (l14Stats && (l14Stats.totalTokens > 0 || l14Stats.totalRequests > 0)) {
                tokensIn = l14Stats.inputTokens || l14Stats.totalTokens || 0
                tokensOut = l14Stats.outputTokens || 0
                requestCount = l14Stats.totalRequests || 0
            } else {
                // Fallback: read dashboard usage-stats.json directly
                try {
                    const { existsSync: ex, readFileSync: rd } = await import('node:fs')
                    const { join: pj } = await import('node:path')
                    const statsFile = pj(process.cwd(), '.nova-data', 'usage-stats.json')
                    if (ex(statsFile)) {
                        const ds = JSON.parse(rd(statsFile, 'utf-8'))
                        tokensIn = ds.tokensToday || 0
                        requestCount = ds.requestsToday || 0
                    }
                } catch { /* stats not available */ }
            }

            // Format token count
            const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

            // Active channels
            const channels: string[] = []
            if (state.channels.telegram) channels.push('Telegram')
            if (state.channels.whatsapp) channels.push('WhatsApp')
            if (state.channels.discord) channels.push('Discord')

            // Active layers count — keys must match actual state keys set in daemon.ts
            const layerKeys = [
                'llm', 'tools', 'memory', 'resilience', 'learning',
                'coreRuntime', 'channelRouter', 'metaLearning',
                'vision', 'astAnalyzer', 'costTracker',
                'businessSense', 'autonomousLearner',
                'serviceMonitor', 'selfImprovement',
                'correctionLearner', 'antiHallucination',
                'knowledgeGraph', 'journal', 'intelligence',
                'securityScanner', 'autonomy', 'lanceMemory',
            ]
            const activeLayers = layerKeys.filter(k => (state as any)[k]).length
            const totalLayers = layerKeys.length

            // Learning stats
            const corrStats = (state as any).correctionLearner?.getStats?.()
            const selfRules = (state as any).selfImprovement?.getRules?.()?.length || 0

            // Monitoring
            const monitorTargets = (state as any).serviceMonitor?.getTargets?.()?.length || 0

            // Build mesh model overview — group by endpoint/node
            const meshLines: string[] = []
            try {
                // Group local models by endpoint (node)
                const nodeMap = new Map<string, { name: string; models: string[] }>()
                for (const entry of availableLLMs) {
                    const entryAny = entry as { local?: boolean; endpoint?: string; nodeName?: string; model: string }
                    if (!entryAny.local || !entryAny.endpoint) continue
                    const host = entryAny.endpoint.replace(/https?:\/\//, '').replace(/\/.*$/, '')
                    const nodeName = entryAny.nodeName || host
                    if (!nodeMap.has(host)) nodeMap.set(host, { name: nodeName, models: [] })
                    // Skip embedding models
                    if (!/embed|nomic|bge|mxbai/i.test(entryAny.model)) {
                        nodeMap.get(host)!.models.push(entryAny.model)
                    }
                }
                for (const [host, info] of nodeMap) {
                    const isPrimary = info.models.includes(configModel)
                    const modelList = info.models.slice(0, 3).join(', ') + (info.models.length > 3 ? ` +${info.models.length - 3}` : '')
                    meshLines.push(`  ${isPrimary ? '★' : '○'} ${info.name} (${host}): ${modelList || '–'}`)
                }
                // Cloud fallbacks
                const cloudModels = availableLLMs.filter(l => !l.local).map(l => l.model).slice(0, 4)
                if (cloudModels.length > 0) meshLines.push(`  ☁ Cloud: ${cloudModels.join(' → ')}`)
            } catch { /* mesh info optional */ }

            const meshSection = meshLines.length > 0
                ? `\n*Mesh (${meshLines.filter(l => l.trim().startsWith('★') || l.trim().startsWith('○')).length} Nodes):*\n${meshLines.join('\n')}`
                : ''

            const statusText = `*Nova v${NOVA_VERSION} Status*

*Runtime:*
  Model: ${configModel}
  Provider: ${configProvider}
  Requests heute: ${requestCount}
  Tokens: ${fmtTokens(tokensIn)} in / ${fmtTokens(tokensOut)} out
  Uptime: ${hours}h ${mins}m${meshSection}

*System:*
  LLM: ${state.llm ? 'verbunden' : 'getrennt'}
  Memory: ${state.memory ? 'aktiv' : 'aus'}
  Learning: ${state.learning ? 'aktiv' : 'aus'}
  Tools: ${state.tools ? state.tools.getStats().total + ' geladen' : 'aus'}
  Resilience: ${state.resilience ? 'aktiv' : 'aus'}
  Layers aktiv: ${activeLayers}/${totalLayers}

*Intelligence:*
  Korrekturen: ${corrStats?.totalCorrections || 0} (${corrStats?.appliedCorrections || 0} angewendet)
  Self-Rules: ${selfRules}
  Monitor-Targets: ${monitorTargets}

*Channels:* ${channels.length > 0 ? channels.join(', ') : 'keine'}`

            // Try Telegram buttons
            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendWithButtons(from, statusText, [
                        [{ text: '🔄 Refresh', callback_data: 'cmd_status' }, { text: '🤖 Modell', callback_data: 'cmd_models' }],
                        [{ text: '🧠 Layers', callback_data: 'cmd_layers' }, { text: '🧹 Clear', callback_data: 'cmd_clear' }],
                    ])
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            return statusText
        }


        // NOTE: /model, /switch, /models are all handled by the unified handler above (line 128)

        case 'llm': {
            const { createOllamaClient, detectLocalLLMs } = await import('../llm/local-llm.js')
            const subCmd = args.split(' ')[0]?.toLowerCase()
            const param = args.split(' ').slice(1).join(' ')

            if (subCmd === 'local' || subCmd === 'ollama') {
                // Connect to local LLM - support: /llm local, /llm local 1234, /llm local http://server:port
                let url = 'http://localhost:11434'
                if (param) {
                    if (param.startsWith('http')) {
                        url = param
                    } else if (/^\d+$/.test(param)) {
                        url = `http://localhost:${param}`
                    }
                }

                console.log(`[Nova] Connecting to local LLM at ${url}...`)

                const { createLocalLLM } = await import('../llm/local-llm.js')
                const client = createLocalLLM({ baseUrl: url, model: 'llama3', name: 'LocalLLM' })
                const available = await client.checkAvailable()

                if (available) {
                    ; (state as any).localLLM = client
                    const models = await client.listModels()
                    return `✅ *Lokales LLM verbunden!*

🖥️ URL: ${url}
📦 Modelle: ${models.slice(0, 5).join(', ')}${models.length > 5 ? '...' : ''}

Verwende /llm model <name> um ein Modell zu wählen.`
                } else {
                    return `❌ *Konnte nicht verbinden*

URL: ${url}
Stelle sicher dass Ollama läuft: \`ollama serve\``
                }
            }

            if (subCmd === 'model' && param) {
                const client = (state as any).localLLM
                if (!client) return '❌ Erst /llm local ausführen!'
                client.setModel(param)
                // Also switch the main LLM to use this local model
                await state.llm.switchModel(param, 'local')
                return `✅ Lokales Modell gewechselt: ${param}`
            }

            if (subCmd === 'scan' || subCmd === 'detect') {
                const found = await detectLocalLLMs()
                if (found.length === 0) {
                    return `🔍 *Keine lokalen LLMs gefunden*

Starte Ollama: \`ollama serve\`
Dann: /llm local`
                }

                const list = found.map(f => `• **${f.name}**: ${f.models.slice(0, 3).join(', ')}`).join('\n')
                return `🔍 *Gefundene lokale LLMs:*\n\n${list}\n\nVerbinden: /llm local`
            }

            // Show help with Telegram buttons
            const llmHelpText = `🖥️ *Lokale LLM Befehle*

/llm local - Zu Ollama verbinden (localhost:11434)
/llm ollama - Alias für /llm local
/llm scan - Lokale LLMs suchen
/llm model <name> - Modell wechseln`

            try {
                const { getTelegramAdapter } = await import('../channels/telegram.js')
                const tg = getTelegramAdapter()
                if (tg) {
                    await tg.sendWithButtons(from, llmHelpText, [
                        [{ text: '🔗 Ollama verbinden', callback_data: 'llm_local' }, { text: '🔍 LLMs scannen', callback_data: 'llm_scan' }],
                        [{ text: '🤖 Modell wechseln', callback_data: 'cmd_models' }, { text: '📊 Status', callback_data: 'cmd_status' }],
                        [{ text: '⬅️ Menü', callback_data: 'cmd_help' }],
                    ])
                    return '__HANDLED__'
                }
            } catch { /* non-Telegram */ }

            return llmHelpText
        }
        case 'clear':
        case 'reset': {
            // Clear session completely
            const { clearSession } = await import('../agents/nova-runner.js')

            const { getDesktopAgentContext } = await import('../desktop/desktop-agent-context.js')
            const desktop = getDesktopAgentContext()
            const channel = principalContext?.channel || 'unknown'
            const principal = principalContext?.principalId || resolvePrincipalId(state.config, channel, from)
            const cleared = clearSession(principal, channel, { conversationId: desktop?.roomId, botId: desktop?.botId })

            console.log(`[Nova] Session cleared for ${from}`)
            return cleared
                ? '✅ *Gesprächskontext zurückgesetzt.*\n\nDer aktive Gesprächsverlauf und seine Zusammenfassung sind geleert. Dauerhafte Fakten und Anmeldungen bleiben erhalten.'
                : '✅ *Session war bereits leer.*'
        }

        case 'memory': {
            const [memoryAction = 'status', ...memoryArgs] = args.trim().split(/\s+/).filter(Boolean)
            const memoryId = memoryArgs[0]
            if (['governance', 'review', 'approve', 'reject', 'recall', 'recall-natural', 'forget-natural', 'consolidate'].includes(memoryAction)) {
                const { getMemoryGovernanceCoordinator } = await import('../memory/memory-governance.js')
                const governance = getMemoryGovernanceCoordinator()
                const principalId = principalContext?.principalId
                    || resolvePrincipalId((state as any).config, principalContext?.channel || 'unknown', from)
                const ownScope = principalScope(principalId)
                const permission = requestPermission
                const canGovernGlobal = permission === 'owner' || permission === 'admin'
                if (memoryAction === 'consolidate') {
                    if (!canGovernGlobal) return '🔒 Memory-Konsolidierung benötigt Owner/Admin.'
                    const result = await governance.consolidateExactDuplicates(`operator:${principalId}`)
                    const report = governance.getMaintenanceReport()
                    return `Memory-Konsolidierung: ${result.merged} exakte Duplikate zusammengeführt. ${report.activeConflictPairs.length} semantische Konflikte bleiben bewusst zur Prüfung offen.`
                }
                if (memoryAction === 'forget-natural') {
                    const target = memoryArgs.join(' ').trim()
                    if (!target) return 'Welche Erinnerung soll ich vergessen?'
                    const context: PrincipalContext = principalContext || {
                        channel: 'unknown',
                        rawUserId: from,
                        principalId,
                    }
                    const ownScopes = compatiblePrincipalScopes(context)
                    const all = target === '__all__'
                    const records = all
                        ? governance.list().filter(item => ownScopes.includes(item.scope)
                            && !['rejected', 'expired', 'superseded'].includes(item.status))
                        : governance.recall(ownScopes, target, 20)
                    let removed = 0
                    for (const record of records) {
                        if (await governance.rejectAndRetract(record.id, `user-forget:${principalId}`)) removed++
                    }
                    const { getSessionContinuityStore } = await import('../memory/session-summarizer.js')
                    removed += getSessionContinuityStore().forget(principalId, target, all)
                    return removed > 0
                        ? `Erledigt. Ich habe ${removed} passende ${removed === 1 ? 'Erinnerung' : 'Erinnerungen'} entfernt.`
                        : 'Dazu hatte ich keine passende aktive Erinnerung gespeichert.'
                }
                if (memoryAction === 'recall' || memoryAction === 'recall-natural') {
                    const query = memoryArgs.join(' ').trim()
                    if (!query) return 'Verwendung: /memory recall <Frage oder Thema>'
                    const context: PrincipalContext = principalContext || {
                        channel: 'unknown',
                        rawUserId: from,
                        principalId,
                    }
                    const scopes = [...compatiblePrincipalScopes(context), 'global']
                    const { getSessionContinuityStore } = await import('../memory/session-summarizer.js')
                    const continuityStore = getSessionContinuityStore()
                    const legacyAlias = (state as any).config?.userAliases?.[from]
                    continuityStore.backfillFromSessionLogs(
                        principalId,
                        [principalId, from, legacyAlias].filter(Boolean),
                    )
                    const recalled = governance.recall(scopes, query, 12)
                    const continuity = continuityStore.getSessionPrompt(principalId, query)
                    if (recalled.length === 0 && !continuity) return 'Keine passende verifizierte Erinnerung gefunden.'
                    if (memoryAction === 'recall-natural') {
                        return [
                            'Ja. Das weiß ich dazu noch:',
                            ...recalled.map(item => `- ${item.content}`),
                            continuity,
                        ].filter(Boolean).join('\n')
                    }
                    return [
                        '🧠 Relevante Erinnerungen',
                        ...recalled.map(item =>
                            `- [${item.status}] ${item.content} · ${item.provenance.at(-1)?.source || 'unbekannt'}`),
                        continuity,
                    ].filter(Boolean).join('\n')
                }
                if (memoryAction === 'approve' || memoryAction === 'reject') {
                    if (!memoryId) return `Verwendung: /memory ${memoryAction} <memory-id>`
                    const visible = governance.list().find(item => item.id === memoryId
                        && (item.scope === ownScope || (item.scope === 'global' && canGovernGlobal)))
                    if (!visible) return 'Memory-Eintrag nicht gefunden oder nicht freigegeben.'
                    const changed = memoryAction === 'approve'
                        ? governance.approve(memoryId, `operator:${from}`)
                        : await governance.rejectAndRetract(memoryId, `operator:${from}`)
                    if (changed && memoryAction === 'approve') await governance.publish(changed.id)
                    return changed
                        ? `Memory ${changed.id}: ${changed.status}\n${changed.content}`
                        : 'Memory-Status konnte nicht geändert werden.'
                }

                if (memoryAction === 'review') {
                    const review = governance.list()
                        .filter(item => (item.scope === ownScope || (item.scope === 'global' && canGovernGlobal))
                            && (item.status === 'candidate' || item.conflictIds.length > 0))
                        .slice(0, 12)
                    if (review.length === 0) return 'Memory Governance: keine offenen Kandidaten oder Konflikte.'
                    return ['Memory Governance Review:', ...review.map(item =>
                        `- ${item.id} [${item.status}] ${item.content}${item.conflictIds.length ? ` | Konflikte: ${item.conflictIds.join(', ')}` : ''}`),
                    'Freigabe: /memory approve <id> | Ablehnen: /memory reject <id>'].join('\n')
                }

                const stats = governance.getStats()
                const { getSessionContinuityStore } = await import('../memory/session-summarizer.js')
                const continuity = getSessionContinuityStore().getStats()
                return `Memory Governance\nKanonisch: ${stats.canonical}\nVerifiziert: ${stats.verified}\nKandidaten: ${stats.candidate}\nErsetzt: ${stats.superseded}\nAbgelehnt: ${stats.rejected}\nAbgelaufen: ${stats.expired}\nGesamt: ${stats.total}\nKontinuitätsprofile: ${continuity.sessions}\nOffene Vorhaben: ${continuity.openGoals}\nVerifizierte Ergebnisse: ${continuity.verifiedOutcomes}`
            }
            if (!state.memory) {
                return '🧠 Memory: ❌ nicht aktiviert'
            }
            try {
                const stats = await state.memory.getStats(from)
                const localCount = stats.totalEntries || stats.count || 0
                const vectorCount = stats.vectorStats?.totalEntries || 0
                let lanceCount = 0
                try {
                    const lance = (state as any).lanceMemory
                    if (lance) {
                        const lStats = await lance.getStats()
                        lanceCount = lStats?.totalEntries || 0
                    }
                } catch { /* */ }
                const totalCount = localCount + vectorCount + lanceCount
                const memText = `🧠 *Memory Status*

📊 Gesamt: ${totalCount} Einträge
  ├ 💾 Lokal: ${localCount}
  ├ 🔍 Vektor: ${vectorCount}
  └ 🗄️ LanceDB: ${lanceCount}
👤 Benutzer: ${from}`

                // Try Telegram buttons
                try {
                    const { getTelegramAdapter } = await import('../channels/telegram.js')
                    const tg = getTelegramAdapter()
                    if (tg) {
                        await tg.sendWithButtons(from, memText, [
                            [{ text: '🔄 Refresh', callback_data: 'cmd_memory' }, { text: '🗑️ Clear Memory', callback_data: 'memory_clear' }],
                            [{ text: '🔍 Suchen', callback_data: 'memory_search' }, { text: '💾 Export', callback_data: 'memory_export' }],
                            [{ text: '📊 Status', callback_data: 'cmd_status' }, { text: '⬅️ Menü', callback_data: 'cmd_help' }],
                        ])
                        return '__HANDLED__'
                    }
                } catch { /* non-Telegram */ }

                return memText
            } catch {
                return '🧠 Memory: Statistiken nicht verfügbar'
            }
        }

        case 'info':
            return `✨ *Nova v${NOVA_VERSION}*
_Autonomer, selbstlernender KI-Assistent — 21-Layer-Architektur_
_356 TypeScript-Dateien • ~102k Zeilen • 32 Tools_

🛡️ *Supervisor (L0):*
Health Monitor • Self-Repair • Circuit Breaker • Tool Auto-Repair • Stop-Loss • Fix Generator

⚙️ *Foundation (L01-L05):*
L01 Unified Channels • L02 Command Factory • L03 Core Runtime (State Machine) • L04 Secure Auth • L05 LLM Adapters

💾 *Core (L6-L9):*
L6 Session Summary, Cold Storage, Core Facts • L7 Learning & Tool Learning • L8 Meta-Learning, Sub-Agent, Prisma Guards • L9 Idle Learning

🔬 *Advanced (L10-L18):*
L10 Vision • L11 Project Manager • L12 QA & Anti-Hallucination • L13 AST Analyzer • L14 Cost Tracker • L15 Self-Check & Security Scanner • L16 Business Sense • L17 Autonomous Learning • L18 LLM Router (Multi-Model)

📡 *System (L19-L21):*
L19 Monitoring • L20 Self-Improvement • L21 Node Health

🧠 *Intelligence (14 Module):*
Entity Extractor • Intent Router • Task Planner • Tool Chainer • Model Router • Emotion Tracker • Self-Reflection • Proactive Learning & Suggestions • Result Analyzer • User Patterns • Autonomy Engine • Thinking Engine

💿 *Memory (6 Systeme):*
LanceDB Vektor-Speicher • Local Memory • Knowledge Graph • Advanced RAG • Hybrid Search • Auto-Observer & Journal

🌐 *Mesh & Infra:*
Multi-Node Netzwerk (Supabase) • AI Service Scanner • Auto-Update • Backup • Quality Gate • Honesty Validator

📲 *Kanäle:* Telegram • WhatsApp • Discord • Matrix • Signal • Slack • VoIP

🔧 *32 Tools:* SSH • Browser • Code Search • Image Gen • PDF • Desktop • Media • Executor • Document Reader • Knowledge System • Reminder • u.v.m.

Gebaut für Xaventra contributors 🌶️`

        // ============================================
        // Multi-Bot Management Commands
        // ============================================
        case 'bots':
        case 'botlist': {
            const { getMultiBotManager } = await import('../layers/multi-bot.js')
            const manager = getMultiBotManager()
            const bots = manager.getAllBots()

            if (bots.length === 0) {
                return `🤖 *Multi-Bot Status*\n\nKeine Bots konfiguriert.\n\nVerwende /bot spawn <name> um einen Bot zu erstellen.`
            }

            const botList = bots.map(b => {
                const status = b.status === 'running' ? '🟢' : b.status === 'error' ? '🔴' : '⚪'
                const users = b.activeUsers.size
                return `${status} *${b.config.name}* (${b.config.channel})\n   Status: ${b.status} | Messages: ${b.messageCount} | Users: ${users}`
            }).join('\n\n')

            const stats = manager.getStats()
            return `🤖 *Multi-Bot Status*\n\n${botList}\n\n📊 Gesamt: ${stats.totalBots} Bots, ${stats.runningBots} aktiv, ${stats.totalMessages} Nachrichten`
        }

        case 'bot': {
            const [action, ...restArgs] = args.split(' ')
            const botArg = restArgs.join(' ')

            // ==============================
            // TEAM Commands (/bot team ...)
            // ==============================
            if (action?.toLowerCase() === 'team') {
                const { initTeamCoordinator, runTeam, createTeam, deleteTeam, listTeams, getActiveRuns, getTeam: getTeamById } = await import('../agents/team-coordinator.js')
                const { listRoles, listPresets, BUILT_IN_ROLES } = await import('../agents/agent-roles.js')
                initTeamCoordinator()

                const [teamAction, ...teamRest] = restArgs
                const teamArg = teamRest.join(' ')

                switch (teamAction?.toLowerCase()) {
                    case 'new':
                    case 'create': {
                        const parts = teamArg.split(' ')
                        const name = parts[0]
                        const rolesStr = parts[1]
                        const desc = parts.slice(2).join(' ') || 'Custom Team'
                        if (!name || !rolesStr) {
                            return `❌ Syntax: /bot team new <name> <rollen> <beschreibung>\n\nBeispiel: /bot team new SecurityTeam captain,coder,security Code-Security-Audit\n\n${listRoles()}`
                        }
                        const roles = rolesStr.split(',').map((r: string) => r.trim())
                        const invalid = roles.filter((r: string) => !BUILT_IN_ROLES[r])
                        if (invalid.length > 0) {
                            return `❌ Unbekannte Rollen: ${invalid.join(', ')}\n\n${listRoles()}`
                        }
                        const team = createTeam(name, roles, desc, from)
                        const emojis = roles.map((r: string) => BUILT_IN_ROLES[r]?.emoji || '?').join('')
                        return `✅ Team erstellt: **${name}** (${team.id})\n\n${emojis} Rollen: ${roles.join(', ')}\n${desc}`
                    }
                    case 'del':
                    case 'delete':
                    case 'remove': {
                        if (!teamArg) return '❌ Syntax: /bot team del <name|id>'
                        const deleted = deleteTeam(teamArg)
                        return deleted ? `🗑️ Team "${teamArg}" gelöscht.` : `❌ Team "${teamArg}" nicht gefunden.`
                    }
                    case 'list':
                    case 'ls': {
                        return listTeams()
                    }
                    case 'roles': {
                        return `🎭 **Verfügbare Rollen**\n\n${listRoles()}`
                    }
                    case 'presets': {
                        return `📦 **Team Presets**\n\n${listPresets()}`
                    }
                    case 'status': {
                        const runs = getActiveRuns()
                        if (runs.length === 0) return '✅ Keine Teams aktiv.'
                        return runs.map((r: any) => `🏃 **${r.teamId}** — ${r.status}\n  Query: ${r.query.slice(0, 60)}...\n  Agents: ${r.results.length} fertig`).join('\n\n')
                    }
                    case 'run':
                    default: {
                        let teamId = 'default'
                        let query = teamArg || teamAction || ''
                        if (teamAction !== 'run' && teamAction) {
                            query = teamAction + ' ' + teamArg
                        } else if (teamRest[0] && getTeamById(teamRest[0])) {
                            teamId = teamRest[0]
                            query = teamRest.slice(1).join(' ')
                        } else {
                            query = teamArg
                        }
                        if (!query.trim()) {
                            return `🤖 **Bot Team**\n\n/bot team <frage> — Default Team\n/bot team run <preset> <frage> — Bestimmtes Team\n/bot team new <name> <rollen> <desc> — Neues Team\n/bot team del <name> — Team löschen\n/bot team list — Alle Teams\n/bot team roles — Verfügbare Rollen\n/bot team presets — Team-Vorlagen`
                        }
                        const progressMsgs: string[] = []
                        let progressMsgId: number | null = null
                        const chatId = (globalThis as any).__novaState?.lastActiveChatId
                        const onProgress = async (status: string) => {
                            progressMsgs.push(status)
                            const fullStatus = progressMsgs.join('\n')
                            try {
                                const tg = (globalThis as any).__novaState?.channels?.telegram || (globalThis as any).__novaState?.telegram
                                if (tg?.bot && chatId) {
                                    if (progressMsgId) {
                                        await tg.bot.editMessageText(fullStatus, { chat_id: chatId, message_id: progressMsgId, parse_mode: 'Markdown' }).catch(() => { })
                                    } else {
                                        const sent = await tg.bot.sendMessage(chatId, fullStatus, { parse_mode: 'Markdown' })
                                        progressMsgId = sent?.message_id
                                    }
                                }
                            } catch { }
                        }
                        const result = await runTeam(teamId, query, onProgress)
                        try {
                            const tg = (globalThis as any).__novaState?.channels?.telegram || (globalThis as any).__novaState?.telegram
                            if (tg?.bot && chatId && progressMsgId) {
                                await tg.bot.deleteMessage(chatId, progressMsgId).catch(() => { })
                            }
                        } catch { }
                        return result
                    }
                }
            }

            // ==============================
            // Legacy Bot Instance Commands
            // ==============================
            const { getMultiBotManager, BOT_TEMPLATES } = await import('../layers/multi-bot.js')
            const manager = getMultiBotManager()

            switch (action?.toLowerCase()) {
                case 'spawn':
                case 'create':
                case 'new': {
                    const name = botArg || `Nova-${Date.now().toString(36)}`
                    const template = BOT_TEMPLATES.assistant
                    const config = manager.createBot({
                        name,
                        persona: template.persona,
                        channel: 'telegram',
                        channelConfig: {},
                        enabled: true,
                        createdBy: from,
                    })
                    return `✅ Bot erstellt: *${config.name}*\n\nID: ${config.id}\nChannel: ${config.channel}\n\nVerwende /bot start ${config.name} zum Starten.`
                }
                case 'start': {
                    const bot = manager.getBotByName(botArg) || manager.getBot(botArg)
                    if (!bot) return `❌ Bot "${botArg}" nicht gefunden.`
                    try {
                        await manager.startBot(bot.config.id)
                        return `✅ Bot *${bot.config.name}* gestartet!`
                    } catch (err) {
                        return `❌ Start fehlgeschlagen: ${err}`
                    }
                }
                case 'stop':
                case 'kill': {
                    const bot = manager.getBotByName(botArg) || manager.getBot(botArg)
                    if (!bot) return `❌ Bot "${botArg}" nicht gefunden.`
                    await manager.stopBot(bot.config.id)
                    return `✅ Bot *${bot.config.name}* gestoppt.`
                }
                case 'delete':
                case 'remove': {
                    const bot = manager.getBotByName(botArg) || manager.getBot(botArg)
                    if (!bot) return `❌ Bot "${botArg}" nicht gefunden.`
                    manager.deleteBot(bot.config.id)
                    return `🗑️ Bot *${bot.config.name}* gelöscht.`
                }
                case 'status':
                case 'info': {
                    const bot = manager.getBotByName(botArg) || manager.getBot(botArg)
                    if (!bot) return `❌ Bot "${botArg}" nicht gefunden.`
                    const uptime = bot.startedAt ? Math.floor((Date.now() - bot.startedAt) / 1000 / 60) : 0
                    return `🤖 *${bot.config.name}*\n\nID: ${bot.config.id}\nStatus: ${bot.status}\nChannel: ${bot.config.channel}\nUptime: ${uptime} min\nMessages: ${bot.messageCount}\nActive Users: ${bot.activeUsers.size}\nAllowed Users: ${bot.config.allowedUsers?.length || 'alle'}`
                }
                case 'templates': {
                    return `📋 *Bot Templates*\n\n🔹 assistant - Allgemeiner Assistent\n🔹 coder - Programmier-Experte\n🔹 researcher - Recherche-Spezialist\n🔹 translator - Übersetzungs-Experte`
                }
                default:
                    return `🤖 *Bot & Team*\n\n**Team (Multi-Agent):**\n/bot team <frage> — Agent-Team ausführen\n/bot team new — Neues Team erstellen\n/bot team del — Team löschen\n/bot team list — Alle Teams\n/bot team roles — Rollen\n\n**Bot-Instanzen:**\n/bot spawn <name>\n/bot start/stop/delete <name>\n\n**Sub-Agent:**\n/subagent <rolle> <frage>`
            }
        }

        case 'swarm': {
            const { getAgentSwarm } = await import('../layers/L7-learning.js')
            const swarm = getAgentSwarm()
            const stats = swarm.getStats()
            const agents = swarm.getAgents()

            if (agents.length === 0) {
                return `🐝 *Agent Swarm*\n\nKeine Agents aktiv.`
            }

            const agentList = agents.map(a => {
                const status = a.status === 'idle' ? '💤' : a.status === 'thinking' ? '🧠' : a.status === 'executing' ? '⚡' : '⏳'
                return `${status} ${a.name} (${a.role})`
            }).join('\n')

            return `🐝 *Agent Swarm*\n\n${agentList}\n\n📊 ${stats.totalAgents} Agents, ${stats.idleAgents} idle, ${stats.busyAgents} busy`
        }

        // ============================================
        // User Management Commands
        // ============================================
        case 'users':
        case 'user': {
            const [action, ...restParts] = args.split(' ')
            const { handleUserCommand } = await import('../users/multi-user-middleware.js')
            return handleUserCommand(action || 'list', restParts.join(' '), from, principalContext?.channel || 'unknown')
        }

        // ============================================
        // Wave Pipeline (nWave-inspired structured missions)
        // ============================================
        case 'wave': {
            const { createMission, getMissionStatus, approvePhase, revisePhase, listMissions, submitForReview } = await import('../intelligence/wave-pipeline.js')
            const [subCmd, ...rest] = args.split(' ')
            switch (subCmd?.toLowerCase()) {
                case 'new':
                case 'start':
                    return createMission(rest.join(' ') || 'Unnamed Mission', rest.join(' '), from).title + ' erstellt!'
                case 'approve':
                case 'ok':
                    return approvePhase(rest[0] || '')
                case 'revise':
                    return revisePhase(rest[0] || '', rest.slice(1).join(' '))
                case 'submit':
                case 'review':
                    return submitForReview(rest[0] || '')
                case 'list':
                    return listMissions()
                default:
                    return getMissionStatus(subCmd)
            }
        }

        // ============================================
        // ROI Dashboard (ClawWork-inspired)
        // ============================================
        case 'roi':
        case 'cost':
        case 'kosten': {
            const { getROIDashboard } = await import('../intelligence/roi-dashboard.js')
            return getROIDashboard()
        }

        // ============================================
        // Knowledge Graph (arscontexta-inspired)
        // ============================================
        case 'graph':
        case 'knowledge': {
            const { getGraphStats } = await import('../intelligence/knowledge-graph.js')
            return getGraphStats()
        }

        // ============================================
        // File Index (OmniSearch-inspired)
        // ============================================
        case 'scan': {
            const { scanDirectory, getIndexStats } = await import('../intelligence/file-index.js')
            if (args.trim()) {
                const count = scanDirectory(args.trim())
                return `📁 ${count} Dateien indexiert aus ${args.trim()}`
            }
            return getIndexStats()
        }

        // ============================================
        // Sub-Agent Command
        // ============================================
        case 'subagent':
        case 'sub': {
            const [roleId, ...queryParts] = args.split(' ')
            const query = queryParts.join(' ')
            if (!roleId || !query) {
                const { listRoles } = await import('../agents/agent-roles.js')
                return `🤖 **Sub-Agent**\n\nSyntax: /subagent <rolle> <frage>\n\nBeispiel: /subagent coder Analysiere die message-pipeline.ts Architektur\n\n${listRoles()}`
            }
            const { runSubAgent } = await import('../agents/team-coordinator.js')
            return await runSubAgent(roleId, query)
        }

        // ============================================
        // Sub-Agent Management Commands
        // ============================================
        case 'agents': {
            const lines: string[] = ['🤖 *Sub-Agent Status*\n']

            // Orchestrator stats
            const orchestrator = (state as any).orchestrator
            if (orchestrator) {
                const oStats = orchestrator.getStats()
                const activeAgents = orchestrator.getActiveAgents()
                const watchedTasks = orchestrator.getWatchedTasks()
                lines.push(`*Orchestrator:*`)
                lines.push(`├ Active Agents: ${oStats.activeAgents}/${oStats.totalAgents}`)
                lines.push(`├ Completed: ${oStats.completedAgents}`)
                lines.push(`├ Failed: ${oStats.failedAgents}`)
                lines.push(`├ Watched Tasks: ${oStats.watchedTasks}`)
                lines.push(`└ Timed Out: ${oStats.timedOutTasks}`)
                if (activeAgents.length > 0) {
                    lines.push(`\n*Aktive Agents:*`)
                    for (const a of activeAgents) {
                        const icon = a.status === 'working' ? '⚡' : a.status === 'idle' ? '💤' : '✅'
                        lines.push(`${icon} ${a.role}: ${a.task.slice(0, 60)}`)
                    }
                }
                if (watchedTasks.length > 0) {
                    lines.push(`\n*Überwachte Tasks:*`)
                    for (const t of watchedTasks) {
                        const elapsed = Math.round((Date.now() - t.startedAt) / 1000)
                        const icon = t.timedOut ? '⏰' : '👁️'
                        lines.push(`${icon} ${t.description.slice(0, 50)} (${elapsed}s)`)
                    }
                }
            } else {
                lines.push(`*Orchestrator:* ❌ Nicht aktiv`)
            }

            // L8 Sub-Agent stats
            try {
                const { getSubAgentManager } = await import('../layers/L8-sub-agent.js')
                const mgr = getSubAgentManager()
                const tasks = mgr.getActiveTasks()
                lines.push(`\n*L8 Sub-Agent:*`)
                lines.push(`├ Active Tasks: ${tasks.length}`)
                if (tasks.length > 0) {
                    for (const t of tasks) {
                        const icon = t.status === 'searching' ? '🔍' : t.status === 'trying' ? '🔧' : t.status === 'success' ? '✅' : '❌'
                        lines.push(`${icon} ${t.query.slice(0, 50)} (${t.status})`)
                    }
                }
            } catch {
                lines.push(`\n*L8 Sub-Agent:* ❌ Nicht verfügbar`)
            }

            // Factory stats
            const factory = (state as any).factory
            if (factory) {
                const fStats = factory.getStats()
                lines.push(`\n*Factory:*`)
                lines.push(`├ Tasks: ${fStats.tasks}`)
                lines.push(`├ Active Agents: ${fStats.activeAgents}`)
                lines.push(`├ Completed: ${fStats.completedTasks}`)
                lines.push(`└ Failed: ${fStats.failedTasks}`)
            } else {
                lines.push(`\n*Factory:* ❌ Nicht aktiv`)
            }

            return lines.join('\n')
        }

        case 'factory': {
            const factory = (state as any).factory
            if (!factory) {
                return `❌ Factory nicht verfügbar. Neustart nötig.`
            }

            if (!args.trim()) {
                const fStats = factory.getStats()
                const tasks = factory.getAllTasks()
                let text = `🏭 *Factory — Task Decomposer*\n\n`
                text += `📊 ${fStats.tasks} Tasks, ${fStats.activeAgents} Agents aktiv\n\n`
                text += `*Nutzung:*\n`
                text += `/factory <aufgabe> — Komplexe Aufgabe einreichen\n`
                text += `/factory status — Alle Tasks anzeigen\n\n`
                if (tasks.length > 0) {
                    text += `*Letzte Tasks:*\n`
                    for (const t of tasks.slice(-5)) {
                        const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'executing' ? '⚡' : '⏳'
                        text += `${icon} ${t.description.slice(0, 60)} (${t.status})\n`
                    }
                }
                return text
            }

            if (args.trim() === 'status') {
                const tasks = factory.getAllTasks()
                if (tasks.length === 0) return `🏭 Keine aktiven Factory Tasks.`
                const lines = tasks.map((t: any) => {
                    const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⚡'
                    const subs = t.subtasks?.length || 0
                    return `${icon} ${t.description.slice(0, 60)} — ${subs} Subtasks (${t.status})`
                })
                return `🏭 *Factory Tasks*\n\n${lines.join('\n')}`
            }

            // Submit new task
            try {
                const task = await factory.submitTask(args.trim())
                return `🏭 *Task eingereicht!*\n\n📋 ID: ${task.id}\n📝 ${task.description}\n⏱️ Timeout: ${task.timeout / 1000}s\n\n_Factory zerlegt die Aufgabe in Subtasks und spawnt Agents..._`
            } catch (err) {
                return `❌ Factory Error: ${err}`
            }
        }

        // ============================================
        // API Key Management
        // ============================================
        case 'apikey': {
            const [provider, ...keyParts] = args.split(' ')
            const apiKey = keyParts.join(' ').trim()

            if (!provider) {
                return `🔑 *API Keys & Search-Konfiguration*

*Websuche (API-Key benötigt):*
/apikey brave <KEY> — Brave Search (2000 Anfragen/Monat kostenlos)
/apikey tavily <KEY> — Tavily AI Search (1000/Monat kostenlos)

*Websuche (kein Key — self-hosted):*
/apikey searxng <URL> — SearXNG Instanz-URL (z.B. http://192.168.1.100:8080)

**Keys kostenlos bekommen:**
• Brave: https://brave.com/search/api/
• Tavily: https://tavily.com/
• SearXNG selbst hosten: \`docker run -d -p 8080:8080 searxng/searxng\`

**Status prüfen:**
\`/search status\` — Welche Suchprovider aktiv?`
            }

            if (!apiKey) {
                if (provider.toLowerCase() === 'searxng') {
                    return `❌ URL fehlt!\n\nBeispiel: /apikey searxng http://192.168.1.100:8080`
                }
                return `❌ Kein Key angegeben!\n\nBeispiel: /apikey ${provider} sk-xxxx...`
            }

            try {
                const { getNovaConfig, setNovaConfig } = await import('./config.js')
                const config = getNovaConfig()

                // Initialize apis if not exists
                if (!config.apis) {
                    (config as any).apis = {}
                }

                switch (provider.toLowerCase()) {
                    case 'brave':
                        config.apis.brave_search_key = apiKey
                        setNovaConfig(config)
                        return `✅ *Brave Search API Key gespeichert!*\n\nTeste mit: "Suche nach TypeScript Tutorial"`

                    case 'tavily':
                        config.apis.tavily_key = apiKey
                        setNovaConfig(config)
                        return `✅ *Tavily API Key gespeichert!*\n\nTeste mit: "Suche nach AI News"`

                    case 'searxng': {
                        // Validate URL format
                        const url = apiKey.trim()
                        if (!url.startsWith('http://') && !url.startsWith('https://')) {
                            return `❌ Ungültige URL. Muss mit http:// oder https:// beginnen.\n\nBeispiel: /apikey searxng http://192.168.1.100:8080`
                        }
                        // Quick connectivity test
                        let testResult = ''
                        try {
                            const testRes = await fetch(`${url.replace(/\/$/, '')}/search?q=test&format=json`, {
                                signal: AbortSignal.timeout(5000),
                                headers: { 'Accept': 'application/json' },
                            })
                            if (testRes.ok) {
                                testResult = `\n✅ Verbindungstest erfolgreich!`
                            } else if (testRes.status === 403) {
                                testResult = `\n⚠️ Erreichbar, aber JSON-Format blockiert (HTTP 403).\nFix in SearXNG settings.yml:\n\`\`\`yaml\nsearch:\n  formats: [html, json]\n\`\`\``
                            } else {
                                testResult = `\n⚠️ Erreichbar (HTTP ${testRes.status})`
                            }
                        } catch {
                            testResult = `\n⚠️ Nicht erreichbar. URL korrekt? Firewall offen?`
                        }
                        ;(config as any).apis.searxng_url = url
                        setNovaConfig(config)
                        return `✅ *SearXNG URL gespeichert: ${url}*${testResult}\n\nTeste mit: "Suche nach Linux Tips"`
                    }

                    default:
                        return `❌ Unbekannter Provider: ${provider}\n\nVerfügbar: brave, tavily, searxng`
                }
            } catch (err) {
                return `❌ Fehler beim Speichern: ${err}`
            }
        }

        case 'learned':
        case 'gelernt': {
            const parts: string[] = ['📊 *Was Nova gelernt hat*\n']

            // L7 - Corrections
            try {
                const { getCorrectionLearner } = await import('../layers/L7-learning.js')
                const learner = getCorrectionLearner()
                const stats = learner.getStats()
                parts.push(`*L7 Korrekturen:*`)
                parts.push(`• ${stats.totalCorrections} Korrekturen gelernt`)
                parts.push(`• ${stats.appliedCorrections} erfolgreich angewendet\n`)
            } catch {
                parts.push(`*L7 Korrekturen:* Nicht verfügbar\n`)
            }

            // L9 - Idle Learning
            try {
                const { getIdleLearningManager } = await import('../layers/L9-idle-learning.js')
                const idle = getIdleLearningManager()
                const stats = idle.getStats()
                parts.push(`*L9 Idle Learning:*`)
                parts.push(`• ${stats.knowledgeCount} Themen gelernt`)
                parts.push(`• ${stats.patterns.length} Tool-Patterns erkannt`)
                if (stats.patterns.length > 0) {
                    const top3 = stats.patterns.slice(0, 3)
                    parts.push(`• Top Tools: ${top3.map(p => `${p.tool}(${p.count}x)`).join(', ')}`)
                }
                parts.push(`• Status: ${stats.isLearning ? 'Lernt gerade...' : 'Wartet'}\n`)
            } catch {
                parts.push(`*L9 Idle Learning:* Nicht verfügbar\n`)
            }

            // Memory stats
            try {
                if (state.memory) {
                    const memStats = state.memory.getStats()
                    parts.push(`*L6 Memory:*`)
                    parts.push(`• ${memStats.totalEntries || 0} Erinnerungen`)
                    parts.push(`• ${memStats.uniqueUsers || 0} User bekannt\n`)
                }
            } catch {
                parts.push(`*L6 Memory:* Nicht verfügbar\n`)
            }

            // User-specific (from)
            parts.push(`*Über dich (${from}):*`)
            parts.push(`• Session aktiv seit Start`)
            parts.push(`• Uptime: ${Math.floor((Date.now() - state.startTime) / 60000)} min`)

            return parts.join('\n')
        }

        case 'lernstatus': {
            try {
                const { getToolUsageLearner } = await import('../layers/L7-tool-learning.js')
                const learner = getToolUsageLearner()
                const stats = learner.getStats()
                const rate = stats.totalExamples > 0 ? Math.round((stats.correctExamples / stats.totalExamples) * 100) : 0
                const tools = Object.entries(stats.toolBreakdown).map(([t, s]) => `  ${t}: ${s.correct}✅ ${s.incorrect}❌`).join('\n')
                return `📊 *Tool-Learning Status*\n\n• Beispiele: ${stats.totalExamples}\n• Korrekt: ${stats.correctExamples} (${rate}%)\n• Korrekturen: ${stats.correctedExamples}\n• Patterns: ${stats.patterns}\n${tools ? '\n*Tools:*\n' + tools : ''}`
            } catch {
                return '❌ Tool-Learning nicht verfügbar'
            }
        }

        case 'korrektur': {
            if (!args) return '❓ Bitte erkläre was falsch war.\n\nBeispiel: /korrektur Das Ergebnis sollte in JSON sein, nicht als Text'

            try {
                const learner = (state as any).correctionLearner
                if (learner) {
                    learner.recordCorrection({
                        userId: from,
                        originalResponse: 'Letzte Aktion (via /korrektur)',
                        correctedResponse: args,
                        context: 'Manual correction via /korrektur command',
                    })
                    return `✅ *Korrektur gespeichert!*\n\nIch habe mir gemerkt: "${args.slice(0, 100)}"\n\nDiese Korrektur wird bei ähnlichen Anfragen berücksichtigt.`
                }
                return '❌ CorrectionLearner nicht aktiv'
            } catch {
                return '❌ Fehler beim Speichern der Korrektur'
            }
        }

        case 'doctor': {
            try {
                const {
                    collectDiagnostics,
                    formatReportCompact,
                    formatReportFull,
                    formatReportJson,
                    queueDoctorFixProposals,
                } = await import('../doctor/index.js')

                const subCmd = args.trim().toLowerCase()

                // /doctor fix — apply all safe fixes
                if (subCmd === 'fix' || subCmd === '--fix') {
                    const permission = requestPermission
                    if (permission !== 'owner' && permission !== 'admin') return 'Doctor-Fixes benÃ¶tigen owner/admin.'
                    const report = await collectDiagnostics()
                    const safeFixes = report.issues.filter(i => i.fix?.safe)
                    if (safeFixes.length === 0) {
                        return '✅ *Keine sicheren Fixes verfügbar* — alles in Ordnung oder manuelle Eingriffe notwendig.'
                    }
                    const queued = await queueDoctorFixProposals(report)
                    return queued.queued.length
                        ? `${queued.queued.length} Doctor-Fix(es) sandbox-validiert und am PATCH_GATE.\n${queued.queued.map(id => `/patch approve ${id}`).join('\n')}${queued.skipped.length ? `\nÃœbersprungen: ${queued.skipped.join('; ')}` : ''}`
                        : `Keine anwendbaren Doctor-Config-Fixes. ${queued.skipped.join('; ')}`
                }

                // /doctor --json — machine-readable output
                if (subCmd === '--json' || subCmd === 'json') {
                    const report = await collectDiagnostics()
                    return '```json\n' + formatReportJson(report) + '\n```'
                }

                // /doctor --deep — full CLI-style output
                if (subCmd === '--deep' || subCmd === 'deep') {
                    const report = await collectDiagnostics()
                    return '```\n' + formatReportFull(report) + '\n```'
                }

                // /doctor — compact Telegram output (default)
                const report = await collectDiagnostics()
                const text = formatReportCompact(report)

                // Send with inline buttons for safe fixes
                const safeFixes = report.issues.filter(i => i.fix?.safe)
                try {
                    const { getTelegramAdapter } = await import('../channels/telegram.js')
                    const tg = getTelegramAdapter()
                    if (tg && from) {
                        const buttons: Array<Array<{ text: string; callback_data: string }>> = []

                        if (safeFixes.length > 0) {
                            buttons.push([
                                { text: `💊 ${safeFixes.length} Fix${safeFixes.length > 1 ? 'es' : ''} anwenden`, callback_data: 'doctor_fix' },
                                { text: '🔍 Details', callback_data: 'doctor_deep' },
                            ])
                        } else {
                            buttons.push([
                                { text: '🔍 Details', callback_data: 'doctor_deep' },
                                { text: '📋 JSON', callback_data: 'doctor_json' },
                            ])
                        }

                        await tg.sendWithButtons(from, text, buttons)
                        return '__HANDLED__'
                    }
                } catch { /* no Telegram — fall through to plain text */ }

                return text
            } catch (err) {
                // Fallback to old self-doctor if new doctor fails to load
                try {
                    const { runSelfDoctor } = await import('./self-doctor.js')
                    const result = await runSelfDoctor()
                    return result.summary
                } catch {
                    return `❌ Doctor nicht verfügbar: ${String(err)}`
                }
            }
        }

        case 'save': {
            const saved: string[] = []
            try {
                // Save Memory
                if (state.memory && state.memory.save) {
                    await state.memory.save()
                    saved.push('🧠 Memory')
                }
                // Save Learning
                if (state.learning && state.learning.save) {
                    state.learning.save()
                    saved.push('🎓 Learning')
                }
                // Save Cost Tracker
                const costTracker = (state as any).costTracker
                if (costTracker && costTracker.saveHistory) {
                    costTracker.saveHistory()
                    saved.push('💰 Cost Tracker')
                }
                // Save Self-Improvement Rules
                const selfImprove = (state as any).selfImprovement
                if (selfImprove) {
                    saved.push('🧬 Self-Improvement Rules')
                }
                // Save Monitoring Config
                const monitor = (state as any).serviceMonitor
                if (monitor) {
                    saved.push('📡 Monitor Config')
                }

                if (saved.length === 0) return '⚠️ Nichts zu speichern (keine aktiven Systeme)'
                return `✅ *Gespeichert!*\n\n${saved.join('\n')}\n\nAlle Daten sind persistiert.`
            } catch (err) {
                return `❌ Fehler beim Speichern: ${err}`
            }
        }

        case 'commands': {
            const cmds = [
                '/help', '/status', '/layers', '/layer0', '/model', '/llm',
                '/think', '/strict', '/persona', '/supervisor', '/info',
                '/memory', '/skills', '/learned', '/learn', '/lernstatus', '/korrektur',
                '/hosts',
                '/clear', '/apikey', '/save', '/compact',
                '/bots', '/bot', '/swarm', '/subagent', '/sub',
                '/users', '/user', '/agents', '/factory', '/doctor',
                '/wave', '/roi', '/cost', '/graph', '/scan',
                '/project', '/monitor', '/login', '/callback', '/commands',
                '/reasoning', '/verbose', '/autonomy', '/quiet',
                '/autonom', '/mission', '/remind', '/task', '/preflight',
            ]
            return `📝 *Alle ${cmds.length} Befehle:*\n\n${cmds.join(' • ')}\n\nDetails: /help`
        }

        case 'compact': {
            try {
                const { flushAllSessions, loadSummary } = await import('../layers/L6-session-summary.js')
                await flushAllSessions()
                const summary = loadSummary(from)
                if (summary) {
                    return `✅ *Session komprimiert!*\n\n📊 ${summary.messagesCompressed} Nachrichten zusammengefasst\n⏰ ${summary.lastUpdated}\n\n📝 *Zusammenfassung:*\n${summary.summary.slice(0, 500)}${summary.summary.length > 500 ? '...' : ''}`
                }
                return '✅ Session komprimiert! (Keine ältere Historie zum Zusammenfassen)'
            } catch (err) {
                return `❌ Session-Komprimierung fehlgeschlagen: ${err}`
            }
        }

        case 'project': {
            try {
                const { getProjectManager } = await import('../layers/L11-project-manager.js')
                const pm = getProjectManager()

                const [subCmd, ...rest] = args.split(' ')
                const arg = rest.join(' ')

                switch (subCmd) {
                    case 'new':
                        if (!arg) return '❌ Bitte Projektname angeben: /project new <name>'
                        const proj = pm.createProject(arg, `Projekt: ${arg}`)
                        return `✅ Projekt "${arg}" erstellt!\n\nNutze:\n• /project feature <name> - Feature hinzufügen\n• /project status - Status anzeigen`

                    case 'feature':
                        if (!arg) return '❌ Bitte Feature-Name angeben: /project feature <name>'
                        const feat = pm.addFeature(arg)
                        if (!feat) return '❌ Kein aktives Projekt. Erstelle eins mit /project new'
                        return `✅ Feature "${arg}" hinzugefügt!\n\nNutze /project task <title> um Tasks hinzuzufügen.`

                    case 'task':
                        if (!arg) return '❌ Bitte Task-Titel angeben: /project task <title>'
                        const task = pm.addTask(arg)
                        if (!task) return '❌ Kein aktives Feature. Erstelle eins mit /project feature'
                        return `✅ Task "${arg}" hinzugefügt!`

                    case 'done':
                        const completed = pm.completeCurrentTask()
                        if (!completed) return '❌ Kein aktiver Task zum Abschließen.'
                        return `✅ Task "${completed.title}" erledigt!\n\n${pm.formatStatus()}`

                    case 'status':
                    default:
                        return pm.formatStatus()
                }
            } catch (err) {
                return `❌ Project Manager nicht verfügbar: ${err}`
            }
        }

        case 'codex': {
            const [actionRaw, modeRaw] = args.trim().toLowerCase().split(/\s+/)
            const action = actionRaw || 'status'
            const principalId = principalContext?.principalId || resolvePrincipalId((state as any).config, principalContext?.channel || 'unknown', from)
            const mayManageAuth = requestPermission === 'owner' || requestPermission === 'admin'
            try {
                const runtime = await import('../auth/codex-runtime.js')
                if (action === 'status') {
                    const route = await runtime.probeCodexContinuity(principalId, (state as any).config?.codex || {})
                    const fallback = route.fallback
                        ? `vLLM \`${route.fallback.model}\` auf \`${route.fallback.hostname || route.fallback.nodeId}\``
                        : 'kein verifizierter Ersatz'
                    if (route.available) {
                        return `Codex für deinen Nova-User:\n✅ verfügbar und angemeldet\n🖥️ Aktiver Node: \`${route.activeNodeId}\`\n🛟 Fallback: ${fallback}\n\nCodex wird bevorzugt; bei einem Ausfall wechselt Nova automatisch und meldet den Statuswechsel.`
                    }
                    return `Codex für deinen Nova-User:\n❌ auf keinem erreichbaren Node verfügbar\n🛟 Aktiver Ersatz: ${fallback}\n\n${route.localStatus.available ? 'Anmeldung auf diesem Main: /codex login' : 'Codex ist auf diesem Main nicht installiert. Starte den bisherigen Codex-Node oder installiere Codex hier; Nova arbeitet bis dahin automatisch über den Ersatz weiter.'}`
                }
                if (action === 'login') {
                    if (!mayManageAuth) return '🔒 Nur Owner/Admin dürfen Codex-Login starten.'
                    const localStatus = await runtime.getCodexRuntimeStatus(principalId)
                    if (!localStatus.available) {
                        const fallback = runtime.resolveVllmFallback((state as any).config?.codex || {})
                        return `❌ Codex ist auf diesem Main (\`${localStatus.nodeId}\`) nicht installiert.\n\n${fallback ? `Nova nutzt weiter vLLM \`${fallback.model}\` auf \`${fallback.hostname || fallback.nodeId}\`.` : 'Kein verifizierter LLM-Ersatz ist verfügbar.'}\nDu kannst Nova sagen: „Installiere Codex auf dem aktuellen Main“. Nach der verifizierten Installation: /codex login.`
                    }
                    const mode = modeRaw === 'browser' ? 'browser' : 'device'
                    const login = await runtime.beginCodexRuntimeLogin(principalId, mode)
                    if (!login.verificationUrl) return '❌ Codex hat keine Login-URL geliefert.'
                    return mode === 'device'
                        ? `🔐 Codex Device-Login für diesen User auf diesem Node\n\n1. Öffne: ${login.verificationUrl}\n2. Code: \`${login.userCode || 'siehe Login-Seite'}\`\n3. Danach: /codex status\n\nDer Code und die Tokens werden nicht in Memory, Supabase oder Mesh gespeichert.`
                        : `🔐 Öffne diesen Codex-Login im Browser:\n${login.verificationUrl}\n\nDanach: /codex status`
                }
                if (action === 'logout') {
                    if (!mayManageAuth) return '🔒 Nur Owner/Admin dürfen Codex-Logout ausführen.'
                    await runtime.endCodexRuntimeLogin(principalId)
                    return '✅ Codex wurde für deinen Nova-User auf diesem Node abgemeldet. Nova nutzt nun das lokale vLLM.'
                }
                return 'Syntax: /codex status | /codex login [device|browser] | /codex logout'
            } catch (error) {
                return `❌ Codex-Aktion fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`
            }
        }

        case 'login': {
            const provider = args.trim().toLowerCase()
            if (!provider || provider === 'openai' || provider === 'codex') {
                return handleCommand('codex', 'login device', from, state, availableLLMs, principalContext)
            }
            return `❌ Unbekannter Login-Provider: ${provider}. Für ChatGPT/Codex nutze /codex login.`

            // /login openai — OpenAI OAuth PKCE flow
            if (provider === 'openai') {
                try {
                    const { hasOpenAIAuth, loadOpenAITokens, getManualLoginUrl, loginOpenAI, saveOpenAITokens, getOpenAIAccessToken, syncOpenAITokensToRuntimeAuth } = await import('../auth/openai-oauth.js')

                    if (hasOpenAIAuth()) {
                        const tokens = loadOpenAITokens()
                        const access = await getOpenAIAccessToken()
                        syncOpenAITokensToRuntimeAuth(loadOpenAITokens())
                        const apiPath = tokens?.apiKey ? 'API-Key vorhanden' : 'kein API-Key, ChatGPT/OAuth-Pfad'
                        return `OpenAI OAuth ist gespeichert.

Account: ${tokens?.accountId || 'N/A'}
Gueltig bis: ${tokens?.expires ? new Date(tokens.expires).toLocaleString('de') : '?'}
Runtime-Sync: ${access ? 'ok' : 'erneuter Login noetig'}
Antwortpfad: ${apiPath}

Wenn Antworten trotzdem 401/429 melden: /login openai neu starten.`
                        return `✅ Bereits mit OpenAI verbunden!\n\nAccount: ${tokens?.accountId || 'N/A'}\nGültig bis: ${tokens?.expires ? new Date(tokens.expires).toLocaleString('de') : '?'}\n\nNeu einloggen? Lösche \`.nova-data/openai-auth.json\` und versuche es erneut.`
                    }

                    // Generate auth URL with PKCE (works everywhere)
                    const { url, state, codeVerifier } = getManualLoginUrl()

                        // Store codeVerifier for /callback
                        ; (globalThis as any).__novaLoginPending = { codeVerifier, state }

                    // Also start localhost callback server as bonus (works when Nova runs locally)
                    loginOpenAI({
                        onUrl: () => { /* URL already sent below */ },
                        onSuccess: (tokens) => {
                            saveOpenAITokens(tokens)
                            console.log(`[OpenAI OAuth] ✅ Login erfolgreich via Callback-Server! Account: ${tokens.accountId || 'N/A'}`)
                            delete (globalThis as any).__novaLoginPending
                            try {
                                const { unlinkSync } = require('node:fs')
                                const { join } = require('node:path')
                                unlinkSync(join(process.cwd(), '.nova-data', 'resolver-cache.json'))
                            } catch { /* ok */ }
                        },
                        onError: (error) => {
                            console.log(`[OpenAI OAuth] ❌ Callback-Server: ${error}`)
                        },
                        onStatus: (msg) => {
                            console.log(`[OpenAI OAuth] ${msg}`)
                        },
                    }).catch(() => { /* Callback server optional */ })

                    return `🔐 **OpenAI OAuth Login**

1. Öffne diesen Link im Browser:
\`\`\`
${url}
\`\`\`

2. Melde dich mit deinem OpenAI-Konto an

3. Nach dem Login wirst du zu einer URL weitergeleitet die **nicht lädt** — das ist normal!
   Kopiere die **komplette URL** aus der Adressleiste:
   \`http://127.0.0.1:18790/auth/callback?code=...&state=...\`

4. Sende die URL hier:
   \`/callback <die kopierte URL>\`

⏳ Nach dem Login nutzt Nova automatisch OpenAI.`
                } catch (err) {
                    return `❌ OpenAI Login fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`
                }
            }

            // /login (no provider) — show available options + start OpenAI OAuth manual flow
            try {
                const { getManualLoginUrl, hasOpenAIAuth, loadOpenAITokens, getOpenAIAccessToken, syncOpenAITokensToRuntimeAuth } = await import('../auth/openai-oauth.js')

                if (hasOpenAIAuth()) {
                    const tokens = loadOpenAITokens()
                    const access = await getOpenAIAccessToken()
                    syncOpenAITokensToRuntimeAuth(loadOpenAITokens())
                    const apiPath = tokens?.apiKey ? 'API-Key vorhanden' : 'kein API-Key, ChatGPT/OAuth-Pfad'
                    return `OpenAI OAuth ist gespeichert.

Account: ${tokens?.accountId || 'N/A'}
Gueltig bis: ${tokens?.expires ? new Date(tokens.expires).toLocaleString('de') : '?'}
Runtime-Sync: ${access ? 'ok' : 'erneuter Login noetig'}
Antwortpfad: ${apiPath}

Wenn Antworten trotzdem 401/429 melden: /login openai neu starten.`
                    return `✅ Bereits mit OpenAI verbunden!\n\nAccount: ${tokens?.accountId || 'N/A'}\nGültig bis: ${tokens?.expires ? new Date(tokens.expires).toLocaleString('de') : '?'}\n\nNeu einloggen? /login openai`
                }

                // Generate manual login URL (works in Telegram where localhost callback doesn't)
                const { url, state, codeVerifier } = getManualLoginUrl()

                    // Store pending state for /callback
                    ; (globalThis as any).__novaLoginPending = { codeVerifier, state }

                return `🔐 **Login**\n\nVerfügbare Provider:\n• \`/login openai\` — OpenAI OAuth (GPT, DALL-E, TTS)\n\n---\n\n**OpenAI Login:**\n1. Öffne diesen Link:\n\`\`\`\n${url}\n\`\`\`\n\n2. Melde dich an\n3. Kopiere die Redirect-URL und sende:\n/callback <URL>`
            } catch (err) {
                return `❌ Login nicht verfügbar: ${err instanceof Error ? err.message : String(err)}`
            }
        }

        case 'callback': {
            return '❌ Der alte OAuth-Callback ist deaktiviert. Nutze /codex login; Codex verwaltet OAuth und Refresh-Tokens node-lokal.'
            try {
                const pending = (globalThis as any).__novaLoginPending
                if (!pending) {
                    return '❌ Kein Login aktiv. Starte mit /login'
                }

                if (!args?.trim()) {
                    return '❌ Bitte die Redirect-URL mitsenden:\n`/callback https://127.0.0.1:18790/auth/callback?code=...`'
                }

                // Extract only the URL part — strip any trailing text (e.g. "❌ Ungültige Antwort" copy-pasted from browser)
                const rawUrl = args.trim().split(/\s+/)[0]

                // Validate state from URL matches our pending session
                let callbackState: string | null = null
                try {
                    callbackState = new URL(rawUrl).searchParams.get('state')
                } catch {
                    return '❌ Ungültige URL. Bitte die komplette Redirect-URL einfügen:\n`/callback http://localhost:1455/auth/callback?code=...&state=...`'
                }

                if (callbackState && callbackState !== pending.state) {
                    return '❌ State-Mismatch — diese URL gehört zu einer anderen Login-Session.\n\nBitte nochmal `/login openai` senden und dann direkt die neue URL nutzen.'
                }

                const { completeManualLogin, saveOpenAITokens, syncOpenAITokensToRuntimeAuth } = await import('../auth/openai-oauth.js')

                try {
                    const tokens = await completeManualLogin(rawUrl, pending.codeVerifier)
                    saveOpenAITokens(tokens)
                    syncOpenAITokensToRuntimeAuth(tokens)

                    // Clean up pending state
                    delete (globalThis as any).__novaLoginPending

                    // Bridge: Also write to auth.json so TokenManager picks up the token
                    try {
                        const { join } = require('node:path')
                        const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs')
                        const authDir = join(process.cwd(), '.nova-data')
                        const authPath = join(authDir, 'auth.json')
                        if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true })
                        let authData: any = {}
                        if (existsSync(authPath)) {
                            try { authData = JSON.parse(readFileSync(authPath, 'utf-8')) } catch { /* ok */ }
                        }
                        authData.openai = {
                            access: tokens.access,
                            refresh: tokens.refresh,
                            expires: tokens.expires,
                        }
                        writeFileSync(authPath, JSON.stringify(authData, null, 2))
                        console.log('[Callback] ✅ OAuth tokens bridged to auth.json for TokenManager')
                    } catch (err) {
                        console.log(`[Callback] ⚠️ Could not bridge tokens to auth.json: ${err}`)
                    }

                    // Clear resolver cache so next scan picks up OpenAI models
                    try {
                        const { unlinkSync } = require('node:fs')
                        const { join } = require('node:path')
                        unlinkSync(join(process.cwd(), '.nova-data', 'resolver-cache.json'))
                    } catch { /* ok */ }

                    return `✅ Login erfolgreich!\n\nAccount: ${tokens.accountId || 'unbekannt'}\nGültig bis: ${new Date(tokens.expires).toLocaleString('de')}\n\nTokens gespeichert. Nova nutzt jetzt OpenAI!`
                } catch (err) {
                    return `❌ Token-Exchange fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}\n\n💡 Stelle sicher, dass du die komplette Redirect-URL kopiert hast.`
                }
            } catch (err) {
                return `❌ Callback fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`
            }
        }

        default:
            return null // Unbekannter Befehl -> an LLM weiterleiten

        case 'monitor': {
            try {
                const { getServiceMonitor } = await import('../layers/L19-monitoring.js')
                const monitor = getServiceMonitor()

                const [subCmd, ...rest] = (args || '').split(/\s+/)

                switch (subCmd) {
                    case 'add': {
                        const [name, url] = rest
                        if (!name || !url) return '❌ Syntax: /monitor add <name> <url>'
                        monitor.addTarget(name, url)
                        return `✅ Monitor-Target "${name}" hinzugefügt: ${url}`
                    }
                    case 'remove':
                    case 'rm': {
                        const [name] = rest
                        if (!name) return '❌ Syntax: /monitor remove <name>'
                        const removed = monitor.removeTarget(name)
                        return removed ? `✅ "${name}" entfernt` : `❌ "${name}" nicht gefunden`
                    }
                    case 'check': {
                        const results = await monitor.checkAll()
                        return results.length > 0 ? results.join('\n\n') : '✅ Keine Targets konfiguriert'
                    }
                    case 'start':
                        monitor.start()
                        return '✅ Monitoring gestartet'
                    case 'stop':
                        monitor.stop()
                        return '⏹️ Monitoring gestoppt'
                    default:
                        return monitor.formatStatus()
                }
            } catch (err) {
                return `❌ Monitoring nicht verfügbar: ${err}`
            }
        }

        case 'task': {
            try {
                const { getFormattedStatus, getFormattedHistory } = await import('./task-tracker.js')
                let output = ''
                if (args.trim().toLowerCase() === 'history') {
                    output = getFormattedHistory()
                } else {
                    output = getFormattedStatus()
                }
                // Show active mission if running
                try {
                    const { getActiveMission } = await import('./autonomous-executor.js')
                    const mission = getActiveMission()
                    if (mission && mission.status === 'active') {
                        const done = mission.steps.filter(s => s.status === 'done').length
                        const total = mission.steps.length
                        const pct = Math.round((done / total) * 100)
                        output += '\n\n🎯 *Aktive Mission:*\n' + mission.goal.slice(0, 100) + '\nFortschritt: ' + done + '/' + total + ' (' + pct + '%) | /mission status'
                    }
                } catch { /* */ }
                // Show scheduled jobs
                try {
                    const { getCronerScheduler } = await import('./croner-scheduler.js')
                    const sched = getCronerScheduler()
                    const jobs = sched.listJobs()
                    if (jobs.length > 0) {
                        output += '\n\n⏰ *Geplante Jobs (' + jobs.length + '):*'
                        for (const j of jobs.slice(0, 5)) {
                            output += '\n  • ' + j.name + ' (' + j.pattern + ')'
                        }
                        if (jobs.length > 5) output += '\n  ... +' + (jobs.length - 5) + ' weitere'
                    }
                } catch { /* */ }
                // Show pending reminders
                try {
                    const { listRemindersTool } = await import('../tools/reminder-tool.js')
                    const result = await listRemindersTool.handler()
                    if (result.reminders && result.reminders.length > 0) {
                        output += '\n\n🔔 *Anstehende Erinnerungen (' + result.reminders.length + '):*'
                        for (const r of result.reminders.slice(0, 5)) {
                            const date = new Date(r.triggerAt)
                            const timeStr = date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                            output += '\n  • ' + timeStr + ' — ' + (r.message || '').slice(0, 50)
                        }
                    }
                } catch { /* */ }
                return output
            } catch (err) {
                return `❌ Task-Tracker nicht verfügbar: ${err}`
            }
        }

        case 'log':
        case 'logs': {
            try {
                const { getFormattedLogs } = await import('./task-tracker.js')
                const count = parseInt(args.trim()) || 20
                return getFormattedLogs(count)
            } catch (err) {
                return `❌ Log-Viewer nicht verfügbar: ${err}`
            }
        }
        case 'nodes':
        case 'node':
        case 'mesh': {
            try {
                const mesh = await import('../mesh/mesh-registry.js')
                const sub = args.trim().split(/\s+/)
                const action = sub[0]?.toLowerCase() || 'list'

                switch (action) {
                    case 'list':
                    case '': {
                        return await mesh.formatMeshNodes()
                    }

                    case 'all': {
                        return await mesh.formatMeshNodes({ includeHistorical: true })
                    }

                    case 'services':
                    case 'infra': {
                        return await mesh.formatMeshServices()
                    }

                    case 'add': {
                        // /nodes add <name> <ip> [user] [port]
                        const [, name, ip, user, port] = sub
                        if (!name || !ip) {
                            return `❌ Syntax: /nodes add <name> <ip> [user] [ssh-port]

Beispiel: /nodes add Jetson 100.64.0.22 xaventra 22`
                        }
                        mesh.addRemoteNode(
                            `nova-${name.toLowerCase()}`,
                            ip,
                            user || 'root',
                            parseInt(port || '22')
                        )
                        return `✅ Node "${name}" hinzugefügt (${ip}, user: ${user || 'root'}, port: ${port || '22'})

Nutze \`/nodes pair ${name}\` um die Verbindung zu testen.`
                    }

                    case 'remove':
                    case 'del': {
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes remove <name oder node-id>'
                        const node = await mesh.setNodeLifecycle(target, 'tombstoned', { reason: 'Vom Owner aus der Mesh-Registry entfernt' })
                        return node
                            ? `✅ Node "${node.hostname}" tombstoned. Er bleibt für Audit unter /nodes all erhalten.`
                            : `❌ Node "${target}" nicht gefunden.`
                    }

                    case 'retire': {
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes retire <name oder node-id>'
                        const node = await mesh.setNodeLifecycle(target, 'retired', { reason: 'Vom Owner außer Betrieb genommen' })
                        return node
                            ? `✅ Node "${node.hostname}" ist retired und nur noch unter /nodes all sichtbar.`
                            : `❌ Node "${target}" nicht gefunden.`
                    }

                    case 'tombstone': {
                        const target = sub[1]
                        const supersededBy = sub[2]
                        if (!target) return '❌ Syntax: /nodes tombstone <name oder node-id> [ersetzt-durch-node-id]'
                        const node = await mesh.setNodeLifecycle(target, 'tombstoned', {
                            reason: supersededBy ? 'Doppelte oder ersetzte Node-Identität' : 'Vom Owner tombstoned',
                            supersededBy,
                        })
                        return node
                            ? `✅ Node "${node.hostname}" tombstoned${supersededBy ? `; ersetzt durch ${supersededBy}` : ''}.`
                            : `❌ Node "${target}" nicht gefunden.`
                    }

                    case 'info':
                    case 'detail': {
                        // /nodes info <name|ip>
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes info <name oder ip>'
                        return await mesh.formatNodeDetail(target)
                    }

                    case 'pair':
                    case 'test': {
                        // /nodes pair <name|ip> — test SSH connectivity
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes pair <name oder ip>'

                        // Find the node
                        const nodes = await mesh.discoverNodes()
                        const node = nodes.find(n =>
                            n.hostname.toLowerCase() === target.toLowerCase() ||
                            n.node_id.includes(target.toLowerCase()) ||
                            n.ip === target
                        )

                        if (!node?.ip) return `❌ Node "${target}" nicht gefunden oder hat keine IP.`

                        // Test SSH connectivity
                        try {
                            const { execSync } = await import('child_process')
                            const sshUser = node.ssh_user || 'root'
                            const sshPort = node.ssh_port || 22
                            const result = execSync(
                                `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -p ${sshPort} ${sshUser}@${node.ip} "hostname && echo OK"`,
                                { timeout: 10000, encoding: 'utf-8' }
                            ).trim()
                            return `✅ **Pairing erfolgreich!**

🟢 Node: ${node.hostname} (${node.ip})
📡 SSH: ${sshUser}@${node.ip}:${sshPort}
💬 Response: \`${result}\`

Node ist erreichbar und bereit für Task-Delegation.`
                        } catch (err: any) {
                            return `❌ **Pairing fehlgeschlagen**

🔴 Node: ${node.hostname} (${node.ip})
📡 SSH: ${node.ssh_user || 'root'}@${node.ip}:${node.ssh_port || 22}
💬 Fehler: ${err.message?.slice(0, 200) || 'Verbindung timeout'}

Prüfe: SSH-Key vorhanden? Port offen? User korrekt?`
                        }
                    }

                    case 'install': {
                        // /nodes install <name|ip> — install Nova on remote node
                        const target = sub[1]
                        if (!target) return `❌ Syntax: /nodes install <name oder ip>

Installiert Nova auf einem Remote-Node via SSH.
Voraussetzung: SSH-Zugang mit Key-Auth.`

                        const nodes = await mesh.discoverNodes()
                        const node = nodes.find(n =>
                            n.hostname.toLowerCase() === target.toLowerCase() ||
                            n.node_id.includes(target.toLowerCase()) ||
                            n.ip === target
                        )

                        if (!node?.ip) return `❌ Node "${target}" nicht gefunden. Erst mit /nodes add hinzufügen.`

                        const sshUser = node.ssh_user || 'root'
                        const sshPort = node.ssh_port || 22
                        const sshTarget = `${sshUser}@${node.ip}`

                        try {
                            const { execSync } = await import('child_process')

                            // Step 1: Check if Node.js is installed
                            let hasNode = false
                            try {
                                execSync(`ssh -o ConnectTimeout=5 -p ${sshPort} ${sshTarget} "node --version"`, { timeout: 10000, encoding: 'utf-8' })
                                hasNode = true
                            } catch { /* no node */ }

                            const steps: string[] = []
                            steps.push(`🔌 Verbinde mit ${sshTarget}:${sshPort}...`)

                            if (!hasNode) {
                                steps.push('📦 Node.js nicht gefunden — installiere...')
                                try {
                                    execSync(`ssh -p ${sshPort} ${sshTarget} "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"`, { timeout: 120000, encoding: 'utf-8' })
                                    steps.push('✅ Node.js 20 installiert')
                                } catch {
                                    steps.push('❌ Node.js Installation fehlgeschlagen. Manuell installieren!')
                                    return steps.join('\n')
                                }
                            } else {
                                steps.push('✅ Node.js vorhanden')
                            }

                            // Step 2: Clone/update Nova
                            steps.push('📥 Nova-Core clonen/updaten...')
                            try {
                                execSync(`ssh -p ${sshPort} ${sshTarget} "if [ -d /opt/nova-core ]; then cd /opt/nova-core && git pull; else git clone https://github.com/samuelvoltarius/xaventra.git /opt/nova-core; fi"`, { timeout: 60000, encoding: 'utf-8' })
                                steps.push('✅ Nova-Core Repository bereit')
                            } catch {
                                steps.push('⚠ Git clone/pull fehlgeschlagen — Repository manuell prüfen')
                            }

                            // Step 3: Install dependencies
                            steps.push('📦 Dependencies installieren...')
                            try {
                                execSync(`ssh -p ${sshPort} ${sshTarget} "cd /opt/nova-core && npm install --production"`, { timeout: 120000, encoding: 'utf-8' })
                                steps.push('✅ npm install erfolgreich')
                            } catch {
                                steps.push('⚠ npm install fehlgeschlagen')
                            }

                            // Step 4: Build
                            steps.push('🔨 Building...')
                            try {
                                execSync(`ssh -p ${sshPort} ${sshTarget} "cd /opt/nova-core && npm run build"`, { timeout: 120000, encoding: 'utf-8' })
                                steps.push('✅ Build erfolgreich')
                            } catch {
                                steps.push('⚠ Build fehlgeschlagen — manuell prüfen')
                            }

                            steps.push(`\n🎉 **Installation auf ${node.hostname} abgeschlossen!**`)
                            steps.push(`Starte mit: \`ssh ${sshTarget} "cd /opt/nova-core && node dist/daemon.js"\``)

                            return steps.join('\n')
                        } catch (err: any) {
                            return `❌ Installation fehlgeschlagen: ${err.message?.slice(0, 200)}`
                        }
                    }

                    case 'status': {
                        return mesh.formatMeshStatus()
                    }

                    case 'plan': {
                        const { scanAndBuildNodePlan } = await import('../mesh/node-planner.js')
                        return await scanAndBuildNodePlan()
                    }

                    case 'restart': {
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes restart <name oder node-id>'
                        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
                        const node = (config.mesh?.update?.nodes || []).find((item: any) =>
                            item.nodeId === target || String(item.name || '').toLowerCase() === target.toLowerCase() || item.host === target,
                        )
                        if (!node) return `❌ Kein typisiertes Runtime-Profil für "${target}" konfiguriert.`
                        try {
                            const { restartManagedNode } = await import('./auto-updater.js')
                            await restartManagedNode(node)
                            return `✅ ${node.name} gezielt neu gestartet und per frischem Mesh-Heartbeat verifiziert.`
                        } catch (err: any) {
                            return `❌ Sicherer Restart fehlgeschlagen: ${err?.message || err}`
                        }
                    }

                    case 'sync':
                    case 'update':
                    case 'deploy': {
                        const target = sub[1]
                        if (!target) return '❌ Syntax: /nodes sync <name oder node-id>'
                        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf8'))
                        const updateConfig = config.mesh?.update
                        const configured = (updateConfig?.nodes || []).filter((node: any) =>
                            node.nodeId === target || String(node.name || '').toLowerCase() === target.toLowerCase() || node.host === target,
                        )
                        if (!updateConfig?.enabled || configured.length === 0) {
                            return `❌ Kein sicherer Update-Profile für "${target}" unter mesh.update.nodes konfiguriert.`
                        }
                        const { deployUpdateToAllNodes } = await import('./auto-updater.js')
                        const success = await deployUpdateToAllNodes({ ...updateConfig, nodes: configured })
                        return success
                            ? `✅ Signiertes Release auf ${configured[0].name} ausgerollt und per Heartbeat verifiziert.`
                            : `⚠️ Rollout auf ${configured[0].name} fehlgeschlagen oder zurückgerollt. Details: /update status`

                        /* Legacy SSH sync implementation retained below only
                         * as unreachable migration context until the next
                         * source cleanup. No killall/pkill path is executable. */
                        // /nodes sync <name|ip> — copy dist/ + config + restart
                        const legacyTarget = sub[1]
                        if (!legacyTarget) return `❌ Syntax: /nodes sync <name oder ip>

Synchronisiert dist/ und config auf einen Remote-Node und startet ihn neu.
Führt vorher automatisch Pre-Flight Checks durch.`

                        const nodes = await mesh.discoverNodes()
                        const node = nodes.find((n: any) =>
                            n.hostname.toLowerCase() === legacyTarget.toLowerCase() ||
                            n.node_id.includes(legacyTarget.toLowerCase()) ||
                            n.ip === legacyTarget
                        )

                        if (!node?.ip) return `❌ Node "${legacyTarget}" nicht gefunden.`

                        const sshUser = node.ssh_user || 'xaventra'
                        const sshPort = node.ssh_port || 22

                        try {
                            const { execSync } = await import('child_process')
                            const steps: string[] = []
                            steps.push(`📦 Sync auf **${node.hostname}** (${node.ip})...\n`)

                            // Step 1: Pre-flight
                            steps.push('🔍 Pre-Flight Check...')
                            try {
                                const { runRemotePreFlight } = await import('./preflight-checks.js')
                                const pfResult = await runRemotePreFlight(node.ip, sshUser, sshPort)
                                steps.push(`   ${pfResult.summary}`)
                                const critFails = pfResult.checks.filter(c => c.status === 'fail' && c.name === 'SSH Connection')
                                if (critFails.length > 0) {
                                    steps.push('🛑 SSH nicht erreichbar — Sync abgebrochen!')
                                    return steps.join('\n')
                                }
                            } catch {
                                steps.push('⚠️ Pre-Flight übersprungen')
                            }

                            // Step 2: Stop remote daemon
                            steps.push('\n⏹️ Stoppe Remote-Daemon...')
                            try {
                                throw new Error('Legacy broad process termination is disabled')
                            } catch {
                                steps.push('⚠️ Legacy-Sync deaktiviert; typisiertes Runtime-Profil erforderlich')
                            }

                            // Step 3: Copy dist/
                            steps.push('\n📤 Kopiere dist/...')
                            try {
                                execSync(
                                    `scp -r -P ${sshPort} dist ${sshUser}@${node.ip}:~/nova-core/`,
                                    { timeout: 120000, encoding: 'utf-8', cwd: process.cwd() }
                                )
                                steps.push('✅ dist/ synchronisiert')
                            } catch (err: any) {
                                steps.push(`❌ SCP fehlgeschlagen: ${err.message?.slice(0, 100)}`)
                                return steps.join('\n')
                            }

                            // Step 4: Copy config (if not exists remotely)
                            try {
                                const hasConfig = execSync(
                                    `ssh -o ConnectTimeout=5 -p ${sshPort} ${sshUser}@${node.ip} "test -f ~/nova-core/xaventra.config.json && echo YES || echo NO"`,
                                    { timeout: 5000, encoding: 'utf-8' }
                                ).trim()
                                if (hasConfig === 'NO') {
                                    steps.push('📋 Kopiere config...')
                                    execSync(
                                        `scp -P ${sshPort} xaventra.config.json ${sshUser}@${node.ip}:~/nova-core/`,
                                        { timeout: 10000, encoding: 'utf-8', cwd: process.cwd() }
                                    )
                                    steps.push('✅ Config kopiert')
                                }
                            } catch { /* config copy optional */ }

                            // Step 5: Start daemon
                            steps.push('\n🚀 Starte Nova Daemon...')
                            try {
                                execSync(
                                    `ssh -o ConnectTimeout=5 -p ${sshPort} ${sshUser}@${node.ip} "cd ~/nova-core && setsid bash -c 'NOVA_NODE_ONLY=true npx tsx src/daemon.ts > /tmp/nova-node.log 2>&1' &"`,
                                    { timeout: 10000, encoding: 'utf-8' }
                                )

                                // Wait and get log snippet
                                const log = execSync(
                                    `ssh -o ConnectTimeout=5 -p ${sshPort} ${sshUser}@${node.ip} "sleep 4 && tail -5 ~/nova-core/nova.log"`,
                                    { timeout: 15000, encoding: 'utf-8' }
                                ).trim()
                                steps.push('✅ Nova gestartet')
                                steps.push(`\n📋 Log:\n\`\`\`\n${log.slice(0, 400)}\n\`\`\``)
                            } catch (err: any) {
                                steps.push(`❌ Start fehlgeschlagen: ${err.message?.slice(0, 150)}`)
                            }

                            steps.push(`\n🎉 **Sync auf ${node.hostname} abgeschlossen!**`)
                            return steps.join('\n')
                        } catch (err: any) {
                            return `❌ Sync fehlgeschlagen: ${err.message?.slice(0, 200)}`
                        }
                    }

                    case 'check': {
                        // /nodes check <host|ip> [user] [port]
                        // Probe a NEW host: discover OS, hardware, AI tools — ask about Nova install
                        const rawHost = sub[1]
                        if (!rawHost) return `❌ Syntax: /nodes check <host oder IP> [user] [ssh-port]

Beispiel: /nodes check 100.64.0.22 xaventra 22

Prüft einen neuen Host auf:
  • Erreichbarkeit (SSH)
  • OS & Hardware (RAM, GPU, CPU)
  • Installierte AI-Tools (Ollama, vLLM, Whisper...)
  • Bereits laufende Modelle
  • Nova-Daemon Präsenz
  • Hardware-passende Modell-Empfehlungen`

                        const checkUser = sub[2] || 'xaventra'
                        const checkPort = parseInt(sub[3] || '22')
                        const sshTarget = `${checkUser}@${rawHost}`

                        const steps: string[] = []
                        steps.push(`🔍 **Prüfe Host: ${rawHost}**\n`)

                        try {
                            const { execSync } = await import('child_process')
                            const sshOpts = `-o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes -p ${checkPort}`

                            // Step 1: Reachability
                            steps.push('📡 SSH-Verbindung testen...')
                            let sshOk = false
                            try {
                                const echo = execSync(
                                    `ssh ${sshOpts} ${sshTarget} "echo NOVA_PING"`,
                                    { timeout: 8000, encoding: 'utf-8' }
                                ).trim()
                                sshOk = echo.includes('NOVA_PING')
                            } catch { /* unreachable */ }

                            if (!sshOk) {
                                return `❌ **Host nicht erreichbar: ${rawHost}**

SSH-Verbindung zu ${sshTarget}:${checkPort} fehlgeschlagen.

Mögliche Ursachen:
  • SSH-Key nicht autorisiert (BatchMode=yes — kein Passwort)
  • Host offline oder falscher Port
  • Firewall blockiert Port ${checkPort}

Lösung:
  \`ssh-copy-id -p ${checkPort} ${sshTarget}\`
  dann: \`/nodes check ${rawHost} ${checkUser} ${checkPort}\``
                            }
                            steps.push('✅ SSH erreichbar\n')

                            // Step 2: Full inventory via single SSH call
                            steps.push('🔬 Hardware & Software Inventory...')
                            let inventory = ''
                            try {
                                inventory = execSync(
                                    `ssh ${sshOpts} ${sshTarget} "` +
                                    `echo ===OS===; uname -s; cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"'; ` +
                                    `echo ===ARCH===; uname -m; ` +
                                    `echo ===RAM===; free -m 2>/dev/null | awk '/Mem:/{print $2}' || sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1048576)}'; ` +
                                    `echo ===CPU===; nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 0; ` +
                                    `echo ===GPU===; nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || echo NONE; ` +
                                    `echo ===DISK===; df -BG / 2>/dev/null | tail -1 | awk '{print $2, $4}' || echo 0G 0G; ` +
                                    `echo ===OLLAMA===; ollama list 2>/dev/null | tail -n +2 | awk '{print $1}' || echo NONE; ` +
                                    `echo ===VLLM===; curl -s --connect-timeout 2 http://localhost:8000/v1/models 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(",".join([m["id"] for m in d.get("data",[])])[:200])' 2>/dev/null || echo NONE; ` +
                                    `echo ===LMS===; curl -s --connect-timeout 2 http://localhost:1234/v1/models 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(",".join([m["id"] for m in d.get("data",[])])[:200])' 2>/dev/null || echo NONE; ` +
                                    `echo ===NOVA===; pgrep -f daemon.js > /dev/null 2>&1 && echo RUNNING || echo STOPPED; ` +
                                    `echo ===TOOLS===; which ollama docker python3 ffmpeg git whisper 2>/dev/null | xargs -I{} basename {} | tr '\\n' ',' ; echo; ` +
                                    `echo ===END==="`,
                                    { timeout: 30000, encoding: 'utf-8' }
                                )
                            } catch (sshErr: any) {
                                steps.push(`⚠️ Inventory-Abfrage teilweise fehlgeschlagen: ${sshErr?.message?.slice(0, 100)}`)
                            }

                            // Parse inventory sections
                            const sections: Record<string, string> = {}
                            let currentSection = ''
                            for (const line of inventory.split('\n')) {
                                const trimmed = line.trim()
                                const sectionMatch = trimmed.match(/^===(\w+)===$/)
                                if (sectionMatch) {
                                    currentSection = sectionMatch[1]
                                    sections[currentSection] = ''
                                } else if (currentSection && currentSection !== 'END') {
                                    sections[currentSection] = (sections[currentSection] + '\n' + trimmed).trim()
                                }
                            }

                            const osStr = (sections['OS'] || 'Unknown').split('\n').filter(Boolean).slice(-1)[0] || 'Unknown'
                            const arch = (sections['ARCH'] || '').trim()
                            const ramMb = parseInt((sections['RAM'] || '0').trim()) || 0
                            const ramGb = ramMb > 1000 ? Math.round(ramMb / 1024) : ramMb
                            const cpuCores = parseInt((sections['CPU'] || '0').trim()) || 0
                            const gpuRaw = (sections['GPU'] || 'NONE').trim()
                            const hasGpu = gpuRaw !== 'NONE' && gpuRaw.length > 2
                            const gpuParts = hasGpu ? gpuRaw.split(',') : []
                            const gpuName = gpuParts[0]?.trim() || undefined
                            const gpuVramMb = parseInt(gpuParts[1]?.trim() || '0') || 0

                            const ollamaRaw = (sections['OLLAMA'] || 'NONE').trim()
                            const ollamaModels = ollamaRaw !== 'NONE' ? ollamaRaw.split('\n').filter(Boolean) : []
                            const vllmRaw = (sections['VLLM'] || 'NONE').trim()
                            const vllmModels = vllmRaw !== 'NONE' ? vllmRaw.split(',').filter(Boolean) : []
                            const lmsRaw = (sections['LMS'] || 'NONE').trim()
                            const lmsModels = lmsRaw !== 'NONE' ? lmsRaw.split(',').filter(Boolean) : []
                            const novaStatus = (sections['NOVA'] || 'STOPPED').trim()
                            const tools = (sections['TOOLS'] || '').split(',').filter(Boolean)

                            // Build result summary
                            steps.push(`\n📋 **System-Report: ${rawHost}**`)
                            steps.push(`🖥️ OS: ${osStr} (${arch})`)
                            steps.push(`💾 RAM: ~${ramGb}GB | 🔲 CPU: ${cpuCores || '?'} Cores`)
                            if (hasGpu && gpuName) {
                                steps.push(`🎮 GPU: ${gpuName}${gpuVramMb ? ` (${Math.round(gpuVramMb / 1024)}GB VRAM)` : ''}`)
                            } else {
                                steps.push(`🖥️ GPU: Keine dedizierte GPU`)
                            }

                            // AI tools
                            steps.push(`\n🤖 **AI Tools:**`)
                            if (ollamaModels.length > 0) {
                                steps.push(`✅ Ollama — ${ollamaModels.length} Modell(e): ${ollamaModels.slice(0, 5).join(', ')}${ollamaModels.length > 5 ? '...' : ''}`)
                            } else if (tools.includes('ollama')) {
                                steps.push(`⚠️ Ollama installiert aber keine Modelle geladen`)
                            } else {
                                steps.push(`❌ Ollama: nicht installiert`)
                            }
                            if (vllmModels.length > 0) {
                                steps.push(`✅ vLLM — ${vllmModels.join(', ')}`)
                            }
                            if (lmsModels.length > 0) {
                                steps.push(`✅ LM Studio — ${lmsModels.join(', ')}`)
                            }
                            const otherTools = tools.filter((t: string) => !['bash', 'sh'].includes(t))
                            if (otherTools.length > 0) {
                                steps.push(`🔧 Tools: ${otherTools.join(', ')}`)
                            }

                            // Nova status
                            steps.push(`\n🤖 **Nova Daemon:** ${novaStatus === 'RUNNING' ? '✅ läuft' : '❌ nicht aktiv'}`)

                            // Model recommendations
                            const { getRecommendations, formatRecommendations, hardwareFromMeshNode } = await import('../mesh/model-recommender.js')
                            const hwProfile = {
                                ramGb,
                                vramGb: gpuVramMb > 0 ? Math.round(gpuVramMb / 1024) : undefined,
                                cpuCores,
                                hasGpu,
                                gpuType: hasGpu ? 'cuda' as const : undefined,
                                arch,
                                isJetson: osStr.toLowerCase().includes('jetson'),
                                isRaspberryPi: osStr.toLowerCase().includes('raspberry'),
                            }
                            const allModels = [...ollamaModels, ...vllmModels, ...lmsModels]
                            const recs = getRecommendations(rawHost, hwProfile, allModels)

                            if (recs.toInstall.length > 0) {
                                steps.push(`\n${formatRecommendations(recs)}`)
                            } else if (allModels.length > 0) {
                                steps.push(`\n✅ Alle empfohlenen Modelle bereits installiert`)
                            }

                            if (recs.deprecated.length > 0) {
                                steps.push(`\n⚠️ Veraltete Modelle: ${recs.deprecated.join(', ')}`)
                            }

                            // Options for user
                            steps.push(`\n**🎛️ Nächste Schritte:**`)
                            if (novaStatus !== 'RUNNING') {
                                const nodeName = rawHost.replace(/[.@]/g, '-')
                                steps.push(`• Node registrieren: \`/nodes add ${nodeName} ${rawHost} ${checkUser} ${checkPort}\``)
                                steps.push(`• Nova installieren: \`/nodes install ${nodeName}\``)
                            } else {
                                steps.push(`• Node zur Mesh hinzufügen: \`/nodes add ${rawHost.replace(/[.@]/g, '-')} ${rawHost} ${checkUser} ${checkPort}\``)
                            }
                            if (!tools.includes('ollama') && recs.recommended.length > 0) {
                                steps.push(`• Ollama installieren: \`ssh ${sshTarget} "curl -fsSL https://ollama.com/install.sh | sh"\``)
                            }
                            if (recs.toInstall.length > 0 && tools.includes('ollama')) {
                                steps.push(`• Modelle installieren:\n\`\`\`\n${recs.pullCommands.slice(0, 3).join('\n')}\n\`\`\``)
                            }

                        } catch (err: any) {
                            return `❌ Check fehlgeschlagen: ${err.message?.slice(0, 200)}`
                        }

                        return steps.join('\n')
                    }

                    case 'models': {
                        // /nodes models — per-node LLM topology view
                        try {
                            const { discoverNodes } = await import('../mesh/mesh-registry.js')
                            const { getLastScanResult, scanAllAIServices } = await import('../mesh/ai-scanner.js')
                            const { formatNodeTopology } = await import('../mesh/model-recommender.js')
                            const { getLocalNodeId } = await import('../mesh/mesh-registry.js')

                            // Use cached scan or do a quick scan
                            let scanResult = getLastScanResult()
                            if (!scanResult) {
                                try {
                                    scanResult = await scanAllAIServices({ skipBinaryCheck: true })
                                } catch { /* ignore */ }
                            }

                            // Build node topology from mesh registry + scan results
                            const meshNodes = await discoverNodes()
                            const localNodeId = getLocalNodeId()

                            // Group scan results by sourceNode
                            const modelsByNode = new Map<string, string[]>()
                            const servicesByNode = new Map<string, string[]>()
                            if (scanResult) {
                                for (const svc of scanResult.services) {
                                    const node = svc.sourceNode || 'local'
                                    if (svc.type === 'llm' && svc.models.length > 0) {
                                        const existing = modelsByNode.get(node) || []
                                        for (const m of svc.models) {
                                            if (!existing.includes(m)) existing.push(m)
                                        }
                                        modelsByNode.set(node, existing)
                                    } else if (svc.type !== 'llm' && svc.status === 'running') {
                                        const svcList = servicesByNode.get(node) || []
                                        svcList.push(`${svc.type.toUpperCase()}:${svc.name}`)
                                        servicesByNode.set(node, svcList)
                                    }
                                }
                            }

                            // Also use software.ollama_models from mesh registry
                            const topologyNodes = meshNodes.map(n => {
                                const label = n.hostname || n.node_id
                                const fromScan = modelsByNode.get(label) || modelsByNode.get(n.ip || '') || []
                                const fromRegistry = n.software?.ollama_models || []
                                const combined = [...new Set([...fromScan, ...fromRegistry])]

                                return {
                                    name: label,
                                    status: n.status,
                                    isLocal: n.node_id === localNodeId,
                                    models: combined,
                                    hardware: n.hardware ? {
                                        ramGb: n.hardware.ram_gb,
                                        vramGb: n.hardware.gpu_vram_mb ? Math.round(n.hardware.gpu_vram_mb / 1024) : undefined,
                                        gpu: n.hardware.gpu,
                                        cores: n.hardware.cores,
                                    } : undefined,
                                    services: servicesByNode.get(label),
                                }
                            })

                            // Add 'local' from scan if not in mesh registry
                            if (!topologyNodes.some(n => n.isLocal)) {
                                const localModels = modelsByNode.get('local') || []
                                if (localModels.length > 0) {
                                    topologyNodes.unshift({
                                        name: 'local',
                                        status: 'online' as const,
                                        isLocal: true,
                                        models: localModels,
                                        hardware: undefined as any,
                                        services: servicesByNode.get('local'),
                                    })
                                }
                            }

                            if (topologyNodes.length === 0) {
                                return '🗺️ Keine Nodes im Mesh. Nutze /nodes check <ip> um Hosts zu entdecken.'
                            }

                            return formatNodeTopology(topologyNodes)
                        } catch (err: any) {
                            return `❌ Modell-Topologie nicht verfügbar: ${err?.message || err}`
                        }
                    }

                    case 'recommend': {
                        // /nodes recommend [name] — model recommendations for a node
                        const target = sub[1]

                        try {
                            const { discoverNodes, getLocalNodeId } = await import('../mesh/mesh-registry.js')
                            const { getLastScanResult } = await import('../mesh/ai-scanner.js')
                            const { getRecommendations, formatRecommendations, hardwareFromMeshNode } = await import('../mesh/model-recommender.js')

                            const nodes = await discoverNodes()
                            const localId = getLocalNodeId()

                            // Find target node (or use local if no arg)
                            let node = target
                                ? nodes.find(n =>
                                    n.hostname.toLowerCase() === target.toLowerCase() ||
                                    n.node_id.includes(target.toLowerCase()) ||
                                    n.ip === target
                                )
                                : nodes.find(n => n.node_id === localId)

                            if (!node && !target) {
                                // No local node in registry — still show recommendations without hardware
                                const recs = getRecommendations('local', { ramGb: 8, hasGpu: false })
                                return formatRecommendations(recs)
                            }

                            if (!node) return `❌ Node "${target}" nicht gefunden. Nutze /nodes für eine Liste.`

                            // Get installed models from scan + registry
                            const scanResult = getLastScanResult()
                            const label = node.hostname || node.node_id
                            const installedFromScan: string[] = []
                            if (scanResult) {
                                for (const svc of scanResult.services) {
                                    if ((svc.sourceNode === label || svc.sourceNode === node.ip) && svc.type === 'llm') {
                                        installedFromScan.push(...svc.models)
                                    }
                                }
                            }
                            const installedFromRegistry = node.software?.ollama_models || []
                            const installedModels = [...new Set([...installedFromScan, ...installedFromRegistry])]

                            const hwProfile = hardwareFromMeshNode(node)
                            const recs = getRecommendations(label, hwProfile, installedModels)
                            return formatRecommendations(recs)

                        } catch (err: any) {
                            return `❌ Empfehlungen nicht verfügbar: ${err?.message || err}`
                        }
                    }

                    case 'scan': {
                        // AI Service scan (was /ai scan)
                        try {
                            const { scanAllAIServices } = await import('../mesh/ai-scanner.js')
                            const result = await scanAllAIServices()
                            const running = result.services.filter((s: any) => s.status === 'running')
                            const installed = result.services.filter((s: any) => s.status !== 'running')
                            let msg = `🔍 *Mesh AI Scan* (${result.scanDurationMs}ms)\n\n`
                            if (running.length > 0) {
                                msg += `🟢 *Laufend (${running.length}):*\n`
                                for (const s of running) {
                                    msg += `  • ${s.type.toUpperCase()} *${s.name}* on ${s.sourceNode} :${s.port}`
                                    if (s.models.length > 0) msg += ` (${s.models.slice(0, 3).join(', ')})`
                                    msg += '\n'
                                }
                            }
                            if (installed.length > 0) {
                                msg += `\n💤 *Installiert (${installed.length}):*\n`
                                for (const s of installed) {
                                    msg += `  • ${s.type.toUpperCase()} *${s.name}* on ${s.sourceNode}\n`
                                }
                            }
                            if (running.length === 0 && installed.length === 0) {
                                msg += 'Keine AI Services gefunden.'
                            }
                            return msg
                        } catch (err: any) {
                            return `❌ Mesh Scan fehlgeschlagen: ${err?.message || err}`
                        }
                    }

                    case 'route': {
                        // Show routing diagnostics
                        try {
                            const { getRoutingDiagnostics } = await import('../mesh/mesh-router.js')
                            return getRoutingDiagnostics()
                        } catch (err: any) {
                            return `❌ Routing nicht verfügbar: ${err?.message || err}`
                        }
                    }

                    default:
                        return `🌐 *Nova Mesh — Befehle*

*Discovery:*
\`/nodes\` — Aktive und kürzlich erreichbare Nova-Nodes
\`/nodes all\` — Historische, retired und tombstoned Nodes
\`/nodes services\` — Relay, Witness, Transporte und AI-Runtimes
\`/nodes check <ip> [user] [port]\` — Neuen Host prüfen + AI-Tools entdecken
\`/nodes models\` — LLM-Topologie: welche Modelle auf welchem Node
\`/nodes scan\` — Live AI-Service-Scan aller Mesh-Nodes

*Node Management:*
\`/nodes add <name> <ip> [user] [port]\` — Node registrieren
\`/nodes remove <name>\` — Node revisionssicher tombstonen
\`/nodes retire <name>\` — Node außer Betrieb nehmen
\`/nodes tombstone <name> [ersetzt-durch]\` — Doppelte Identität sperren
\`/nodes pair <name>\` — SSH-Verbindung testen
\`/nodes install <name>\` — Nova auf Remote-Node installieren
\`/nodes sync <name>\` — Code + Config kopieren + Restart
\`/nodes restart <name>\` — Daemon neustarten

*AI Models:*
\`/nodes recommend [name]\` — Modell-Empfehlungen für Hardware
\`/nodes info <name>\` — Detailansicht eines Nodes

*Routing:*
\`/nodes route\` — Routing-Diagnostik
\`/nodes status\` — Eigenen Node-Status`
                }
            } catch (err) {
                return `❌ Mesh nicht verfügbar: ${err}`
            }
        }
        case 'hosts':
        case 'host': {
            try {
                const { loadHosts: loadHostsForCmd, saveHosts: saveHostsForCmd } = await import('../tools/ssh-tool-hosts.js')
                const db = loadHostsForCmd()
                const sub = args.trim().split(/\s+/)
                const action = sub[0]?.toLowerCase() || 'list'

                // Auto-detect which machine Nova is running on
                const { hostname: osHostname, platform: osPlatform, networkInterfaces } = await import('node:os')
                const localName = osHostname()
                const localIPs = Object.values(networkInterfaces())
                    .flat()
                    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
                    .map(i => i.address)

                switch (action) {
                    case 'new':
                    case 'add': {
                        // /hosts new <name> <ip> <user> [password] [description]
                        const [, name, ip, user, pw, ...descParts] = sub
                        if (!name || !ip || !user) {
                            return `❌ Syntax: /hosts new <name> <ip> <user> [passwort] [beschreibung]

Beispiel: /hosts new Jetson 100.64.0.22 xaventra meinPW NVIDIA Jetson Orin`
                        }
                        const desc = descParts.join(' ') || `Manuell hinzugefügt am ${new Date().toISOString().slice(0, 10)}`
                        const existing = db.hosts.find(h => h.name.toLowerCase() === name.toLowerCase() || h.ip === ip)
                        if (existing) {
                            existing.name = name
                            existing.ip = ip
                            existing.user = user
                            if (pw) existing.password = pw
                            existing.description = desc
                            if (!existing.alias.includes(name.toLowerCase())) {
                                existing.alias.push(name.toLowerCase())
                            }
                            existing.lastSeen = new Date().toISOString()
                            saveHostsForCmd(db)
                            return `✅ Host *${name}* aktualisiert: ${user}@${ip}`
                        } else {
                            db.hosts.push({
                                name,
                                alias: [name.toLowerCase()],
                                ip,
                                user,
                                password: pw || undefined,
                                description: desc,
                                lastSeen: new Date().toISOString(),
                            })
                            saveHostsForCmd(db)
                            return `✅ Host *${name}* hinzugefügt: ${user}@${ip}${pw ? ' [Passwort gespeichert]' : ''}`
                        }
                    }

                    case 'del':
                    case 'delete':
                    case 'rm':
                    case 'remove': {
                        const [, target] = sub
                        if (!target) return '❌ Syntax: /hosts del <name|ip>'
                        const needle = target.toLowerCase()
                        const idx = db.hosts.findIndex(h =>
                            h.name.toLowerCase() === needle ||
                            h.ip === needle ||
                            h.alias.some(a => a.toLowerCase() === needle)
                        )
                        if (idx === -1) return `❌ Host "${target}" nicht gefunden`
                        const removed = db.hosts.splice(idx, 1)[0]
                        saveHostsForCmd(db)
                        return `🗑️ Host *${removed.name}* (${removed.ip}) entfernt`
                    }

                    case 'list':
                    default: {
                        if (db.hosts.length === 0) {
                            return `📡 *Keine Hosts gespeichert*

Nutze /hosts new um einen hinzuzufügen:
/hosts new \<name\> \<ip\> \<user\> [passwort]`
                        }

                        const hostLines = db.hosts.map(h => {
                            const isLocal = localIPs.includes(h.ip) || h.name.toLowerCase() === localName.toLowerCase()
                            const localTag = isLocal ? ' 🏠 (LOKAL)' : ''
                            const pwTag = h.password ? '🔑' : '🔓'
                            const aliases = h.alias?.length ? ` (${h.alias.join(', ')})` : ''
                            const lastSeen = h.lastSeen ? ` | Zuletzt: ${h.lastSeen.slice(0, 10)}` : ''
                            return `${pwTag} *${h.name}*${aliases}${localTag}
   ${h.user}@${h.ip}${lastSeen}
   ${h.description || ''}`
                        }).join('\n\n')

                        return `📡 *Bekannte Hosts (${db.hosts.length})*

🏠 Nova läuft auf: *${localName}* (${osPlatform()}) — IPs: ${localIPs.join(', ') || 'keine'}

${hostLines}

_/hosts new \<name\> \<ip\> \<user\> [pw] — Host hinzufügen_
_/hosts del \<name\> — Host entfernen_`
                    }
                }
            } catch (err) {
                return `❌ Host-Verwaltung Fehler: ${err}`
            }
        }

        // ============================================
        // Debugging / Transparency Commands
        // ============================================

        case 'reasoning':
        case 'reason': {
            const globalState = (globalThis as any).__novaState || state
            const argLower = args.trim().toLowerCase()
            if (argLower === 'on') {
                globalState.showReasoning = true
            } else if (argLower === 'off') {
                globalState.showReasoning = false
            } else {
                globalState.showReasoning = !globalState.showReasoning
            }
            const status = globalState.showReasoning ? '✅ AN' : '❌ AUS'
            return `🧠 *Reasoning-Modus: ${status}*

${globalState.showReasoning
                    ? `Geschützte Reasoning-Diagnostik ist aktiv. Interne Gedankentokens bleiben privat; /verbose zeigt stattdessen Denkmodus, Modell, Node, Laufzeit und verifizierte Evidence.

_Deaktivieren: /reasoning off_`
                    : 'Geschützte Reasoning-Diagnostik ist deaktiviert.'}`
        }

        case 'verbose':
        case 'debug': {
            const globalState = (globalThis as any).__novaState || state
            const argLower = args.trim().toLowerCase()
            if (argLower === 'on') {
                globalState.verboseMode = true
            } else if (argLower === 'off') {
                globalState.verboseMode = false
            } else {
                globalState.verboseMode = !globalState.verboseMode
            }
            const status = globalState.verboseMode ? '✅ AN' : '❌ AUS'
            return `🔍 *Verbose-Modus: ${status}*

${globalState.verboseMode
                    ? `Du siehst jetzt:
• 🧠 Reasoning/Thinking Output
• 🔧 Tool-Aufrufe und Ergebnisse
• ⏱ Timing & Token-Verbrauch
• 🔄 Pipeline-Schritte

_Deaktivieren: /verbose off_`
                    : 'Verbose-Output wird wieder ausgeblendet.'}`
        }

        case 'autonomy':
        case 'autonom': {
            try {
                const { getAutonomyStatus, startAutonomyLoop, stopAutonomyLoop, triggerAutonomyCheck, updateAutonomyConfig } = await import('./autonomy-loop.js')
                const argLower = args.trim().toLowerCase()

                if (argLower === 'on' || argLower === 'start') {
                    updateAutonomyConfig({ enabled: true })
                    return `🤖 *Autonomy Loop: ✅ AKTIVIERT*\n\nNova prüft jetzt selbstständig alle 10 Minuten:\n• System Health (Disk, RAM)\n• Offene Erinnerungen\n• Fehler-Logs\n• Uptime\n\n_Deaktivieren: /autonomy off_`
                }

                if (argLower === 'off' || argLower === 'stop') {
                    updateAutonomyConfig({ enabled: false })
                    return `🤖 *Autonomy Loop: ❌ DEAKTIVIERT*\n\nNova schläft jetzt bis zur nächsten Nachricht.\n\n_Aktivieren: /autonomy on_`
                }

                if (argLower === 'trigger' || argLower === 'check' || argLower === 'run') {
                    const report = await triggerAutonomyCheck()
                    let msg = `🤖 *Autonomy Check (manuell)*\n\n${report.summary}\n\n`
                    for (const check of report.checks) {
                        const icon = check.severity === 'critical' ? '🚨' : check.severity === 'warning' ? '⚠️' : '✅'
                        msg += `${icon} *${check.source}:* ${check.message}\n`
                    }
                    msg += `\n_Benachrichtigung gesendet: ${report.notificationSent ? 'Ja' : 'Nein'}_`
                    return msg
                }

                // Default: show status
                const status = getAutonomyStatus()
                const running = status.running ? '✅ Aktiv' : '❌ Inaktiv'
                const enabled = status.config.enabled ? 'Ja' : 'Nein'
                const quietActive = status.config.quietHoursStart >= 0
                const quietStr = quietActive
                    ? `✅ ${status.config.quietHoursStart}:00 - ${status.config.quietHoursEnd}:00`
                    : '❌ Deaktiviert'
                const lastCheck = status.lastReport
                    ? new Date(status.lastReport.timestamp).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
                    : 'Noch kein Check'

                return `🤖 *Nova Autonomy Status*\n\n` +
                    `Status: ${running}\n` +
                    `Aktiviert: ${enabled}\n` +
                    `Intervall: ${status.config.intervalMinutes} Minuten\n` +
                    `Quiet Hours: ${quietStr}\n` +
                    `Letzter Check: ${lastCheck}\n` +
                    `Notifications/Stunde: ${status.notificationsThisHour}/${status.config.maxNotificationsPerHour}\n` +
                    `\n*Aktive Checks:*\n` +
                    `${status.config.checks.health ? '✅' : '❌'} System Health\n` +
                    `${status.config.checks.reminders ? '✅' : '❌'} Erinnerungen\n` +
                    `${status.config.checks.inbound ? '✅' : '❌'} Inbound Folders\n` +
                    `${status.config.checks.logs ? '✅' : '❌'} Error Logs\n` +
                    `${status.config.checks.uptime ? '✅' : '❌'} Uptime\n` +
                    `\n_Befehle: /autonomy on|off|trigger • /quiet on|off|22 8_`
            } catch (err) {
                return `❌ Autonomy Loop nicht verfügbar: ${err}`
            }
        }

        // ============================================
        // Quiet Hours (Ruhezeiten für autonome Nachrichten)
        // ============================================
        case 'quiet':
        case 'ruhe':
        case 'stille': {
            try {
                const { updateAutonomyConfig, getAutonomyStatus } = await import('./autonomy-loop.js')
                const argLower = args.trim().toLowerCase()

                if (argLower === 'on' || argLower === 'an') {
                    updateAutonomyConfig({ quietHoursStart: 23, quietHoursEnd: 7 })
                    return `🌙 *Quiet Hours: ✅ AKTIVIERT*\n\nNova ist ruhig von *23:00 - 07:00*\nKeine autonomen Nachrichten in dieser Zeit.\n\n_Anpassen: /quiet 22 8_\n_Deaktivieren: /quiet off_`
                }

                if (argLower === 'off' || argLower === 'aus') {
                    updateAutonomyConfig({ quietHoursStart: -1, quietHoursEnd: -1 })
                    return `🌙 *Quiet Hours: ❌ DEAKTIVIERT*\n\nNova kann dich jetzt rund um die Uhr kontaktieren.\n\n_Aktivieren: /quiet on_`
                }

                if (argLower === 'notfall' || argLower === 'emergency' || argLower === 'critical') {
                    // Quiet hours on, but max notifications set very low (only critical)
                    updateAutonomyConfig({ quietHoursStart: 0, quietHoursEnd: 23, maxNotificationsPerHour: 1 })
                    return `🚨 *Nur-Notfall Modus: ✅ AKTIVIERT*\n\nNova meldet sich nur bei *kritischen* Problemen (max 1x/Stunde).\n\n_Normal: /quiet off_\n_Quiet Hours: /quiet on_`
                }

                // Parse "22 8" or "22-8" or "22:00 8:00"
                const timeMatch = argLower.match(/(\d{1,2})\s*[-:\s]\s*(\d{1,2})/)
                if (timeMatch) {
                    const start = parseInt(timeMatch[1])
                    const end = parseInt(timeMatch[2])
                    if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
                        updateAutonomyConfig({ quietHoursStart: start, quietHoursEnd: end })
                        return `🌙 *Quiet Hours angepasst!*\n\nRuhig von *${start}:00 - ${end}:00*\n\n_Deaktivieren: /quiet off_`
                    }
                    return `❌ Ungültige Zeiten. Bitte 0-23 verwenden.\n\n_Beispiel: /quiet 22 8_`
                }

                // Default: show status
                const status = getAutonomyStatus()
                const quietActive = status.config.quietHoursStart >= 0
                const nowHour = new Date().getHours()
                let inQuietNow = false
                if (quietActive) {
                    inQuietNow = status.config.quietHoursStart > status.config.quietHoursEnd
                        ? (nowHour >= status.config.quietHoursStart || nowHour < status.config.quietHoursEnd)
                        : (nowHour >= status.config.quietHoursStart && nowHour < status.config.quietHoursEnd)
                }

                return `🌙 *Quiet Hours Status*\n\n` +
                    `Aktiviert: ${quietActive ? '✅ Ja' : '❌ Nein'}\n` +
                    `${quietActive ? `Zeitraum: ${status.config.quietHoursStart}:00 - ${status.config.quietHoursEnd}:00\n` : ''}` +
                    `Gerade aktiv: ${inQuietNow ? '🌙 Ja (Ruhezeit)' : '☀️ Nein'}\n` +
                    `Max Notifications/h: ${status.config.maxNotificationsPerHour}\n` +
                    `\n*Befehle:*\n` +
                    `/quiet on — Ruhezeiten an (23-07)\n` +
                    `/quiet off — Ruhezeiten aus (24/7)\n` +
                    `/quiet 22 8 — Zeiten anpassen\n` +
                    `/quiet notfall — Nur kritische Meldungen`
            } catch (err) {
                return `❌ Quiet Hours nicht verfügbar: ${err}`
            }
        }

        // ============================================
        // Pre-Flight Checks
        // ============================================
        case 'preflight':
        {
            try {
                const { runLocalPreFlight, runRemotePreFlight, formatPreFlightResult } = await import('./preflight-checks.js')
                const target = args.trim().toLowerCase()

                if (!target || target === 'local' || target === 'localhost') {
                    const result = await runLocalPreFlight()
                    return formatPreFlightResult(result)
                }

                // Resolve host from known hosts
                const hostsPath = join(process.cwd(), '.nova-data', 'hosts.json')
                let ip = target
                let user = 'xaventra'
                let port = 22
                try {
                    if (existsSync(hostsPath)) {
                        const hosts = JSON.parse(readFileSync(hostsPath, 'utf-8'))
                        const match = hosts.find((h: any) =>
                            h.name?.toLowerCase() === target ||
                            h.hostname?.toLowerCase() === target ||
                            h.ip === target
                        )
                        if (match) {
                            ip = match.ip || match.hostname
                            user = match.user || user
                            port = match.port || port
                        }
                    }
                } catch { /* no hosts file */ }

                const result = await runRemotePreFlight(ip, user, port)
                return formatPreFlightResult(result)
            } catch (err: any) {
                return `❌ Pre-Flight Check fehlgeschlagen: ${err?.message || err}`
            }
        }

        // ============================================
        // Autonomous Mission Engine
        // ============================================
        case 'mission':
        case 'auftrag': {
            try {
                const { startMission, cancelMission, pauseMission, resumeMission, getMissionStatus, getMissionHistory, formatMissionConfig, updateMissionConfig } = await import('./autonomous-executor.js')
                const subCmd = args.split(' ')[0]?.toLowerCase() || ''
                switch (subCmd) {
                    case 'stop':
                    case 'cancel':
                    case 'abbruch':
                        return cancelMission()
                    case 'pause':
                        return pauseMission()
                    case 'resume':
                    case 'weiter':
                        return resumeMission()
                    case 'status':
                    case '':
                        return getMissionStatus()
                    case 'history':
                    case 'historie':
                        return getMissionHistory()
                    case 'config':
                    case 'settings': {
                        const configArgs = args.split(' ').slice(1)
                        if (configArgs.length < 2) return formatMissionConfig()
                        const key = configArgs[0].toLowerCase()
                        const val = parseInt(configArgs[1])
                        if (isNaN(val) || val < 0) return '❌ Wert muss eine positive Zahl sein.'
                        const keyMap: Record<string, string> = {
                            continuations: 'maxContinuations',
                            cont: 'maxContinuations',
                            steps: 'maxSteps',
                            retries: 'maxRetries',
                            timeout: 'timeoutPerStep',
                            delay: 'delayBetweenSteps',
                            notify: 'notifyEveryNSteps',
                        }
                        const configKey = keyMap[key]
                        if (!configKey) return `❌ Unbekannter Key: ${key}\n\nVerfügbar: ${Object.keys(keyMap).join(', ')}`
                        // Convert seconds to ms for timeout/delay
                        const actualVal = (configKey === 'timeoutPerStep' || configKey === 'delayBetweenSteps') ? val * 1000 : val
                        updateMissionConfig({ [configKey]: actualVal })
                        return `✅ ${key} = **${val}**${(configKey === 'timeoutPerStep' || configKey === 'delayBetweenSteps') ? 's' : ''}\n\n` + formatMissionConfig()
                    }
                    default: {
                        const fullGoal = args.trim()
                        if (!fullGoal) return getMissionStatus()
                        const mission = await startMission(fullGoal, from, 'telegram')
                        return '🚀 Mission gestartet! ' + mission.steps.length + ' Schritte werden autonom abgearbeitet.\n\nZiel: ' + fullGoal.slice(0, 150) + '\n\nKontrolle: /mission status | /mission stop | /mission pause | /mission config'
                    }
                }
            } catch (err: any) {
                return '❌ Mission-Fehler: ' + (err?.message || err)
            }
        }

        // ================================================
        // /ai — Redirect to /mesh (consolidated)
        // ================================================
        case 'ai': {
            const aiSub = args.trim().split(/\s+/)[0]?.toLowerCase() || ''
            if (aiSub === 'scan') {
                return handleCommand('mesh', 'scan', from, state, availableLLMs, principalContext)
            }
            return `ℹ️ /ai wurde zu /mesh zusammengeführt.

Nutze:
\`/mesh scan\` — AI Services scannen
\`/mesh route\` — Routing-Diagnostik
\`/mesh\` — Alle Nodes anzeigen`
        }





        // ================================================
        // /update — Auto-Updater
        // ================================================
        case 'update': {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || 'status'

            switch (sub) {
                case 'status': {
                    try {
                        const { getUpdateStatus } = await import('../core/auto-updater.js')
                        const status = getUpdateStatus()
                        return `📦 **Nova Update Status**

🔖 Version: v${status.currentVersion}
📅 Letzter Check: ${status.lastCheck || 'nie'}
📦 Letztes Update: ${status.lastUpdate || 'nie'}
🔏 Release: ${status.currentRelease || 'noch keines veröffentlicht'}
📋 Pending: ${status.pendingUpdate ? 'Ja' : 'Nein'}
🚦 Rollout: ${status.running ? 'läuft' : 'idle'}
${status.receipts.slice(-5).map(receipt => `${receipt.status === 'verified' ? '✅' : receipt.status === 'rolled_back' ? '↩️' : '❌'} ${receipt.node}: ${receipt.status}`).join('\n')}`
                    } catch (err: any) {
                        return `❌ Update-Status: ${err?.message || err}`
                    }
                }
                case 'deploy': {
                    if (requestPermission !== 'owner' && requestPermission !== 'admin') return '🔒 Nur Owner/Admin dürfen den signierten Rollout starten.'
                    try {
                        const { deployUpdateToAllNodes } = await import('../core/auto-updater.js')
                        const configPath = resolveConfigPath()
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
                        const updateConfig = config.mesh?.update
                        const nodes = updateConfig?.nodes || []
                        if (!updateConfig?.enabled || nodes.length === 0) return '❌ Keine sicheren Update-Profile unter mesh.update.nodes konfiguriert.'

                        void deployUpdateToAllNodes(
                            updateConfig,
                            (msg) => console.log(`[AutoUpdate] ${msg}`)
                        )
                        return `🔄 **Signierter Canary-Rollout gestartet** für ${nodes.length} Nodes.\n\nStatus: /update status`
                    } catch (err: any) {
                        return `❌ Deploy-Fehler: ${err?.message || err}`
                    }
                }
                default:
                    return `📦 **Nova Auto-Updater**

/update status — Aktuelle Version und Update-Info
/update deploy — Tests + signierter Canary-Rollout + Healthcheck/Rollback`
            }
        }

        case 'heartbeat': {
            try {
                const { handleHeartbeatCommand } = await import('./heartbeat.js')
                return handleHeartbeatCommand(args)
            } catch (err) {
                return `❌ Heartbeat module not available: ${err}`
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // SELF-SETUP  /setup [plan|apply <id>|status]
        // ─────────────────────────────────────────────────────────────────
        case 'setup': {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || 'status'
            const rest2 = args.trim().split(/\s+/).slice(1)

            switch (sub) {
                case 'status': {
                    const { formatSelfSetupStatus } = await import('../core/self-setup-orchestrator.js')
                    return formatSelfSetupStatus()
                }
                case 'plan': {
                    const { runSelfSetupScan, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
                    const st = await runSelfSetupScan()
                    return formatSelfSetupPlan(st)
                }
                case 'research': {
                    const capArg = rest2[0] || ''
                    const forceArg = rest2.includes('--force')

                    if (capArg && capArg !== 'all' && !capArg.startsWith('--')) {
                        // Single capability - full research loop, persisted into setup-state.json
                        const { runSelfSetupResearch, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
                        const state = await runSelfSetupResearch({ force: forceArg, capabilities: [capArg], timeoutMs: 90_000 })
                        return formatSelfSetupPlan(state)
                    } else {
                        // All missing → full research loop → enriches setup-state.json
                        const { runSelfSetupResearch, formatSelfSetupPlan } = await import('../core/self-setup-orchestrator.js')
                        const state = await runSelfSetupResearch({ force: forceArg })
                        return formatSelfSetupPlan(state)
                    }
                }

                case 'apply': {
                    const actionIdArg = rest2[0]
                    if (!actionIdArg) return '❌ Usage: /setup apply <actionId|all>'
                    const { applySelfSetupAction, applySelfSetupPlan, loadSelfSetupState } = await import('../core/self-setup-orchestrator.js')
                    if (actionIdArg === 'all') {
                        const st2 = loadSelfSetupState()
                        if (!st2) return '❌ Kein Setup-Plan. Erst /setup plan ausführen.'
                        const confirmStr = st2.mode === 'yolo' ? '' : `APPLY_ALL:${st2.generatedAt}`
                        const res = await applySelfSetupPlan(confirmStr)
                        return `${res.success ? '✅' : '⚠️'} ${res.message}\nApplied: ${res.applied.join(', ') || '–'}\nFailed: ${res.failed.join(', ') || '–'}`
                    }
                    const st2 = loadSelfSetupState()
                    const confirmStr = st2?.mode === 'yolo' ? '' : `APPLY:${actionIdArg}`
                    const res = await applySelfSetupAction(actionIdArg, confirmStr)
                    return `${res.success ? '✅' : '❌'} ${res.message}`
                }
                default:
                    return `🔧 **Nova Self-Setup**

/setup status — Letzten Scan-Zustand anzeigen
/setup plan — Frischen Scan + Plan generieren
/setup research — Alle fehlenden Capabilities via Websuche recherchieren
/setup research <cap> — Einzelne Capability recherchieren (stt/tts/llm/embedding/vision/ffmpeg)
/setup apply <id> — Einzelne Aktion ausführen
/setup apply all — Alle Aktionen im YOLO-Modus ausführen`
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // PATCH MANAGEMENT  /patches | /patch list | /patch approve <id>
        // ─────────────────────────────────────────────────────────────────
        case 'patches':
        case 'patch': {
            if (requestPermission !== 'owner') return 'PATCH_GATE-Verwaltung benötigt owner.'
            const { getPatchProposals } = await import('../synthesis/self-evolution.js')
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || 'list'
            const rest = args.trim().split(/\s+/).slice(1)

            switch (sub) {
                case 'list':
                case '': {
                    const proposals = getPatchProposals(20)
                    if (!proposals.length) return '✅ Keine Patch-Vorschläge vorhanden.'

                    const queued = proposals.filter((p: any) => p.status === 'queued')
                    const lines = proposals.map((p: any, i: number) => {
                        const age = Math.floor((Date.now() - p.createdAt) / 60_000)
                        const statusIcon = p.status === 'queued' ? '🟡' : p.status === 'applied' ? '✅' : '❌'
                        const statusLabel = p.status === 'queued' ? 'ausstehend' : p.status === 'applied' ? 'angewendet' : p.status
                        return `${statusIcon} [${i + 1}] \`${p.id}\` (${statusLabel})\n` +
                            `   📁 ${p.file}\n` +
                            `   💬 ${p.description}\n` +
                            (p.reason ? `   💡 ${p.reason}\n` : '') +
                            `   🕐 vor ${age}min`
                    }).join('\n\n')

                    const header = `🧬 **Patch-Vorschläge** (gesamt: ${proposals.length}, ausstehend: ${queued.length})\n\n${lines}`

                    // Send each queued proposal as a button message via Telegram
                    if (queued.length && from) {
                        try {
                            const { getTelegramAdapter } = await import('../channels/telegram.js')
                            const tg = getTelegramAdapter()
                            if (tg) {
                                // Send summary first
                                await tg.sendWithButtons(from, header, [])
                                // Then one button row per queued proposal
                                for (const p of queued) {
                                    const age = Math.floor((Date.now() - p.createdAt) / 60_000)
                                    const msgText =
                                        `🟡 *Ausstehend:* \`${p.id}\`\n` +
                                        `📁 ${p.file}\n` +
                                        `💬 ${p.description}\n` +
                                        (p.reason ? `💡 ${p.reason}\n` : '') +
                                        `🕐 vor ${age}min`
                                    await tg.sendWithButtons(from, msgText, [
                                        [
                                            { text: '✅ Patch anwenden', callback_data: `patch_ok:${p.id}` },
                                            { text: '❌ Ablehnen', callback_data: `patch_no:${p.id}` },
                                        ],
                                    ])
                                }
                                return '__HANDLED__'
                            }
                        } catch { /* fallback below */ }
                    }

                    const footer = queued.length
                        ? `\n\nApprove: /patch approve <id>\nAblehnen: /patch reject <id>`
                        : ''
                    return `${header}${footer}`
                }

                case 'approve': {
                    const proposalId = rest[0]
                    if (!proposalId) return '❌ Usage: /patch approve <proposalId>'

                    const token = process.env.NOVA_PATCH_GATE_TOKEN
                    if (!token) return '❌ `NOVA_PATCH_GATE_TOKEN` ist nicht gesetzt. Bitte in .env eintragen.'

                    const proposals = getPatchProposals(200)
                    const proposal = proposals.find((p: any) => p.id === proposalId)
                    const patchPermission = requestPermission
                    if (patchPermission !== 'owner') return 'PATCH_GATE-Freigaben benÃ¶tigen owner.'
                    if (!proposal) return `❌ Proposal nicht gefunden: \`${proposalId}\``
                    if (proposal.status !== 'queued') return `⚠️ Proposal ist bereits: ${proposal.status}`

                    try {
                        if (proposal.kind === 'doctor-config') {
                            const { applyApprovedDoctorProposal } = await import('../doctor/safe-fixes.js')
                            const doctorResult = await applyApprovedDoctorProposal(proposal, token)
                            if (!doctorResult.applied) return `Doctor-Patch fehlgeschlagen: ${doctorResult.message}`
                            const { readFileSync, writeFileSync } = await import('node:fs')
                            const pPath = join(process.cwd(), '.nova-data', 'patch-proposals.json')
                            const all = JSON.parse(readFileSync(pPath, 'utf-8'))
                            const idx = all.findIndex((p: any) => p.id === proposalId)
                            if (idx >= 0) { all[idx].status = 'applied'; all[idx].appliedAt = Date.now() }
                            writeFileSync(pPath, JSON.stringify(all, null, 2))
                            return `Doctor-Config-Patch angewendet: ${doctorResult.message}. Neustart erforderlich.`
                        }
                        const { evolve } = await import('../synthesis/self-evolution.js')
                        const result = await evolve({
                            file: proposal.file,
                            description: proposal.description,
                            search: proposal.search,
                            replace: proposal.replace,
                            reason: proposal.reason,
                            apply: true,
                            approvalToken: token,
                        })

                        if (result.success) {
                            // Mark as applied in proposals file
                            try {
                                const { readFileSync, writeFileSync } = await import('node:fs')
                                const pPath = join(process.cwd(), '.nova-data', 'patch-proposals.json')
                                const all = JSON.parse(readFileSync(pPath, 'utf-8'))
                                const idx = all.findIndex((p: any) => p.id === proposalId)
                                if (idx >= 0) { all[idx].status = 'applied'; all[idx].appliedAt = Date.now() }
                                writeFileSync(pPath, JSON.stringify(all, null, 2))
                            } catch { /* non-critical */ }

                            return `✅ **Patch erfolgreich angewendet!**\n\n` +
                                `🌿 Branch: \`${result.branch}\`\n` +
                                `⏱️ Dauer: ${result.duration}ms\n` +
                                `🔄 Nova wird in ~3s neu gestartet...`
                        } else {
                            return `❌ **Patch fehlgeschlagen**\n\n${result.error || 'Unbekannter Fehler'}\n` +
                                (result.rollbackPerformed ? '↩️ Rollback durchgeführt.' : '')
                        }
                    } catch (err: any) {
                        return `❌ Fehler beim Anwenden: ${err?.message || err}`
                    }
                }

                case 'reject': {
                    const proposalId = rest[0]
                    if (!proposalId) return '❌ Usage: /patch reject <proposalId>'

                    try {
                        const { readFileSync, writeFileSync } = await import('node:fs')
                        const pPath = join(process.cwd(), '.nova-data', 'patch-proposals.json')
                        if (!existsSync(pPath)) return '❌ Keine Proposals-Datei gefunden.'
                        const all = JSON.parse(readFileSync(pPath, 'utf-8'))
                        const idx = all.findIndex((p: any) => p.id === proposalId)
                        if (idx < 0) return `❌ Proposal nicht gefunden: \`${proposalId}\``
                        if (all[idx].status !== 'queued') return `⚠️ Proposal ist bereits: ${all[idx].status}`
                        all[idx].status = 'rejected'
                        all[idx].rejectedAt = Date.now()
                        writeFileSync(pPath, JSON.stringify(all, null, 2))
                        return `🗑️ Proposal \`${proposalId}\` abgelehnt.`
                    } catch (err: any) {
                        return `❌ Fehler: ${err?.message || err}`
                    }
                }

                case 'history': {
                    try {
                        const { getEvolutionHistory, getEvolutionStats } = await import('../synthesis/self-evolution.js')
                        const stats = getEvolutionStats()
                        const history = getEvolutionHistory(10)
                        const lines = history.map((h: any) => {
                            const d = new Date(h.timestamp).toLocaleString('de-AT')
                            const icon = h.result.success ? '✅' : '❌'
                            return `${icon} ${d}\n   ${h.request.description}\n   ${h.request.file}`
                        }).join('\n\n')

                        return `🧬 **Evolution History**\n\n` +
                            `📊 Total: ${stats.total} | ✅ ${stats.successful} | ❌ ${stats.failed}\n` +
                            `🕐 Letzte: ${stats.lastEvolution || 'nie'}\n\n` +
                            (lines || 'Keine History.')
                    } catch (err: any) {
                        return `❌ History-Fehler: ${err?.message || err}`
                    }
                }

                default:
                    return `🧬 **Nova Patch-Verwaltung**

/patches — Ausstehende Vorschläge anzeigen
/patch list — Alle Vorschläge
/patch approve <id> — Patch freigeben & anwenden
/patch reject <id> — Patch ablehnen
/patch history — Angewandte Patches`
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // BROWSER  /browser [status|close|search <query>]
        // ─────────────────────────────────────────────────────────────────
        case 'browser': {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() || 'status'
            const bArgs = args.trim().split(/\s+/).slice(1).join(' ')

            switch (sub) {
                case 'status': {
                    try {
                        const { browserUseTools } = await import('../tools/browser-use.js')
                        const statusTool = browserUseTools.find(t => t.name === 'browser_status')
                        if (statusTool) {
                            const result = await statusTool.handler({}) as any
                            if (!result.running) return `🌐 **Browser** — nicht aktiv\n_browser_open aufrufen zum Starten_`
                            return `🌐 **Browser** — aktiv\n📍 ${result.url}\n📄 ${result.title || '—'}`
                        }
                        return '❌ browser_status nicht verfügbar'
                    } catch (err: any) {
                        return `❌ ${err?.message || err}`
                    }
                }

                case 'close': {
                    try {
                        const { browserUseTools } = await import('../tools/browser-use.js')
                        const closeTool = browserUseTools.find(t => t.name === 'browser_close')
                        if (closeTool) {
                            await closeTool.handler({})
                            return '🌐 Browser geschlossen.'
                        }
                        return '❌ browser_close nicht verfügbar'
                    } catch (err: any) {
                        return `❌ ${err?.message || err}`
                    }
                }

                case 'search': {
                    if (!bArgs) return '❌ Usage: /browser search <Suchanfrage>'
                    try {
                        const { browserUseTools } = await import('../tools/browser-use.js')
                        const searchTool = browserUseTools.find(t => t.name === 'browser_search')
                        if (!searchTool) return '❌ browser_search nicht verfügbar'
                        const result = await searchTool.handler({ query: bArgs, count: 5 }) as any
                        if (result.error) return `❌ Suche fehlgeschlagen: ${result.error}`
                        if (!result.results?.length) return `🔍 Keine Ergebnisse für: _${bArgs}_`
                        const lines = result.results.map((r: any, i: number) =>
                            `${i + 1}. **${r.title}**\n   ${r.url}${r.snippet ? '\n   ' + r.snippet.slice(0, 100) : ''}`
                        ).join('\n\n')
                        return `🔍 **Suche:** _${bArgs}_\n\n${lines}`
                    } catch (err: any) {
                        return `❌ ${err?.message || err}`
                    }
                }

                default:
                    return `🌐 **Browser Tools**

/browser status — Session-Status
/browser search <query> — Web-Suche via DuckDuckGo
/browser close — Browser schließen

Nova kann den Browser auch direkt nutzen:
• browser_open(url) — Seite öffnen
• browser_search(query) — Suchen
• browser_click(selector) — Klicken
• browser_type(selector, text) — Text eingeben
• browser_extract() — Text extrahieren
• browser_screenshot() — Screenshot`
            }
        }

        // ============================================
        // Home Assistant
        // ============================================
        case 'hass':
        case 'ha':
        case 'homeassistant': {
            try {
                const { handleHassCommand } = await import('../tools/homeassistant.js')
                return await handleHassCommand(args)
            } catch (err) {
                return `❌ Home Assistant Fehler: ${err}`
            }
        }

        // ============================================
        // 3D Printer (Moonraker/Klipper)
        // ============================================
        case 'printer':
        case 'drucker':
        case 'print': {
            try {
                const { handlePrinterCommand } = await import('../tools/3dprinter.js')
                return await handlePrinterCommand(args)
            } catch (err) {
                return `❌ Drucker-Fehler: ${err}`
            }
        }

        // ============================================
        // Replan Engine Stats
        // ============================================
        case 'replan': {
            try {
                const { formatReplanStatus, getReplanHistory } = await import('../intelligence/replan-engine.js')
                if (args.trim() === 'history') {
                    const history = getReplanHistory(10)
                    if (history.length === 0) return '📋 Keine Replan-History vorhanden.'
                    return history.map(r =>
                        `${r.success ? '✅' : '❌'} [${r.taskId}] Versuch ${r.attemptNumber}: ${r.error.slice(0, 80)}`
                    ).join('\n')
                }
                return formatReplanStatus()
            } catch (err) {
                return `❌ Replan-Fehler: ${err}`
            }
        }

    }

    // Unknown command — DO NOT fall through to LLM
    return `❓ Unbekannter Befehl: /${cmd}

Tippe /help oder /befehle für alle verfügbaren Befehle.`
}
