/**
 * Xaventra Dashboard - Frontend JavaScript
 */

// WebSocket connection
let ws = null
let reconnectAttempts = 0

// State
const state = {
    nova: { status: 'idle', currentTask: '', lastMessage: '', uptime: 0 },
    stats: { tokensToday: 0, costToday: 0, requestsToday: 0 },
    chatMessages: []
}

// ============================================
// DOM Elements
// ============================================

const elements = {
    novaStatus: document.getElementById('nova-status'),
    uptime: document.getElementById('uptime'),
    tokensToday: document.getElementById('tokens-today'),
    costToday: document.getElementById('cost-today'),
    requestsToday: document.getElementById('requests-today'),
    repairsCount: document.getElementById('repairs-count'),
    currentTask: document.getElementById('current-task'),
    lastMessage: document.getElementById('last-message'),
    agentsList: document.getElementById('agents-list'),
    sessionsList: document.getElementById('sessions-list'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    chatSend: document.getElementById('chat-send'),
    typingIndicator: document.getElementById('typing-indicator'),
    memoryList: document.getElementById('memory-list'),
    memorySearch: document.getElementById('memory-search'),
    proposalsList: document.getElementById('proposals-list'),
    configEditor: document.getElementById('config-editor'),
    layersGrid: document.getElementById('layers-grid'),
    toolsList: document.getElementById('tools-list'),
    errorsList: document.getElementById('errors-list'),
    watchdogStatus: document.getElementById('watchdog-status')
}

// ============================================
// WebSocket
// ============================================

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${protocol}//${window.location.host}`)

    ws.onopen = () => {
        console.log('WebSocket connected')
        reconnectAttempts = 0
        updateConnectionStatus(true)

        // Client-side keepalive — send ping every 25s to prevent idle timeout
        if (window._wsKeepalive) clearInterval(window._wsKeepalive)
        window._wsKeepalive = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }))
            }
        }, 25_000)
    }

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data)
            handleWebSocketMessage(msg)
        } catch (err) {
            console.error('WebSocket message error:', err)
        }
    }

    ws.onclose = () => {
        console.log('WebSocket disconnected')
        updateConnectionStatus(false)
        if (window._wsKeepalive) clearInterval(window._wsKeepalive)

        // Always reconnect with exponential backoff (no cap on attempts)
        reconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
        console.log(`WebSocket reconnecting in ${delay}ms (attempt ${reconnectAttempts})`)
        setTimeout(connectWebSocket, delay)
    }

    ws.onerror = (err) => {
        console.error('WebSocket error:', err)
    }
}

function handleWebSocketMessage(msg) {
    switch (msg.type) {
        case 'state':
            updateFullState(msg.data)
            break
        case 'nova':
            updateNovaStatus(msg.data)
            break
        case 'stats':
            updateStats(msg.data)
            break
        case 'chat':
            state.chatMessages = msg.data
            renderChatMessages()
            break
        case 'chat_message':
            state.chatMessages.push(msg.data)
            renderChatMessages()
            break
        case 'typing':
            elements.typingIndicator.style.display = msg.data.typing ? 'flex' : 'none'
            break
        case 'chat_error':
            console.error('Chat error:', msg.data.error)
            break
        case 'thought':
            // New thought added
            loadMemory()
            break
        case 'error':
            loadErrors()
            break
    }
}

function updateConnectionStatus(connected) {
    const dot = elements.watchdogStatus.querySelector('.status-dot')
    const text = elements.watchdogStatus.querySelector('span:last-child')

    if (connected) {
        dot.className = 'status-dot healthy'
        text.textContent = 'Connected'
    } else {
        dot.className = 'status-dot error'
        text.textContent = 'Disconnected'
    }
}

// ============================================
// State Updates
// ============================================

function updateFullState(data) {
    if (data.nova) updateNovaStatus(data.nova)
    if (data.stats) updateStats(data.stats)
    if (data.l0) updateL0Stats(data.l0)
    if (data.agents) renderAgents(data.agents)
    if (data.thoughts) renderThoughts(data.thoughts)
}

function updateNovaStatus(nova) {
    state.nova = { ...state.nova, ...nova }

    const indicator = elements.novaStatus.querySelector('.status-indicator')
    const text = elements.novaStatus.querySelector('.status-text')

    indicator.className = `status-indicator ${nova.status}`
    text.textContent = nova.status.charAt(0).toUpperCase() + nova.status.slice(1)

    if (nova.currentTask) {
        elements.currentTask.textContent = nova.currentTask
    }

    if (nova.lastMessage) {
        elements.lastMessage.textContent = nova.lastMessage
    }

    if (nova.uptime) {
        updateUptime(nova.uptime)
    }
}

function updateStats(stats) {
    state.stats = { ...state.stats, ...stats }

    elements.tokensToday.textContent = formatNumber(stats.tokensToday || 0)
    elements.costToday.textContent = `$${(stats.costToday || 0).toFixed(4)}`
    elements.requestsToday.textContent = formatNumber(stats.requestsToday || 0)
}

function updateL0Stats(l0) {
    elements.repairsCount.textContent = l0.successfulRepairs || 0
}

function updateUptime(startTime) {
    const now = Date.now()
    const diff = now - startTime
    const hours = Math.floor(diff / 3600000)
    const minutes = Math.floor((diff % 3600000) / 60000)
    elements.uptime.textContent = `Uptime: ${hours}h ${minutes}m`
}

// ============================================
// Renderers
// ============================================

function renderAgents(agents) {
    if (!agents || agents.length === 0) {
        elements.agentsList.innerHTML = '<div class="empty-state">No active agents</div>'
        return
    }

    elements.agentsList.innerHTML = agents.map(agent => `
        <div class="list-item">
            <div>
                <div class="list-item-title">${escapeHtml(agent.query.slice(0, 50))}...</div>
                <div class="list-item-meta">ID: ${agent.id}</div>
            </div>
            <span class="tag">${agent.status}</span>
        </div>
    `).join('')
}

function renderThoughts(thoughts) {
    if (!thoughts || thoughts.length === 0) {
        elements.memoryList.innerHTML = '<div class="empty-state">No memories stored</div>'
        return
    }

    elements.memoryList.innerHTML = thoughts.map(t => `
        <div class="list-item">
            <div>
                <div class="list-item-title">${escapeHtml(t.content.slice(0, 80))}${t.content.length > 80 ? '...' : ''}</div>
                <div class="list-item-meta">${t.type || 'thought'} • ${formatTime(t.timestamp)}</div>
            </div>
        </div>
    `).join('')
}

function renderChatMessages() {
    const welcome = elements.chatMessages.querySelector('.chat-welcome')

    if (state.chatMessages.length === 0) {
        if (!welcome) {
            elements.chatMessages.innerHTML = `
                <div class="chat-welcome">
                    <span class="welcome-icon">✨</span>
                    <h2>Chat with Xaventra</h2>
                    <p>Send a message to start a conversation</p>
                </div>
            `
        }
        return
    }

    elements.chatMessages.innerHTML = state.chatMessages.map(msg => `
        <div class="chat-message ${msg.role}">
            ${escapeHtml(msg.content)}
        </div>
    `).join('')

    // Scroll to bottom
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight
}

function renderProposals(proposals) {
    const pending = proposals.filter(p => p.status === 'pending')

    if (pending.length === 0) {
        elements.proposalsList.innerHTML = '<div class="empty-state">No pending proposals</div>'
        return
    }

    elements.proposalsList.innerHTML = pending.map(p => `
        <div class="proposal-card">
            <div class="proposal-header">
                <span class="proposal-type ${p.type}">${p.type}</span>
                <span class="proposal-confidence">${p.confidence}% confidence</span>
            </div>
            <div class="proposal-description">${escapeHtml(p.description)}</div>
            <div class="proposal-file">${escapeHtml(p.file)}</div>
            <div class="proposal-actions">
                <button class="btn-approve" onclick="approveProposal('${p.id}')">Approve</button>
                <button class="btn-reject" onclick="rejectProposal('${p.id}')">Reject</button>
            </div>
        </div>
    `).join('')
}

function renderConfig(config) {
    if (!config || Object.keys(config).length === 0) return

    // Populate form fields
    const setVal = (id, val) => {
        const el = document.getElementById(id)
        if (el && val !== undefined && val !== null) {
            if (el.tagName === 'SELECT') {
                el.value = String(val)
            } else {
                el.value = typeof val === 'string' ? val : JSON.stringify(val)
            }
        }
    }

    setVal('cfg-provider', config.provider)
    setVal('cfg-model', config.model)
    setVal('cfg-internal-model', config.internalModel)
    setVal('cfg-personality', config.personality)

    // Telegram — read from nested channels.telegram
    const tg = config.channels?.telegram || {}
    if (tg.token && !String(tg.token).includes('***')) {
        setVal('cfg-telegram-token', tg.token)
    }
    setVal('cfg-telegram-enabled', String(tg.enabled !== false))
    // Also populate user ID from allowFrom
    if (tg.allowFrom && tg.allowFrom.length > 0) {
        setVal('cfg-telegram-userid', tg.allowFrom.join(','))
    }

    // Raw config display
    const rawEl = document.getElementById('config-raw')
    if (rawEl) {
        rawEl.textContent = JSON.stringify(config, null, 2)
    }
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config')
        const data = await res.json()
        renderConfig(data)
    } catch (err) {
        console.error('Failed to load config:', err)
    }
}

async function saveConfig(section) {
    const body = {}

    switch (section) {
        case 'llm':
            body.provider = document.getElementById('cfg-provider')?.value
            body.model = document.getElementById('cfg-model')?.value
            body.internalModel = document.getElementById('cfg-internal-model')?.value
            break
        case 'telegram': {
            const token = document.getElementById('cfg-telegram-token')?.value
            const userId = document.getElementById('cfg-telegram-userid')?.value
            const enabled = document.getElementById('cfg-telegram-enabled')?.value === 'true'
            const allowFrom = userId ? userId.split(',').map(s => s.trim()).filter(Boolean) : []
            body.channels = {
                telegram: {
                    enabled,
                    ...(token ? { token } : {}),
                    allowFrom,
                }
            }
            break
        }
        case 'personality':
            body.personality = document.getElementById('cfg-personality')?.value
            break
    }

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        const data = await res.json()

        if (data.success) {
            // Refresh display
            await loadConfig()
            alert(`✅ ${section} config gespeichert! Neustart nötig für Änderungen.`)
        } else {
            alert('❌ Speichern fehlgeschlagen')
        }
    } catch (err) {
        alert(`❌ Fehler: ${err}`)
    }
}

function renderLayers(layers) {
    if (!layers || Object.keys(layers).length === 0) {
        elements.layersGrid.innerHTML = '<div class="empty-state">No layers found</div>'
        return
    }

    elements.layersGrid.innerHTML = Object.entries(layers).map(([name, info]) => `
        <div class="layer-card">
            <div class="layer-name">${escapeHtml(name)}</div>
            <div class="layer-status">${info.active ? '✅ Active' : '❌ Inactive'}</div>
        </div>
    `).join('')
}

function renderTools(tools) {
    if (!tools || tools.length === 0) {
        elements.toolsList.innerHTML = '<div class="empty-state">No tools found</div>'
        return
    }

    elements.toolsList.innerHTML = tools.map(tool => `
        <span class="tool-tag">${escapeHtml(tool.replace(/\.(ts|js)$/, ''))}</span>
    `).join('')
}

function renderErrors(errors) {
    if (!errors || errors.length === 0) {
        elements.errorsList.innerHTML = '<div class="empty-state">No errors logged</div>'
        return
    }

    elements.errorsList.innerHTML = errors.map(err => `
        <div class="error-item">
            <div class="error-message">${escapeHtml(err.message)}</div>
            ${err.stack ? `<pre class="error-stack">${escapeHtml(err.stack)}</pre>` : ''}
            <div class="error-time">${formatTime(err.timestamp)}</div>
        </div>
    `).join('')
}

function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
        elements.sessionsList.innerHTML = '<div class="empty-state">No sessions found</div>'
        return
    }

    elements.sessionsList.innerHTML = sessions.map(s => `
        <div class="list-item session-item" onclick="resumeSession('${escapeHtml(s.id)}')" title="Click to resume this session">
            <div>
                <div class="list-item-title">${escapeHtml(s.channel || 'Unknown')} - ${s.userId || 'Unknown'}</div>
                <div class="list-item-meta">${s.messageCount} messages • ${formatTime(s.updatedAt)}</div>
            </div>
            <div class="session-resume-icon">▶</div>
        </div>
    `).join('')
}

async function resumeSession(sessionId) {
    try {
        // Show loading state
        const items = document.querySelectorAll('.session-item')
        items.forEach(el => el.classList.remove('active'))

        const res = await fetch(`/api/sessions/${sessionId}/resume`, { method: 'POST' })
        const data = await res.json()

        if (data.success) {
            // Highlight active session
            items.forEach(el => {
                if (el.getAttribute('onclick')?.includes(sessionId)) {
                    el.classList.add('active')
                }
            })

            // Switch to Chat tab
            const chatTab = document.querySelector('[data-tab="chat"]')
            if (chatTab) chatTab.click()
        } else {
            console.error('Failed to resume session:', data.error)
        }
    } catch (err) {
        console.error('Resume session error:', err)
    }
}

// ============================================
// API Calls
// ============================================

async function loadStatus() {
    try {
        const res = await fetch('/api/status')
        const data = await res.json()
        updateFullState(data)
    } catch (err) {
        console.error('Failed to load status:', err)
    }
}

async function loadSessions() {
    try {
        const res = await fetch('/api/sessions')
        const data = await res.json()
        renderSessions(data)
    } catch (err) {
        console.error('Failed to load sessions:', err)
    }
}

async function loadProposals() {
    try {
        const res = await fetch('/api/proposals')
        const data = await res.json()
        renderProposals(data)
    } catch (err) {
        console.error('Failed to load proposals:', err)
    }
}

async function loadLayers() {
    try {
        const res = await fetch('/api/layers')
        const data = await res.json()
        renderLayers(data)
    } catch (err) {
        console.error('Failed to load layers:', err)
    }
}

async function loadTools() {
    try {
        const res = await fetch('/api/tools')
        const data = await res.json()
        renderTools(data)
    } catch (err) {
        console.error('Failed to load tools:', err)
    }
}

async function loadMemory() {
    try {
        // Load stats first
        const statsRes = await fetch('/api/memory/stats')
        const stats = await statsRes.json()

        const list = document.getElementById('memory-list')
        if (!list) return

        // Search bar handler
        const searchInput = document.getElementById('memory-search')
        const searchBtn = document.getElementById('memory-search-btn')
        if (searchBtn && !searchBtn._bound) {
            searchBtn._bound = true
            searchBtn.addEventListener('click', () => searchMemory())
            searchInput?.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') searchMemory()
            })
        }

        // Show stats header
        const statsHtml = stats.initialized
            ? `<div style="margin-bottom: 12px; padding: 8px 12px; background: var(--bg-secondary); border-radius: 8px; font-size: 13px;">
                <strong>${stats.totalEntries}</strong> Einträge gespeichert
                ${stats.byType ? ` — ${Object.entries(stats.byType).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}
               </div>`
            : '<div class="empty-state">LanceDB nicht initialisiert</div>'

        // Default search: show recent entries
        const searchRes = await fetch('/api/memory/search?q=&limit=20')
        const searchData = await searchRes.json()

        if (!searchData.results || searchData.results.length === 0) {
            list.innerHTML = statsHtml + '<div class="empty-state">Keine Einträge gefunden</div>'
            return
        }

        list.innerHTML = statsHtml + searchData.results.map(r => `
            <div class="panel" style="margin-bottom: 8px; padding: 10px 14px;" data-memory-id="${escapeHtml(r.id)}">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div style="flex: 1;">
                        <div style="font-size: 13px; line-height: 1.5;">${escapeHtml(r.content?.slice(0, 300) || 'N/A')}</div>
                        <div class="list-item-meta" style="margin-top: 4px;">
                            ${r.type || '?'} • ${r.source || '?'} • ${r.score ? `Score: ${r.score.toFixed(2)}` : ''} • ${r.timestamp ? new Date(r.timestamp).toLocaleDateString('de') : ''}
                        </div>
                    </div>
                    <button class="btn-delete-memory" onclick="deleteMemory('${escapeHtml(r.id)}')" title="Löschen" style="background: none; border: none; color: var(--error); cursor: pointer; font-size: 16px; padding: 4px 8px;">❌</button>
                </div>
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load memory:', err)
        const list = document.getElementById('memory-list')
        if (list) list.innerHTML = '<div class="empty-state">Fehler beim Laden der LanceDB Memories</div>'
    }
}

async function searchMemory() {
    const input = document.getElementById('memory-search')
    const query = input?.value?.trim() || ''
    const list = document.getElementById('memory-list')
    if (!list) return

    list.innerHTML = '<div class="empty-state">Suche...</div>'
    try {
        const res = await fetch(`/api/memory/search?q=${encodeURIComponent(query)}&limit=20`)
        const data = await res.json()

        if (!data.results || data.results.length === 0) {
            list.innerHTML = '<div class="empty-state">Keine Ergebnisse</div>'
            return
        }

        list.innerHTML = data.results.map(r => `
            <div class="panel" style="margin-bottom: 8px; padding: 10px 14px;" data-memory-id="${escapeHtml(r.id)}">
                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                    <div style="flex: 1;">
                        <div style="font-size: 13px; line-height: 1.5;">${escapeHtml(r.content?.slice(0, 300) || 'N/A')}</div>
                        <div class="list-item-meta" style="margin-top: 4px;">
                            ${r.type || '?'} • ${r.source || '?'} • Score: ${r.score?.toFixed(2) || '?'} • ${r.timestamp ? new Date(r.timestamp).toLocaleDateString('de') : ''}
                        </div>
                    </div>
                    <button class="btn-delete-memory" onclick="deleteMemory('${escapeHtml(r.id)}')" title="Löschen" style="background: none; border: none; color: var(--error); cursor: pointer; font-size: 16px; padding: 4px 8px;">❌</button>
                </div>
            </div>
        `).join('')
    } catch (err) {
        list.innerHTML = '<div class="empty-state">Suchfehler</div>'
    }
}

async function deleteMemory(id) {
    if (!confirm('Eintrag wirklich löschen?')) return
    try {
        const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' })
        const data = await res.json()
        if (data.deleted) {
            const el = document.querySelector(`[data-memory-id="${id}"]`)
            if (el) el.remove()
        } else {
            alert('Löschen fehlgeschlagen')
        }
    } catch (err) {
        alert('Fehler: ' + err)
    }
}

async function loadErrors() {
    try {
        const res = await fetch('/api/errors')
        const data = await res.json()
        renderErrors(data)
    } catch (err) {
        console.error('Failed to load errors:', err)
    }
}

// ============================================
// NEW: Memory Tier Loaders
// ============================================

async function loadCoreFacts() {
    try {
        const res = await fetch('/api/core-facts')
        const data = await res.json()
        const grid = document.getElementById('facts-grid')
        if (!grid) return

        if (!data.facts || data.facts.length === 0) {
            grid.innerHTML = '<div class="empty-state">Noch keine Core Facts. Füge den ersten Fakt hinzu!</div>'
            return
        }

        // Group by category
        const grouped = {}
        data.facts.forEach(f => {
            const cat = f.category || 'other'
            if (!grouped[cat]) grouped[cat] = []
            grouped[cat].push(f)
        })

        const categoryIcons = { identity: '👤', device: '🖥️', project: '📁', preference: '⚙️', pet: '🐾', network: '🌐', credential: '🔑', security: '🔒', dashboard: '📊', other: '📌' }

        grid.innerHTML = Object.entries(grouped).map(([cat, facts]) => `
            <div style="margin-bottom: 12px;">
                <h4 style="color: var(--accent); margin-bottom: 8px; font-size: 13px;">${categoryIcons[cat] || '📌'} ${escapeHtml(cat.toUpperCase())} (${facts.length})</h4>
                ${facts.map(f => `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: 4px;">
                        <div style="flex: 1;">
                            <div style="font-size: 13px; color: var(--text-primary);">${escapeHtml(f.fact)}</div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">
                                ${f.source === 'manual' ? '✍️ Manuell' : '🤖 Auto'}
                                ${f.priority ? ` · ${f.priority}` : ''}
                                ${f.createdAt ? ` · ${new Date(f.createdAt).toLocaleDateString('de')}` : ''}
                            </div>
                        </div>
                        <button onclick="deleteCoreFact('${f.id}')" style="padding: 4px 8px; border-radius: 4px; border: 1px solid #e74c3c; background: transparent; color: #e74c3c; cursor: pointer; font-size: 11px; flex-shrink: 0;">🗑️</button>
                    </div>
                `).join('')}
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load core facts:', err)
    }
}

async function loadColdStorage() {
    try {
        const res = await fetch('/api/cold-storage')
        const data = await res.json()
        const userEl = document.getElementById('user-md-content')
        const memoryEl = document.getElementById('memory-md-content')
        if (userEl) userEl.value = data.user || '(empty)'
        if (memoryEl) memoryEl.value = data.memory || '(empty)'
    } catch (err) {
        console.error('Failed to load cold storage:', err)
    }
}

async function loadSummaries() {
    try {
        const res = await fetch('/api/summaries')
        const data = await res.json()
        const list = document.getElementById('summaries-list')
        if (!list) return

        // Generate button
        const generateBtn = `<button id="generate-summaries-btn" onclick="generateSummaries()" style="margin-bottom: 12px; padding: 8px 16px; background: var(--accent-blue); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">🔄 Jetzt zusammenfassen</button>`

        if (!data.summaries || data.summaries.length === 0) {
            list.innerHTML = generateBtn + `<div class="empty-state">${data.note || 'Noch keine Summaries'}</div>`
            return
        }

        list.innerHTML = generateBtn + data.summaries.map(s => `
            <div class="panel" style="margin-bottom: 8px;">
                <div class="list-item-title" style="font-weight: 600;">📄 ${escapeHtml(s.file)}</div>
                ${s.summary ? `<div style="font-size: 13px; margin-top: 4px; color: var(--text-secondary);">${escapeHtml(typeof s.summary === 'string' ? s.summary.slice(0, 300) : JSON.stringify(s.summary).slice(0, 300))}</div>` : ''}
                ${s.messagesCompressed ? `<div class="list-item-meta">${s.messagesCompressed} Nachrichten komprimiert</div>` : ''}
                ${s.error ? '<div style="color: var(--error);">Error loading</div>' : ''}
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load summaries:', err)
    }
}

async function generateSummaries() {
    const btn = document.getElementById('generate-summaries-btn')
    if (btn) {
        btn.disabled = true
        btn.textContent = '⏳ Generiere...'
    }
    try {
        const res = await fetch('/api/summaries/generate', { method: 'POST' })
        const data = await res.json()
        if (btn) btn.textContent = `✅ ${data.generated} von ${data.total} generiert`
        setTimeout(() => loadSummaries(), 2000)
    } catch (err) {
        if (btn) btn.textContent = '❌ Fehler'
        console.error('Generate summaries failed:', err)
    }
}

async function loadGraph() {
    try {
        const res = await fetch('/api/graph')
        const data = await res.json()
        const statsEl = document.getElementById('graph-stats')
        const container = document.getElementById('graph-container')
        if (!statsEl || !container) return

        const nodeCount = data.nodes?.length || 0
        const edgeCount = data.edges?.length || 0
        statsEl.innerHTML = `<span style="color: var(--accent); font-weight: 600;">${nodeCount} Nodes</span> · <span style="color: var(--text-secondary);">${edgeCount} Edges</span>`

        if (nodeCount === 0) {
            container.innerHTML = '<div class="empty-state">No graph data</div>'
            return
        }

        // Render nodes as a list grouped by type
        const byType = {}
            ; (data.nodes || []).forEach(n => {
                const t = n.type || 'entity'
                if (!byType[t]) byType[t] = []
                byType[t].push(n)
            })

        container.innerHTML = Object.entries(byType).map(([type, nodes]) => `
            <div class="panel" style="margin-bottom: 8px;">
                <h4 style="color: var(--accent); margin-bottom: 6px; font-size: 13px;">${escapeHtml(type.toUpperCase())} (${nodes.length})</h4>
                <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${nodes.map(n => `<span class="tool-tag">${escapeHtml(n.label || n.name || n.id)}</span>`).join('')}
                </div>
            </div>
        `).join('') + (data.edges && data.edges.length > 0 ? `
            <div class="panel" style="margin-top: 12px;">
                <h4 style="color: var(--accent); margin-bottom: 6px; font-size: 13px;">CONNECTIONS</h4>
                ${data.edges.slice(0, 30).map(e => `
                    <div style="font-size: 12px; padding: 3px 0; color: var(--text-secondary);">
                        <span style="color: var(--text-primary);">${escapeHtml(e.source)}</span>
                        → <em>${escapeHtml(e.relation || 'related')}</em> →
                        <span style="color: var(--text-primary);">${escapeHtml(e.target)}</span>
                    </div>
                `).join('')}
            </div>
        ` : '')
    } catch (err) {
        console.error('Failed to load graph:', err)
    }
}

async function loadJournal() {
    try {
        const res = await fetch('/api/journal')
        const data = await res.json()
        const statsEl = document.getElementById('journal-stats')
        const list = document.getElementById('journal-entries')
        if (!statsEl || !list) return

        // Compute stats from entries if server stats unavailable
        const totalEvents = (data.entries || []).reduce((sum, e) => sum + (e.events?.length || 0), 0)
        const totalEntries = data.stats?.totalEntries || data.entries?.length || 0
        const totalTopics = data.stats?.totalTopics || 0
        statsEl.innerHTML = `<span style="color: var(--accent); font-weight: 600;">${totalEntries} Tage</span> · <span style="color: var(--text-secondary);">${totalEvents} Events</span>`

        if (!data.entries || data.entries.length === 0) {
            list.innerHTML = '<div class="empty-state">No journal entries yet</div>'
            return
        }

        list.innerHTML = data.entries.map(entry => `
            <div class="panel" style="margin-bottom: 8px;">
                <div class="list-item-title" style="font-weight: 600;">📅 ${escapeHtml(entry.date || 'Unknown')}</div>
                ${entry.events ? `<div style="font-size: 13px; margin-top: 4px;"><strong>Events:</strong> ${entry.events.length}</div>` : ''}
                ${entry.summary ? `<div style="font-size: 13px; margin-top: 4px; color: var(--text-secondary);">${escapeHtml(entry.summary.slice(0, 200))}</div>` : ''}
                ${entry.topics ? `<div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">${entry.topics.map(t => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            </div>
        `).join('')
    } catch (err) {
        console.error('Failed to load journal:', err)
    }
}

async function loadWatchdog() {
    try {
        const res = await fetch('/api/watchdog')
        const data = await res.json()

        const dot = elements.watchdogStatus.querySelector('.status-dot')
        const text = elements.watchdogStatus.querySelector('span:last-child')

        if (data.healthy) {
            dot.className = 'status-dot healthy'
            text.textContent = 'System Healthy'
        } else {
            dot.className = 'status-dot warning'
            text.textContent = `Issues: ${data.issues?.length || 0}`
        }
    } catch (err) {
        console.error('Failed to load watchdog:', err)
    }
}

async function approveProposal(id) {
    try {
        const res = await fetch(`/api/proposals/${id}/approve`, { method: 'POST' })
        const data = await res.json()

        if (data.success) {
            loadProposals()
        } else {
            alert('Failed to approve: ' + data.message)
        }
    } catch (err) {
        console.error('Failed to approve proposal:', err)
    }
}

async function rejectProposal(id) {
    try {
        const res = await fetch(`/api/proposals/${id}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'Rejected from dashboard' })
        })
        const data = await res.json()

        if (data.success) {
            loadProposals()
        }
    } catch (err) {
        console.error('Failed to reject proposal:', err)
    }
}

// ============================================
// Chat
// ============================================

function sendChatMessage() {
    const content = elements.chatInput.value.trim()
    if (!content || !ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({ type: 'chat', content }))
    elements.chatInput.value = ''
}

// ============================================
// Tab Navigation
// ============================================

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item')
    const tabContents = document.querySelectorAll('.tab-content')

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.dataset.tab

            // Update nav
            navItems.forEach(n => n.classList.remove('active'))
            item.classList.add('active')

            // Update content
            tabContents.forEach(t => t.classList.remove('active'))
            document.getElementById(`tab-${tab}`).classList.add('active')

            // Load tab-specific data
            switch (tab) {
                case 'overview': loadQueueStats(); break
                case 'performance': loadPerformance(); break
                case 'models': loadModels(); break
                case 'nodes': loadTopology(); break
                case 'memory': loadMemory(); break
                case 'updates': loadProposals(); break
                case 'config': loadConfig(); break
                case 'health': loadLayers(); loadTools(); loadErrors(); break
                case 'scheduler': loadScheduler(); break
                case 'tasks': loadTaskTracker(); break
                case 'trust': loadTrustRuns(); break
                case 'logs': loadLogs(); break
                case 'chat': loadChatSessions(); break
            }
        })
    })
}

async function loadTrustRuns() {
    const container = document.getElementById('trust-runs')
    if (!container) return
    loadTrustInfrastructure()
    try {
        const response = await fetch('/api/trust/runs?limit=50')
        const data = await response.json()
        const summary = data.summary || {}
        document.getElementById('trust-total').textContent = summary.total || 0
        document.getElementById('trust-validated').textContent = summary.validated || 0
        document.getElementById('trust-approval').textContent = summary.awaitingApproval || 0
        document.getElementById('trust-failed').textContent = summary.failed || 0

        const runs = data.runs || []
        container.innerHTML = runs.map(run => {
            const criteria = run.validation?.criteria || []
            const evidenceCount = (run.tools || []).filter(item => item.success).length
            const criteriaHtml = criteria.map(item =>
                `<span class="trust-criterion ${item.success ? 'passed' : 'failed'}">${item.success ? 'PASS' : 'FAIL'} ${escapeHtml(item.criterionId)}</span>`
            ).join('')
            const toolHtml = (run.tools || []).map(item => `<details class="trust-evidence">
                <summary>${item.success ? 'PASS' : 'FAIL'} ${escapeHtml(item.toolName || 'tool')} · ${Number(item.durationMs || 0)} ms${item.replayed ? ' · replayed' : ''}</summary>
                <pre>${escapeHtml(JSON.stringify({ params: item.params, result: item.result, validation: item.validation, error: item.error, idempotencyKey: item.idempotencyKey }, null, 2))}</pre>
            </details>`).join('')
            const eventHtml = (run.events || []).map(event => `<div class="metric-row"><span>${escapeHtml(event.type)}</span><small>${new Date(event.timestamp).toLocaleString()}</small></div>`).join('')
            const actions = run.status === 'awaiting_approval' ? `<div class="trust-actions">
                <button onclick="trustRunAction('${escapeHtml(run.runId)}','approve')">Approve & resume</button>
                <button onclick="trustRunAction('${escapeHtml(run.runId)}','reject')">Reject</button>
                <button onclick="trustRunAction('${escapeHtml(run.runId)}','resume')">Resume</button>
            </div>` : ''
            return `<details class="trust-run trust-${escapeHtml(run.status)}" ontoggle="if(this.open) loadTrustRunDetail('${escapeHtml(run.runId)}', this)">
                <summary>
                    <span class="trust-status">${escapeHtml(run.status)}</span>
                    <strong>${escapeHtml(run.contract?.goal || run.runId)}</strong>
                    <span>${escapeHtml(run.backend || 'nova')} / ${escapeHtml(run.model || 'auto')}</span>
                    <time>${new Date(run.updatedAt).toLocaleString()}</time>
                </summary>
                <div class="trust-detail">
                    <div><b>Run ID</b><code>${escapeHtml(run.runId)}</code></div>
                    <div><b>Node</b><span>${escapeHtml(run.node || 'local/automatic')}</span></div>
                    <div><b>Tool evidence</b><span>${evidenceCount} verified / ${(run.tools || []).length} calls</span></div>
                    <div><b>Cost</b><span>$${Number(run.totalCostUsd || 0).toFixed(4)} / ${Number(run.totalTokens || 0)} tokens</span></div>
                    <div><b>Events</b><span>${run.eventCount || 0}</span></div>
                    <div class="trust-criteria">${criteriaHtml || '<span class="trust-criterion">pending validation</span>'}</div>
                    ${actions}
                    <div class="trust-tool-evidence">${toolHtml || '<div class="empty-state">No tool evidence</div>'}</div>
                    <details><summary>Event timeline</summary><div class="trust-events">${eventHtml}</div></details>
                    <div class="trust-feedback"><button onclick="submitTrustFeedback('${escapeHtml(run.runId)}')">Add feedback</button></div>
                    <div class="trust-live-detail"></div>
                </div>
            </details>`
        }).join('') || '<div class="empty-state">No outcome runs recorded yet</div>'
    } catch (error) {
        container.innerHTML = `<div class="empty-state">Trust data unavailable: ${escapeHtml(String(error))}</div>`
    }
}

async function loadTrustInfrastructure() {
    const capabilities = document.getElementById('trust-capabilities')
    const benchmarks = document.getElementById('trust-benchmarks')
    const operator = document.getElementById('trust-operator')
    try {
        const [capRes, reportRes, operatorRes] = await Promise.all([fetch('/api/trust/capabilities'), fetch('/api/trust/benchmarks/reports'), fetch('/api/trust/operator-overview')])
        const graph = await capRes.json()
        const reportData = await reportRes.json()
        const operatorData = await operatorRes.json()
        if (capabilities) capabilities.innerHTML = `<div class="metric-row"><span>Canonical graph</span><strong>${(graph.nodes || []).length} nodes / ${(graph.nodes || []).reduce((sum,n)=>sum+(n.runtimes||[]).length,0)} runtimes</strong><small>${(graph.tombstones || []).length} tombstones · ${escapeHtml(graph.updatedAt || 'never')}</small></div>`
        const latest = (reportData.reports || [])[0]
        if (benchmarks) benchmarks.innerHTML = latest
            ? `<div class="metric-row"><span>${escapeHtml(latest.createdAt || latest.file)}</span><strong>${Math.round(Number(latest.metrics?.taskCompletionRate || 0) * 100)}% completion</strong><small>${Number(latest.metrics?.scenarios || 0)} scenarios · $${Number(latest.metrics?.totalCostUsd || 0).toFixed(4)}</small></div>`
            : `<div class="empty-state">${reportData.running ? 'Benchmark running…' : 'No benchmark report yet'}</div>`
        if (operator) {
            const router = operatorData.router || {}
            const eligible = (router.cells || []).filter(cell => cell.activationEligible).length
            operator.innerHTML = [
                ['Mission workspaces', `${(operatorData.workspaces || []).length} tracked`],
                ['MCP', `${operatorData.mcp?.tools || 0} tools / ${(operatorData.mcp?.servers || []).filter(server => server.connected).length} connected servers`],
                ['Outcome router', `${router.mode || 'shadow'} · ${eligible}/${(router.cells || []).length} training cells eligible`],
                ['Memory governance', `${operatorData.memory?.stats?.canonical || 0} canonical · ${operatorData.memory?.stats?.candidate || 0} candidates`],
                ['Blue Team', `${operatorData.blueTeam?.incidents?.length || 0} incidents`],
                ['Lifecycle policy', `${operatorData.lifecycle?.hooks?.length || 0} active hooks`],
            ].map(row => `<div class="metric-row"><span>${escapeHtml(row[0])}</span><strong>${escapeHtml(row[1])}</strong></div>`).join('')
        }
    } catch (error) {
        if (benchmarks) benchmarks.innerHTML = `<div class="empty-state">${escapeHtml(String(error))}</div>`
        if (operator) operator.textContent = String(error)
    }
}

async function runTrustBenchmark(mode) {
    const response = await fetch('/api/trust/benchmarks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
    const data = await response.json()
    if (!data.success) alert(data.error || 'Benchmark could not start')
    await loadTrustInfrastructure()
}

async function loadTrustRunDetail(runId, element) {
    const target = element?.querySelector('.trust-live-detail')
    if (!target || target.dataset.loaded) return
    try {
        const response = await fetch(`/api/trust/runs/${encodeURIComponent(runId)}`)
        const run = await response.json()
        target.dataset.loaded = 'true'
        target.innerHTML = `<h4>Checkpoint & approval</h4><pre>${escapeHtml(JSON.stringify({ checkpoint: run.checkpoint, liveApproval: run.liveApproval, approvals: run.approvals, feedback: run.feedback, finalOutcome: run.finalOutcome }, null, 2))}</pre>`
    } catch (error) { target.textContent = String(error) }
}

async function trustRunAction(runId, action) {
    const reason = action === 'reject' ? (prompt('Reason for rejection:') || '') : ''
    const response = await fetch(`/api/trust/runs/${encodeURIComponent(runId)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
    })
    const data = await response.json()
    if (!data.success) alert(data.error || 'Action failed')
    await loadTrustRuns()
}

async function submitTrustFeedback(runId) {
    const raw = prompt('Rating 1–5:')
    if (raw === null) return
    const comment = prompt('Feedback or correction:') || ''
    const response = await fetch(`/api/trust/runs/${encodeURIComponent(runId)}/feedback`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: Number(raw), accepted: Number(raw) >= 4, comment }),
    })
    const data = await response.json()
    if (!data.success) alert(data.error || 'Feedback failed')
    await loadTrustRuns()
}

window.loadTrustRuns = loadTrustRuns
window.loadTrustRunDetail = loadTrustRunDetail
window.trustRunAction = trustRunAction
window.submitTrustFeedback = submitTrustFeedback
window.runTrustBenchmark = runTrustBenchmark

async function loadPerformance() {
    try {
        const res = await fetch('/api/performance')
        const data = await res.json()
        document.getElementById('perf-p95').textContent = `${data.pipeline?.p95Ms || 0} ms`
        document.getElementById('perf-active').textContent = `${data.backpressure?.active || 0} / ${data.backpressure?.queued || 0}`
        document.getElementById('perf-loop').textContent = `${data.runtime?.eventLoop?.maxMs || 0} ms`
        document.getElementById('perf-memory').textContent = `${data.runtime?.memory?.rssMb || 0} MB`
        document.getElementById('perf-stages').innerHTML = (data.pipeline?.slowestStages || []).map(s =>
            `<div class="metric-row"><span>${escapeHtml(s.name)}</span><strong>${s.averageMs} ms</strong><small>${s.samples} samples</small></div>`
        ).join('') || '<div class="empty-state">No completed requests yet</div>'
        document.getElementById('perf-models').innerHTML = (data.models || []).map(m =>
            `<div class="metric-row"><span>${escapeHtml(m.model)}</span><strong>${Math.round(m.successRate * 100)}%</strong><small>${m.avgLatencyMs} ms</small></div>`
        ).join('') || '<div class="empty-state">No model calls recorded</div>'
    } catch (err) {
        console.error('Failed to load performance:', err)
    }
}

// ============================================
// Scheduler
// ============================================

async function loadScheduler() {
    const container = document.getElementById('scheduler-jobs')
    if (!container) return

    try {
        const resp = await fetch('/api/scheduler')
        const data = await resp.json()
        const jobs = data.jobs || []

        if (jobs.length === 0) {
            container.innerHTML = '<div class="empty-state">Keine aktiven Cron Jobs. Erstelle einen oben ☝️</div>'
            return
        }

        container.innerHTML = jobs.map(job => `
            <div class="item" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border);">
                <div>
                    <strong>${escapeHtml(job.action || job.id)}</strong>
                    <span style="color: var(--text-secondary); font-size: 12px; margin-left: 8px;">${escapeHtml(job.cron || job.cronExpression || '')}</span>
                    ${job.nextRun ? `<br><span style="color: var(--text-secondary); font-size: 11px;">Nächste Ausführung: ${formatTime(job.nextRun)}</span>` : ''}
                </div>
                <button onclick="deleteSchedulerJob('${escapeHtml(job.id)}')"
                    style="background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px 8px;" title="Job löschen">❌</button>
            </div>
        `).join('')
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Fehler: ${err.message}</div>`
    }
}

async function createSchedulerJob() {
    const actionInput = document.getElementById('cron-action')
    const hourSelect = document.getElementById('cron-hour')
    const minuteSelect = document.getElementById('cron-minute')
    const daySelect = document.getElementById('cron-day')
    if (!actionInput || !hourSelect || !minuteSelect || !daySelect) return

    const action = actionInput.value.trim()
    if (!action) {
        alert('Bitte eine Aktion eingeben!')
        return
    }

    const minute = minuteSelect.value
    const hour = hourSelect.value
    const dayPart = daySelect.value // e.g. "* * *" or "* * 1" or "1 * *"
    const cron = `${minute} ${hour} ${dayPart}`

    try {
        const resp = await fetch('/api/scheduler', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, cron })
        })
        const data = await resp.json()

        if (data.success) {
            actionInput.value = ''
            loadScheduler()
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannter Fehler'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

async function deleteSchedulerJob(id) {
    if (!confirm('Job wirklich löschen?')) return

    try {
        const resp = await fetch(`/api/scheduler/${id}`, { method: 'DELETE' })
        const data = await resp.json()
        if (data.success) {
            loadScheduler()
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannter Fehler'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

// ============================================
// Tasks
// ============================================

async function loadTasks() {
    const statusDiv = document.getElementById('task-status')
    const thoughtsDiv = document.getElementById('task-thoughts')
    if (!statusDiv) return

    try {
        const resp = await fetch('/api/tasks')
        const data = await resp.json()

        // Nova status + user tasks
        const nova = data.nova || {}
        const stats = data.stats || {}
        const tasks = data.tasks || []

        let html = `
            <div style="padding: 12px;">
                <div style="display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px;">
                    <div><strong>Status:</strong> <span style="color: ${nova.status === 'idle' ? 'var(--text-secondary)' : 'var(--accent-blue)'};">${nova.status || 'unknown'}</span></div>
                    ${nova.currentTask ? `<div><strong>Task:</strong> ${escapeHtml(nova.currentTask)}</div>` : ''}
                    <div><strong>Tokens heute:</strong> ${formatNumber(stats.tokensToday || 0)}</div>
                    <div><strong>Requests:</strong> ${formatNumber(stats.requestsToday || 0)}</div>
                </div>`

        if (tasks.length > 0) {
            html += `<h4 style="margin: 12px 0 8px;">📋 Erstellte Tasks (${tasks.length})</h4>`
            html += tasks.map(t => {
                const priorityIcon = t.priority === 'high' ? '⚡' : t.priority === 'low' ? '🐢' : '📌'
                const statusColor = t.status === 'done' ? 'var(--accent-green)' : t.status === 'running' ? 'var(--accent-blue)' : 'var(--text-secondary)'
                return `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border);">
                    <div>
                        <span>${priorityIcon}</span>
                        <strong>${escapeHtml(t.name)}</strong>
                        <span style="color: ${statusColor}; font-size: 12px; margin-left: 6px;">${t.status || 'pending'}</span>
                        ${t.description ? `<div style="color: var(--text-secondary); font-size: 12px; margin-top: 2px;">${escapeHtml(t.description)}</div>` : ''}
                    </div>
                    <span style="color: var(--text-secondary); font-size: 11px;">${formatTime(t.createdAt)}</span>
                </div>`
            }).join('')
        }

        html += `
                ${data.errors && data.errors.length > 0 ? `
                    <h4 style="margin: 12px 0 8px; color: var(--accent-red);">⚠️ Letzte Fehler (${data.errors.length})</h4>
                    ${data.errors.map(e => `<div style="padding: 4px 0; font-size: 12px; color: var(--accent-red);">• ${escapeHtml(e.message || String(e))}</div>`).join('')}
                ` : '<div style="color: var(--text-secondary); font-size: 13px; margin-top: 8px;">✅ Keine Fehler</div>'}
            </div>
        `
        statusDiv.innerHTML = html

        // Thoughts
        if (thoughtsDiv) {
            const thoughts = data.thoughts || []
            if (thoughts.length === 0) {
                thoughtsDiv.innerHTML = '<div class="empty-state">Keine Gedanken</div>'
            } else {
                thoughtsDiv.innerHTML = thoughts.map(t => `
                    <div class="item" style="padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 13px;">
                        <span style="color: var(--text-secondary); font-size: 11px;">${formatTime(t.timestamp)}</span>
                        <div>${escapeHtml(t.content)}</div>
                    </div>
                `).join('')
            }
        }
    } catch (err) {
        statusDiv.innerHTML = `<div class="empty-state">Fehler: ${err.message}</div>`
    }
}

async function addTask() {
    const nameInput = document.getElementById('task-name')
    const descInput = document.getElementById('task-description')
    const prioritySelect = document.getElementById('task-priority')
    if (!nameInput) return

    const name = nameInput.value.trim()
    if (!name) {
        alert('Bitte einen Task-Namen eingeben!')
        return
    }

    try {
        const resp = await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                description: descInput ? descInput.value.trim() : '',
                priority: prioritySelect ? prioritySelect.value : 'normal'
            })
        })
        const data = await resp.json()

        if (data.success) {
            nameInput.value = ''
            if (descInput) descInput.value = ''
            loadTasks()
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannter Fehler'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

// ============================================
// Utilities
// ============================================

function escapeHtml(text) {
    if (!text) return ''
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
}

function formatNumber(num) {
    return new Intl.NumberFormat().format(num)
}

function formatTime(timestamp) {
    if (!timestamp) return '--'
    return new Date(timestamp).toLocaleString()
}

// ============================================
// Initialize
// ============================================

function init() {
    setupNavigation()
    setupMemorySubTabs()
    connectWebSocket()

    // Initial data load
    loadStatus()
    loadSessions()
    loadQueueStats()

    // Chat handlers
    elements.chatSend.addEventListener('click', sendChatMessage)
    elements.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            sendChatMessage()
        }
    })

    // Periodic refresh
    setInterval(() => {
        loadStatus()
        loadQueueStats()
        if (state.nova.uptime) updateUptime(state.nova.uptime)
    }, 5000)

    // Update uptime every second
    setInterval(() => {
        if (state.nova.uptime) updateUptime(state.nova.uptime)
    }, 1000)
}

// Start
document.addEventListener('DOMContentLoaded', init)

// Make functions available globally for onclick handlers
window.approveProposal = approveProposal
window.rejectProposal = rejectProposal
window.saveConfig = saveConfig
window.createSchedulerJob = createSchedulerJob
window.deleteSchedulerJob = deleteSchedulerJob
window.loadTasks = loadTasks
window.addTask = addTask
window.saveCoreFacts = saveCoreFacts
window.saveColdStorage = saveColdStorage
window.addCoreFact = addCoreFact
window.deleteCoreFact = deleteCoreFact
window.resetGraph = resetGraph

// ============================================
// Core Facts CRUD
// ============================================

async function addCoreFact() {
    const factInput = document.getElementById('new-fact-text')
    const catSelect = document.getElementById('new-fact-category')
    if (!factInput) return

    const fact = factInput.value.trim()
    if (!fact) {
        alert('Bitte einen Fakt eingeben!')
        return
    }

    try {
        const resp = await fetch('/api/core-facts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fact,
                category: catSelect ? catSelect.value : 'other',
                priority: 'normal'
            })
        })
        const data = await resp.json()
        if (data.success) {
            factInput.value = ''
            loadCoreFacts()
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannt'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

async function deleteCoreFact(id) {
    if (!confirm('Fakt wirklich löschen?')) return
    try {
        await fetch(`/api/core-facts/${id}`, { method: 'DELETE' })
        loadCoreFacts()
    } catch (err) {
        console.error('Failed to delete fact:', err)
    }
}

async function resetGraph() {
    if (!confirm('⚠️ Knowledge Graph wirklich komplett zurücksetzen? Alle Nodes und Edges werden gelöscht!')) return
    try {
        const resp = await fetch('/api/graph/reset', { method: 'DELETE' })
        const data = await resp.json()
        if (data.success) {
            alert('✅ Graph zurückgesetzt. Er wird beim nächsten Gespräch neu aufgebaut.')
            loadGraph()
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

// ============================================
// Memory Edit Functions
// ============================================

let currentCoreFacts = null

async function saveCoreFacts() {
    if (!currentCoreFacts) return
    try {
        const res = await fetch('/api/core-facts', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentCoreFacts),
        })
        const data = await res.json()
        if (data.success) {
            alert('✅ Core Facts gespeichert!')
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannt'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

async function saveColdStorage(file) {
    const elementId = file === 'user' ? 'user-md-content' : 'memory-md-content'
    const content = document.getElementById(elementId).value
    try {
        const res = await fetch(`/api/cold-storage/${file}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        })
        const data = await res.json()
        if (data.success) {
            alert(`✅ ${file === 'user' ? 'USER.md' : 'MEMORY.md'} gespeichert!`)
        } else {
            alert('Fehler: ' + (data.error || 'Unbekannt'))
        }
    } catch (err) {
        alert('Fehler: ' + err.message)
    }
}

// ============================================
// Chat Session History
// ============================================

async function loadChatSessions() {
    try {
        const res = await fetch('/api/chat/sessions')
        const data = await res.json()
        const selector = document.getElementById('session-selector')
        if (!selector) return

        // Keep current option
        selector.innerHTML = '<option value="current">Aktuelle Session</option>'

        if (data.sessions && data.sessions.length > 0) {
            data.sessions.forEach(s => {
                const opt = document.createElement('option')
                opt.value = s.id
                opt.textContent = `${new Date(s.date).toLocaleString('de-DE')} (${Math.round(s.size / 1024)}KB)`
                selector.appendChild(opt)
            })
        }
    } catch (err) {
        console.error('Failed to load chat sessions:', err)
    }
}

// Session selector handler
document.addEventListener('DOMContentLoaded', () => {
    const selector = document.getElementById('session-selector')
    if (selector) {
        selector.addEventListener('change', async (e) => {
            const id = e.target.value
            if (id === 'current') {
                // Reload current chat
                try {
                    const res = await fetch('/api/chat')
                    state.chatMessages = await res.json()
                    renderChatMessages()
                } catch (err) { console.error(err) }
            } else {
                // Load old session
                try {
                    const res = await fetch(`/api/chat/sessions/${id}`)
                    const data = await res.json()
                    // Old sessions may be arrays or objects with messages
                    const messages = Array.isArray(data) ? data : (data.messages || data.history || [])
                    state.chatMessages = messages
                    renderChatMessages()
                } catch (err) { console.error(err) }
            }
        })
    }
})

// ============================================
// Task Tracker
// ============================================

async function loadTaskTracker() {
    const cardEl = document.getElementById('active-task-card')
    const historyEl = document.getElementById('task-history-list')
    if (!cardEl || !historyEl) return

    try {
        const res = await fetch('/api/tasks')
        const data = await res.json()

        // Render current task
        if (data.current) {
            const task = data.current
            const doneCount = task.steps.filter(s => s.status === 'done').length
            const total = task.steps.length
            const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
            const elapsed = ((Date.now() - task.startedAt) / 1000).toFixed(1)

            const stepsHtml = task.steps.map(s => {
                const icon = s.status === 'done' ? '✅'
                    : s.status === 'active' ? '🔄'
                        : s.status === 'failed' ? '❌'
                            : '⬜'
                const toolBadge = s.tool ? ` <span style="font-size: 10px; background: var(--accent-blue); color: white; padding: 1px 6px; border-radius: 3px;">${escapeHtml(s.tool)}</span>` : ''
                return `<div style="padding: 4px 0; font-size: 13px;">${icon} ${escapeHtml(s.description)}${toolBadge}</div>`
            }).join('')

            cardEl.innerHTML = `
                <div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: var(--text-primary);">"📨 ${escapeHtml(task.summary)}"</div>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                    <div style="flex: 1; height: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden;">
                        <div style="width: ${pct}%; height: 100%; background: linear-gradient(90deg, #4ade80, #22d3ee); border-radius: 4px; transition: width 0.3s;"></div>
                    </div>
                    <span style="font-size: 12px; color: var(--text-secondary); white-space: nowrap;">Schritt ${doneCount + 1}/${total}</span>
                </div>
                ${stepsHtml}
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-secondary);">⏱ ${elapsed}s | 📡 ${escapeHtml(task.channel)} | 👤 ${escapeHtml(task.user)}</div>
            `
        } else {
            cardEl.innerHTML = '<div class="empty-state">💤 Keine aktive Aufgabe — warte auf nächste Anfrage</div>'
        }

        // Render history
        const history = (data.history || []).slice(-10).reverse()
        if (history.length === 0) {
            historyEl.innerHTML = '<div class="empty-state">Noch keine abgeschlossenen Aufgaben</div>'
        } else {
            historyEl.innerHTML = history.map(t => {
                const dur = t.duration ? t.duration < 1000 ? `${t.duration}ms` : `${(t.duration / 1000).toFixed(1)}s` : '?'
                const icon = t.status === 'done' ? '✅' : '❌'
                const date = new Date(t.startedAt).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
                return `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border);">
                        <div>
                            <div style="font-size: 13px;">${icon} ${escapeHtml(t.summary)}</div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">${t.steps.length} Schritte | ${dur} | ${escapeHtml(t.channel)} | ${date}</div>
                        </div>
                    </div>
                `
            }).join('')
        }
    } catch (err) {
        cardEl.innerHTML = `<div class="empty-state">Fehler: ${err.message}</div>`
    }
}

// ============================================
// Log Viewer
// ============================================

let logAutoRefreshTimer = null

async function loadLogs() {
    const output = document.getElementById('log-output')
    if (!output) return

    const count = document.getElementById('log-count')?.value || 100

    try {
        const res = await fetch(`/api/logs?count=${count}`)
        const data = await res.json()

        if (data.lines && data.lines.length > 0) {
            // Colorize log lines
            const colored = data.lines.map(line => {
                let l = escapeHtml(line)
                if (l.includes('[ERROR]') || l.includes('❌') || l.includes('error')) {
                    return `<span style="color: #ff6b6b;">${l}</span>`
                }
                if (l.includes('[WARN]') || l.includes('⚠')) {
                    return `<span style="color: #ffd93d;">${l}</span>`
                }
                if (l.includes('✅') || l.includes('✔') || l.includes('Success') || l.includes('ready')) {
                    return `<span style="color: #4ade80;">${l}</span>`
                }
                if (l.includes('[Nova]')) {
                    return `<span style="color: #60a5fa;">${l}</span>`
                }
                return l
            }).join('\n')

            output.innerHTML = colored
            // Auto-scroll to bottom
            output.scrollTop = output.scrollHeight
        } else {
            output.textContent = 'Keine Logs gefunden.'
        }
    } catch (err) {
        output.textContent = `Fehler: ${err.message}`
    }
}

function toggleLogAutoRefresh() {
    const checked = document.getElementById('log-auto-refresh')?.checked
    if (checked) {
        logAutoRefreshTimer = setInterval(loadLogs, 5000)
    } else {
        if (logAutoRefreshTimer) clearInterval(logAutoRefreshTimer)
        logAutoRefreshTimer = null
    }
}

// Start auto-refresh for logs if checkbox is checked on page load
setTimeout(() => {
    const checked = document.getElementById('log-auto-refresh')?.checked
    if (checked) {
        logAutoRefreshTimer = setInterval(loadLogs, 5000)
    }
}, 1000)

// ============================================
// Mesh Network
// ============================================

async function loadMeshNodes() {
    const container = document.getElementById('mesh-nodes-list')
    const selector = document.getElementById('mesh-target-node')
    if (!container) return

    try {
        const res = await fetch('/api/mesh/nodes')
        const data = await res.json()
        const nodes = data.nodes || []

        if (nodes.length === 0) {
            container.innerHTML = '<div class="empty-state">Keine Nodes gefunden</div>'
            return
        }

        container.innerHTML = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
            ${nodes.map(n => {
            const isOnline = n.status === 'online'
            const lastSeen = n.last_seen ? new Date(n.last_seen).toLocaleTimeString('de-DE') : '?'
            const platform = n.platform || n.os || '?'
            return `<div style="padding: 14px; background: var(--bg-secondary); border-radius: 10px; border: 1px solid ${isOnline ? 'var(--accent)' : 'var(--border)'}; position: relative;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                        <span class="status-dot ${isOnline ? 'healthy' : 'error'}" style="width: 10px; height: 10px;"></span>
                        <strong style="font-size: 14px;">${escapeHtml(n.hostname || n.node_id || '?')}</strong>
                    </div>
                    <div style="font-size: 12px; color: var(--text-secondary);">
                        <div>🆔 ${escapeHtml(n.node_id || '?')}</div>
                        <div>💻 ${escapeHtml(platform)}</div>
                        <div>🔧 ${n.tools_count || '?'} Tools</div>
                        <div>🕐 ${lastSeen}</div>
                    </div>
                </div>`
        }).join('')}
        </div>`

        // Populate selectors (task + chat + update)
        const selectors = [
            selector,
            document.getElementById('mesh-chat-node'),
            document.getElementById('mesh-update-node')
        ].filter(Boolean)
        for (const sel of selectors) {
            const current = sel.value
            sel.innerHTML = '<option value="">Node ausw\u00e4hlen...</option>' +
                nodes.map(n => `<option value="${escapeHtml(n.node_id)}">${escapeHtml(n.hostname || n.node_id)} (${n.status || '?'})</option>`).join('')
            if (current) sel.value = current
        }
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Fehler: ${err.message}</div>`
    }
}

async function loadMeshTasks() {
    const container = document.getElementById('mesh-tasks-list')
    if (!container) return

    try {
        const res = await fetch('/api/mesh/tasks')
        const data = await res.json()
        const tasks = data.tasks || []

        if (tasks.length === 0) {
            container.innerHTML = '<div class="empty-state">Keine Tasks</div>'
            return
        }

        container.innerHTML = tasks.map(t => {
            const statusColors = { pending: '#f39c12', running: '#3498db', done: '#27ae60', failed: '#e74c3c' }
            const statusIcons = { pending: '⏳', running: '🔄', done: '✅', failed: '❌' }
            const color = statusColors[t.status] || '#888'
            const icon = statusIcons[t.status] || '❓'
            const time = t.created_at ? new Date(typeof t.created_at === 'number' ? t.created_at : t.created_at).toLocaleTimeString('de-DE') : '?'
            return `<div style="padding: 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border-left: 3px solid ${color};">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 13px; font-weight: 600;">${icon} ${escapeHtml(t.task?.slice(0, 80) || '?')}</div>
                        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px;">
                            ${escapeHtml(t.from_node || '?')} → ${escapeHtml(t.to_node || '?')} · ${time}
                        </div>
                    </div>
                    <span style="padding: 2px 8px; border-radius: 4px; background: ${color}22; color: ${color}; font-size: 11px; font-weight: 600;">${t.status}</span>
                </div>
                ${t.result ? `<pre style="margin-top: 8px; padding: 8px; background: var(--bg-tertiary); border-radius: 6px; font-size: 11px; max-height: 150px; overflow: auto; white-space: pre-wrap; color: var(--text-primary);">${escapeHtml(t.result)}</pre>` : ''}
            </div>`
        }).join('')
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Fehler: ${err.message}</div>`
    }
}

async function sendMeshTask() {
    const targetNode = document.getElementById('mesh-target-node')?.value
    const taskInput = document.getElementById('mesh-task-input')
    const task = taskInput?.value?.trim()
    const statusDiv = document.getElementById('mesh-task-status')

    if (!targetNode) {
        alert('Bitte einen Node auswählen!')
        return
    }
    if (!task) {
        alert('Bitte einen Befehl eingeben!')
        return
    }

    statusDiv.style.display = 'block'
    statusDiv.innerHTML = '⏳ Task wird gesendet...'

    try {
        const res = await fetch('/api/mesh/delegate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetNode, task })
        })
        const data = await res.json()

        if (data.success) {
            statusDiv.innerHTML = `✅ Task <strong>${escapeHtml(data.taskId)}</strong> gesendet! Warte auf Ergebnis...`
            taskInput.value = ''

            // Poll for result
            pollMeshTask(data.taskId, statusDiv)
        } else {
            statusDiv.innerHTML = `❌ Fehler: ${escapeHtml(data.error || 'Unknown error')}`
        }
    } catch (err) {
        statusDiv.innerHTML = `❌ Netzwerkfehler: ${err.message}`
    }
}

async function pollMeshTask(taskId, statusDiv) {
    let attempts = 0
    const maxAttempts = 20 // 20 × 3s = 60s max

    const poll = async () => {
        attempts++
        try {
            const res = await fetch(`/api/mesh/tasks/${taskId}`)
            const task = await res.json()

            if (task.status === 'done') {
                statusDiv.innerHTML = `✅ Task abgeschlossen!<pre style="margin-top: 8px; padding: 8px; background: var(--bg-tertiary); border-radius: 6px; font-size: 12px; max-height: 200px; overflow: auto; white-space: pre-wrap; color: var(--text-primary);">${escapeHtml(task.result || '(no output)')}</pre>`
                loadMeshTasks() // Refresh task list
                return
            }

            if (task.status === 'failed') {
                statusDiv.innerHTML = `❌ Task fehlgeschlagen: <pre style="margin-top: 8px; padding: 8px; background: #2a1515; border-radius: 6px; font-size: 12px; color: #e74c3c;">${escapeHtml(task.result || 'Unknown error')}</pre>`
                loadMeshTasks()
                return
            }

            if (attempts >= maxAttempts) {
                statusDiv.innerHTML = `⏳ Task noch nicht abgeschlossen (Status: ${task.status}). Prüfe Task History.`
                loadMeshTasks()
                return
            }

            statusDiv.innerHTML = `🔄 Warte auf Ergebnis... (${attempts}/${maxAttempts})`
            setTimeout(poll, 3000)
        } catch (err) {
            statusDiv.innerHTML = `⚠️ Poll-Fehler: ${err.message}`
        }
    }

    setTimeout(poll, 3000) // First poll after 3s
}

// ============================================
// Mesh LLM Chat
// ============================================

const meshChatHistory = []

function renderMeshChat() {
    const container = document.getElementById('mesh-chat-messages')
    if (!container) return

    if (meshChatHistory.length === 0) {
        container.innerHTML = '<div class="empty-state">Wähle einen Node und starte den Chat</div>'
        return
    }

    container.innerHTML = meshChatHistory.map(msg => {
        const isUser = msg.role === 'user'
        const bg = isUser ? 'linear-gradient(135deg, #667eea, #764ba2)' : 'var(--bg-secondary)'
        const color = isUser ? 'white' : 'var(--text-primary)'
        const align = isUser ? 'flex-end' : 'flex-start'
        const nodeLabel = msg.node ? `<div style="font-size: 10px; color: var(--text-secondary); margin-bottom: 2px;">${isUser ? 'Du' : '🤖 ' + escapeHtml(msg.node)}</div>` : ''
        return `<div style="display: flex; justify-content: ${align}; margin-bottom: 10px;">
            <div style="max-width: 80%; padding: 10px 14px; border-radius: 12px; background: ${bg}; color: ${color}; font-size: 13px; line-height: 1.5; white-space: pre-wrap;">
                ${nodeLabel}
                ${escapeHtml(msg.content)}
            </div>
        </div>`
    }).join('')

    container.scrollTop = container.scrollHeight
}

async function sendMeshChat() {
    const nodeSelector = document.getElementById('mesh-chat-node')
    const input = document.getElementById('mesh-chat-input')
    const targetNode = nodeSelector?.value
    const message = input?.value?.trim()

    if (!targetNode) {
        alert('Bitte einen Node für den Chat auswählen!')
        return
    }
    if (!message) return

    // Add user message
    const nodeName = nodeSelector.selectedOptions[0]?.text || targetNode
    meshChatHistory.push({ role: 'user', content: message, node: nodeName })
    input.value = ''
    renderMeshChat()

    // Show typing indicator
    meshChatHistory.push({ role: 'assistant', content: '⏳ Denkt nach...', node: nodeName })
    renderMeshChat()

    try {
        const res = await fetch('/api/mesh/delegate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetNode, task: `chat:${message}` })
        })
        const data = await res.json()

        if (!data.success) {
            meshChatHistory[meshChatHistory.length - 1].content = `❌ ${data.error || 'Fehler beim Senden'}`
            renderMeshChat()
            return
        }

        // Poll for LLM response
        pollMeshChatResponse(data.taskId, nodeName)
    } catch (err) {
        meshChatHistory[meshChatHistory.length - 1].content = `❌ Netzwerkfehler: ${err.message}`
        renderMeshChat()
    }
}

async function pollMeshChatResponse(taskId, nodeName) {
    let attempts = 0
    const maxAttempts = 40 // 40 × 3s = 120s max (LLM can be slow)

    const poll = async () => {
        attempts++
        try {
            const res = await fetch(`/api/mesh/tasks/${taskId}`)
            const task = await res.json()

            if (task.status === 'done') {
                meshChatHistory[meshChatHistory.length - 1].content = task.result || '(keine Antwort)'
                renderMeshChat()
                loadMeshTasks()
                return
            }

            if (task.status === 'failed') {
                meshChatHistory[meshChatHistory.length - 1].content = `❌ ${task.result || 'LLM Fehler'}`
                renderMeshChat()
                loadMeshTasks()
                return
            }

            if (attempts >= maxAttempts) {
                meshChatHistory[meshChatHistory.length - 1].content = '⏰ Timeout — LLM hat zu lange gebraucht'
                renderMeshChat()
                return
            }

            meshChatHistory[meshChatHistory.length - 1].content = `⏳ Denkt nach... (${attempts * 3}s)`
            renderMeshChat()
            setTimeout(poll, 3000)
        } catch (err) {
            meshChatHistory[meshChatHistory.length - 1].content = `⚠️ ${err.message}`
            renderMeshChat()
        }
    }

    setTimeout(poll, 3000)
}

// ============================================
// Mesh Node Update
// ============================================

async function updateMeshNode() {
    const selector = document.getElementById('mesh-update-node')
    const statusEl = document.getElementById('mesh-update-status')
    const targetNode = selector?.value

    if (!targetNode) {
        alert('Bitte einen Node zum Update auswählen!')
        return
    }

    const nodeName = selector.selectedOptions[0]?.text || targetNode
    if (!confirm(`Node "${nodeName}" jetzt updaten?\nDer Node wird neu gestartet.`)) return

    statusEl.textContent = '⏳ Update wird gesendet...'
    statusEl.style.color = 'var(--accent-blue)'

    try {
        const res = await fetch('/api/mesh/update-node', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetNode })
        })
        const data = await res.json()

        if (!data.success) {
            statusEl.textContent = `❌ ${data.error || 'Update fehlgeschlagen'}`
            statusEl.style.color = '#f5576c'
            return
        }

        statusEl.textContent = `⏳ Task ${data.taskId} gesendet, Node zieht Update...`

        // Poll for completion
        let attempts = 0
        const poll = async () => {
            attempts++
            try {
                const taskRes = await fetch(`/api/mesh/tasks/${data.taskId}`)
                const task = await taskRes.json()

                if (task.status === 'done') {
                    statusEl.textContent = '✅ Update erfolgreich! Node startet neu...'
                    statusEl.style.color = '#00c853'
                    loadMeshTasks()
                    setTimeout(() => loadMeshNodes(), 30000)
                    return
                }
                if (task.status === 'failed') {
                    statusEl.textContent = `❌ Fehler: ${(task.result || '').slice(0, 100)}`
                    statusEl.style.color = '#f5576c'
                    loadMeshTasks()
                    return
                }
                if (attempts > 20) {
                    statusEl.textContent = '⏰ Timeout'
                    statusEl.style.color = '#ff9800'
                    return
                }

                statusEl.textContent = `⏳ Update läuft... (${attempts * 5}s)`
                setTimeout(poll, 5000)
            } catch (err) {
                statusEl.textContent = `⚠️ ${err.message}`
                statusEl.style.color = '#ff9800'
            }
        }
        setTimeout(poll, 5000)
    } catch (err) {
        statusEl.textContent = `❌ Fehler: ${err.message}`
        statusEl.style.color = '#f5576c'
    }
}

// ============================================
// Models Tab — capability probe + perf
// ============================================

async function loadModels(forceProbe = false) {
    const list = document.getElementById('models-list')
    if (!list) return
    if (forceProbe) list.innerHTML = '<div class="empty-state">⏳ Probing endpoints...</div>'

    try {
        const res = await fetch(`/api/models${forceProbe ? '?probe=1' : ''}`)
        const data = await res.json()
        renderModels(data)
    } catch (err) {
        list.innerHTML = `<div class="empty-state">Error: ${escapeHtml(String(err))}</div>`
    }
}

function renderModels(data) {
    const list = document.getElementById('models-list')
    const perfList = document.getElementById('perf-list')
    const disabledList = document.getElementById('disabled-models-list')

    const results = data.probeResults || []

    // Update overview counters
    const onlineCount = results.filter(r => r.online).length
    const onlineEl = document.getElementById('llm-online-count')
    if (onlineEl) onlineEl.textContent = onlineCount

    if (!list) return

    if (results.length === 0) {
        list.innerHTML = '<div class="empty-state">No probe data yet. Click "🔄 Probe Now" to test endpoints.</div>'
    } else {
        const online = results.filter(r => r.online)
        const offline = results.filter(r => !r.online)

        list.innerHTML = [...online, ...offline].map(r => `
            <div class="model-card ${r.online ? 'online' : 'offline'}">
                <span style="font-size:18px">${r.online ? '🟢' : '🔴'}</span>
                <div style="flex:1;min-width:0">
                    <div class="model-card-name">${escapeHtml(r.model)}</div>
                    <div class="model-card-endpoint">${escapeHtml(r.endpoint)}</div>
                </div>
                <div class="model-card-meta">
                    ${r.online && r.avgLatencyMs ? `<div style="color:var(--accent-green)">${r.avgLatencyMs}ms</div>` : ''}
                    ${r.supportsTools ? '<div>🔧 tools</div>' : ''}
                    ${r.error ? `<div style="color:var(--accent-red)">${escapeHtml(r.error.slice(0, 40))}</div>` : ''}
                </div>
            </div>
        `).join('')
    }

    if (perfList) {
        perfList.innerHTML = data.perfSummary
            ? `<pre style="white-space:pre-wrap;font-size:12px;color:var(--text-secondary);margin:0">${escapeHtml(data.perfSummary)}</pre>`
            : '<div class="empty-state">No performance data yet — models need to be called first.</div>'
    }

    if (disabledList) {
        const disabled = data.disabledModels || []
        if (disabled.length === 0) {
            disabledList.innerHTML = '<div class="empty-state">No disabled models ✅</div>'
        } else {
            disabledList.innerHTML = disabled.map(d => `
                <div class="model-card disabled">
                    <span style="font-size:18px">🚫</span>
                    <div style="flex:1;min-width:0">
                        <div class="model-card-name">${escapeHtml(d.model)}</div>
                        <div class="model-card-endpoint">${escapeHtml(d.reason)}</div>
                    </div>
                    <div class="model-card-meta" style="color:var(--accent-yellow)">
                        Re-enables<br>${new Date(d.disabledUntil).toLocaleTimeString()}
                    </div>
                </div>
            `).join('')
        }
        // Update disabled counter in overview
        const disabledCountEl = document.getElementById('llm-disabled-count')
        if (disabledCountEl) disabledCountEl.textContent = disabled.length
    }
}

// ============================================
// Queue Stats (Overview)
// ============================================

async function loadQueueStats() {
    try {
        const res = await fetch('/api/queue')
        const data = await res.json()

        const pendingEl = document.getElementById('queue-pending-count')
        const doneEl = document.getElementById('queue-done-count')
        const disabledEl = document.getElementById('llm-disabled-count')

        if (pendingEl) pendingEl.textContent = data.pending || 0
        if (doneEl) doneEl.textContent = data.done || 0
        if (disabledEl && data.disabledModels !== undefined) disabledEl.textContent = data.disabledModels

        // Color pending red if > 0
        if (pendingEl) pendingEl.style.color = (data.pending || 0) > 0 ? 'var(--accent-yellow)' : ''
        // Color disabled red if > 0
        if (disabledEl) disabledEl.style.color = (data.disabledModels || 0) > 0 ? 'var(--accent-yellow)' : ''
    } catch { /* optional */ }
}

// ============================================
// Health Tab — Self-Doctor
// ============================================

async function runDoctor() {
    const output = document.getElementById('doctor-output')
    if (output) {
        output.textContent = '⏳ Running self-doctor...'
        output.style.color = 'var(--text-secondary)'
    }
    try {
        const res = await fetch('/api/doctor', { method: 'POST' })
        const data = await res.json()
        if (output) {
            output.textContent = data.summary || JSON.stringify(data, null, 2)
            output.style.color = data.healthy ? 'var(--accent-green)' : 'var(--accent-yellow)'
        }
    } catch (err) {
        if (output) {
            output.textContent = `Error: ${err.message}`
            output.style.color = 'var(--accent-red)'
        }
    }
}

window.runDoctor = runDoctor
window.loadModels = loadModels

// ============================================
// Node Topology
// ============================================

const TIER_COLORS = {
    nano: '#60a5fa',    // blue
    small: '#4ade80',   // green
    medium: '#facc15',  // yellow
    large: '#fb923c',   // orange
    xlarge: '#f87171',  // red
    unknown: '#94a3b8', // gray
}

async function loadTopology(forceScan = false) {
    const grid = document.getElementById('topology-grid')
    const statsEl = document.getElementById('topology-stats')
    const select = document.getElementById('recommend-node-select')
    if (!grid) return

    grid.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:16px">Lade Topologie...</div>'
    void loadInfrastructureServices()

    try {
        const url = forceScan ? '/api/nodes/topology?scan=1' : '/api/nodes/topology'
        const res = await fetch(url)
        const data = await res.json()

        if (statsEl) {
            statsEl.innerHTML = `
                <div class="stat-chip">🌐 ${data.onlineNodes || 0} Nodes online</div>
                <div class="stat-chip">🤖 ${data.totalModels || 0} Modelle gesamt</div>
                ${data.lastScan ? `<div class="stat-chip" style="font-size:11px">Scan: ${new Date(data.lastScan).toLocaleTimeString('de-DE')}</div>` : ''}
            `
        }

        const topology = data.topology || []

        // Update node selector for recommendations
        if (select) {
            const currentOptions = new Set(['local'])
            select.innerHTML = '<option value="local">local (dieser Node)</option>'
            for (const node of topology) {
                if (!currentOptions.has(node.name)) {
                    currentOptions.add(node.name)
                    const opt = document.createElement('option')
                    opt.value = node.name
                    opt.textContent = `${node.name}${node.isLocal ? ' (lokal)' : ''} — ${node.models?.length || 0} Modelle`
                    select.appendChild(opt)
                }
            }
        }

        if (topology.length === 0) {
            grid.innerHTML = '<div style="color:var(--text-secondary);font-size:13px;padding:16px">Keine Nodes im Mesh. Nutze <code>/nodes check &lt;ip&gt;</code> um Hosts zu entdecken.</div>'
            return
        }

        grid.innerHTML = topology.map(node => {
            const statusColor = node.status === 'online' ? 'var(--accent-green)' : node.status === 'busy' ? '#facc15' : 'var(--accent-red)'
            const statusIcon = node.status === 'online' ? '🟢' : node.status === 'busy' ? '🟡' : '🔴'
            const tier = node.tier || 'unknown'
            const tierColor = TIER_COLORS[tier] || TIER_COLORS.unknown
            const hwStr = node.hardware
                ? `${node.hardware.ramGb}GB RAM${node.hardware.vramGb ? ` + ${node.hardware.vramGb}GB VRAM` : ''}${node.hardware.gpu ? ` · ${node.hardware.gpu}` : ''}`
                : 'Hardware unbekannt'

            const modelsHtml = (node.models || []).map(m => {
                const isDeprecated = node.deprecatedModels?.includes(m)
                return `<span class="model-tag${isDeprecated ? ' deprecated' : ''}" title="${isDeprecated ? 'Veraltet — Update empfohlen' : m}">${m.length > 25 ? m.slice(0, 22) + '...' : m}${isDeprecated ? ' ⚠️' : ''}</span>`
            }).join('')

            return `
                <div class="node-card${node.isLocal ? ' local-node' : ''}">
                    <div class="node-card-header">
                        <span class="node-status-dot" style="color:${statusColor}">${statusIcon}</span>
                        <span class="node-name">${escapeHtml(node.name)}${node.isLocal ? ' <em>(local)</em>' : ''}</span>
                        <span class="node-tier-badge" style="background:${tierColor}22;color:${tierColor};border:1px solid ${tierColor}44">${tier}</span>
                        <button onclick="loadRecommendations('${escapeHtml(node.name)}')" style="margin-left:auto;padding:3px 8px;font-size:11px;border-radius:4px;border:1px solid var(--accent-blue);background:transparent;color:var(--accent-blue);cursor:pointer;">Empfehlen</button>
                    </div>
                    <div class="node-hw">${escapeHtml(hwStr)}</div>
                    <div class="node-models">
                        ${node.models?.length > 0
                            ? modelsHtml
                            : '<span style="color:var(--text-secondary);font-size:12px;font-style:italic">Keine Modelle</span>'
                        }
                    </div>
                    ${node.deprecatedModels?.length > 0
                        ? `<div style="font-size:11px;color:#fb923c;margin-top:6px">⚠️ ${node.deprecatedModels.length} veraltete Modell(e)</div>`
                        : ''
                    }
                </div>
            `
        }).join('')

    } catch (err) {
        grid.innerHTML = `<div style="color:var(--accent-red);padding:12px">Fehler: ${err.message}</div>`
    }
}

async function loadInfrastructureServices() {
    const container = document.getElementById('infrastructure-services')
    if (!container) return
    try {
        const res = await fetch('/api/mesh/services')
        const data = await res.json()
        container.textContent = data.report || data.error || 'Keine Infrastruktur-Services erkannt.'
    } catch (err) {
        container.textContent = `Service-Status nicht verfügbar: ${err.message}`
    }
}

async function loadRecommendations(nodeName) {
    const select = document.getElementById('recommend-node-select')
    const output = document.getElementById('recommendations-output')
    if (!output) return

    const name = nodeName || select?.value || 'local'
    output.innerHTML = '<div style="color:var(--text-secondary);font-size:13px">Lade Empfehlungen...</div>'

    try {
        const res = await fetch(`/api/nodes/recommend/${encodeURIComponent(name)}`)
        const data = await res.json()

        if (data.error) {
            output.innerHTML = `<div style="color:var(--accent-red)">${escapeHtml(data.error)}</div>`
            return
        }

        const tierColors = TIER_COLORS
        const tier = data.tier || 'unknown'
        const tierColor = tierColors[tier] || tierColors.unknown
        const hw = data.hardware || {}

        let html = `
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
                <span style="padding:4px 10px;border-radius:12px;background:${tierColor}22;color:${tierColor};border:1px solid ${tierColor}44;font-size:12px;font-weight:600">${tier.toUpperCase()}</span>
                <span style="font-size:12px;color:var(--text-secondary)">${hw.ramGb || '?'}GB RAM${hw.vramGb ? ` + ${hw.vramGb}GB VRAM` : ''}${hw.hasGpu ? ` (${hw.gpuType || 'GPU'})` : ''}</span>
                <span style="font-size:11px;color:var(--text-secondary)">${data.listAge || ''}</span>
            </div>
        `

        if (data.recommended?.length > 0) {
            html += '<div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-primary)">📦 Empfohlene Modelle</div>'
            html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">'
            for (const m of data.recommended) {
                const installed = data.alreadyInstalled?.some(i => i === m.model || i.startsWith(m.family + ':'))
                const typeColors = { chat: '#4ade80', reasoning: '#60a5fa', code: '#a78bfa', vision: '#fb923c', embedding: '#94a3b8' }
                const typeColor = typeColors[m.type] || '#94a3b8'
                html += `
                    <div style="display:flex;gap:10px;align-items:flex-start;padding:8px;background:var(--bg-tertiary);border-radius:6px;border-left:3px solid ${installed ? 'var(--accent-green)' : 'var(--border-color)'}">
                        <span style="font-size:14px">${installed ? '✅' : '⬇️'}</span>
                        <div style="flex:1;min-width:0">
                            <div style="font-size:13px;font-weight:500;color:var(--text-primary)">${escapeHtml(m.model)}</div>
                            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${escapeHtml(m.description)}</div>
                        </div>
                        <span style="padding:2px 6px;border-radius:4px;background:${typeColor}22;color:${typeColor};font-size:10px;white-space:nowrap">${m.type}</span>
                    </div>
                `
            }
            html += '</div>'
        }

        if (data.toInstall?.length > 0) {
            html += '<div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-primary)">⬇️ Noch zu installieren</div>'
            html += `<pre style="background:var(--bg-tertiary);padding:10px;border-radius:6px;font-size:12px;overflow-x:auto;color:var(--text-primary)">${escapeHtml(data.pullCommands.join('\n'))}</pre>`
        }

        if (data.deprecated?.length > 0) {
            html += `<div style="font-size:12px;color:#fb923c;margin-top:8px">⚠️ Veraltete Modelle: ${data.deprecated.map(m => `<code>${escapeHtml(m)}</code>`).join(', ')}</div>`
        }

        output.innerHTML = html

    } catch (err) {
        output.innerHTML = `<div style="color:var(--accent-red)">Fehler: ${escapeHtml(err.message)}</div>`
    }
}

window.loadTopology = loadTopology
window.loadRecommendations = loadRecommendations

// ============================================
// Memory Sub-tab switching
// ============================================

function setupMemorySubTabs() {
    const subTabBar = document.getElementById('memory-sub-tabs')
    if (!subTabBar) return

    subTabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.sub-tab-btn')
        if (!btn) return

        const targetId = btn.dataset.subtab

        // Update buttons
        subTabBar.querySelectorAll('.sub-tab-btn').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')

        // Show/hide content
        document.querySelectorAll('.sub-tab-content').forEach(el => {
            el.classList.remove('active')
            el.style.display = 'none'
        })
        const target = document.getElementById(`subtab-${targetId}`)
        if (target) {
            target.classList.add('active')
            target.style.display = 'block'
        }

        // Load data for sub-tab
        switch (targetId) {
            case 'memories': loadMemory(); break
            case 'core-facts': loadCoreFacts(); break
            case 'cold-storage': loadColdStorage(); break
            case 'summaries': loadSummaries(); break
            case 'graph': loadGraph(); break
            case 'journal': loadJournal(); break
        }
    })
}

// ============================================
// ROI Dashboard
// ============================================

async function loadROI() {
    try {
        const res = await fetch('/api/roi')
        const data = await res.json()

        // Stats cards
        const costEl = document.getElementById('roi-total-cost')
        const valueEl = document.getElementById('roi-total-value')
        const roiEl = document.getElementById('roi-percentage')
        const tasksEl = document.getElementById('roi-total-tasks')

        if (costEl) costEl.textContent = `$${(data.totalCost || 0).toFixed(4)}`
        if (valueEl) valueEl.textContent = `$${(data.totalValue || 0).toFixed(2)}`
        if (roiEl) {
            const pct = data.totalCost > 0 ? ((data.totalValue / data.totalCost - 1) * 100).toFixed(0) : '--'
            roiEl.textContent = pct === '--' ? '--' : `${pct}%`
            roiEl.style.color = pct > 0 ? '#3fb950' : pct < 0 ? '#f85149' : ''
        }
        if (tasksEl) tasksEl.textContent = data.totalTasks || 0

        // Daily breakdown
        const dailyEl = document.getElementById('roi-daily')
        if (dailyEl && data.daily) {
            dailyEl.innerHTML = Object.entries(data.daily)
                .sort(([a], [b]) => b.localeCompare(a))
                .slice(0, 14)
                .map(([date, d]) => `
                    <div style="display: flex; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid var(--border-color);">
                        <span>${date}</span>
                        <span>💸 $${(d.cost || 0).toFixed(4)}</span>
                        <span>💎 $${(d.value || 0).toFixed(2)}</span>
                        <span>${d.tasks || 0} tasks</span>
                    </div>
                `).join('')
        }

        // Recent tasks
        const tasksListEl = document.getElementById('roi-tasks')
        if (tasksListEl && data.recentTasks) {
            tasksListEl.innerHTML = data.recentTasks.slice(0, 20).map(t => `
                <div style="display: flex; justify-content: space-between; padding: 8px; border-bottom: 1px solid var(--border-color); font-size: 13px;">
                    <div style="flex: 1;">
                        <div style="font-weight: 500;">${escapeHtml((t.description || t.task || '').slice(0, 60))}</div>
                        <div style="font-size: 11px; color: var(--text-secondary);">${t.category || '?'} · ${t.durationMs ? (t.durationMs / 1000).toFixed(1) + 's' : '?'}</div>
                    </div>
                    <span style="color: var(--accent-blue);">$${(t.cost || 0).toFixed(4)}</span>
                </div>
            `).join('')
        }
    } catch (err) {
        console.error('Failed to load ROI:', err)
    }
}


// ============================================================
// NovaOS-Bedienmodus
// ============================================================
// Dieselbe Wahl wie in der Textkonsole und in Nova Desktop:
// /etc/novaos/modus, geliefert von /api/desktop/bootstrap.
// Ohne das zeigt das Dashboard jemandem ohne Technikhintergrund
// Knoten-IDs, Modell-Routen und Rohdaten, mit denen er nichts
// anfangen kann.
(async function novaosBedienmodus() {
    try {
        const antwort = await fetch('/api/desktop/bootstrap');
        if (!antwort.ok) return;
        const daten = await antwort.json();
        const novaos = daten && daten.novaos;
        if (!novaos || !novaos.istNovaOS) return;
        const wurzel = document.documentElement;
        wurzel.classList.add('novaos');
        wurzel.classList.toggle('novaos-standard', novaos.modus !== 'experte');
        wurzel.classList.toggle('novaos-experte', novaos.modus === 'experte');
    } catch (fehler) {
        // Kein NovaOS oder API nicht erreichbar — Dashboard bleibt wie bisher
    }
})();
