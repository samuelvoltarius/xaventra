import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { TelegramAdapter } from '../dist/channels/telegram.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const authority = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2))
    renameSync(temporary, file)
}

async function child() {
    const root = process.env.XAVENTRA_TELEGRAM_HANDOFF_ROOT
    const nodeId = process.env.XAVENTRA_TELEGRAM_HANDOFF_NODE
    const mode = process.env.XAVENTRA_TELEGRAM_HANDOFF_MODE
    assert.ok(root && nodeId && mode)
    const authorityFile = join(root, 'authority.json')
    const auditFile = join(root, 'effects.jsonl')
    const verifyAuthority = async () => authority(authorityFile).owner === nodeId
    const adapter = new TelegramAdapter({ token: 'disposable-fixture', verifyAuthority })
    let pipelineCalls = 0
    adapter.onMessage(async () => { pipelineCalls++ })
    const rawBot = {
        sendMessage: async (_chat, content) => {
            appendFileSync(auditFile, JSON.stringify({ nodeId, content }) + '\n')
            return { message_id: 1 }
        },
        sendChatAction: async () => undefined,
        setMessageReaction: async () => undefined,
        stopPolling: async () => undefined,
    }
    const guardedBot = adapter.guardBotEffects(rawBot)
    adapter.bot = guardedBot

    if (mode === 'predecessor') {
        await adapter.send({ to: 'chat', content: 'before-takeover' })
        writeJson(join(root, 'predecessor-ready.json'), { ready: true })
        const deadline = Date.now() + 15_000
        while (authority(authorityFile).owner === nodeId && Date.now() < deadline) await sleep(25)
        assert.notEqual(authority(authorityFile).owner, nodeId, 'takeover was not observed')
        let adapterRejected = false, directRejected = false
        try { await adapter.send({ to: 'chat', content: 'stale-adapter-effect' }) } catch { adapterRejected = true }
        try { await guardedBot.sendMessage('chat', 'stale-direct-effect') } catch { directRejected = true }
        await adapter.handleMessage({ message_id: 2, date: 1, text: 'stale update', chat: { id: 42, type: 'private' }, from: { id: 9 } })
        writeJson(join(root, 'predecessor-result.json'), { adapterRejected, directRejected, pipelineCalls })
    } else {
        assert.equal(authority(authorityFile).owner, nodeId)
        await adapter.send({ to: 'chat', content: 'after-takeover' })
        await adapter.handleMessage({ message_id: 3, date: 1, text: 'fresh update', chat: { id: 42, type: 'private' }, from: { id: 9 } })
        writeJson(join(root, 'successor-result.json'), { pipelineCalls })
    }
}

function runNode(root, nodeId, mode) {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [process.argv[1]], {
            env: { ...process.env, XAVENTRA_TELEGRAM_HANDOFF_CHILD: '1', XAVENTRA_TELEGRAM_HANDOFF_ROOT: root,
                XAVENTRA_TELEGRAM_HANDOFF_NODE: nodeId, XAVENTRA_TELEGRAM_HANDOFF_MODE: mode },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = ''
        proc.stdout.on('data', chunk => { stdout += chunk })
        proc.stderr.on('data', chunk => { stderr += chunk })
        proc.on('error', reject)
        proc.on('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(Error(`${nodeId}/${mode} exited ${code}: ${stdout}\n${stderr}`)))
    })
}

async function parent() {
    const root = resolve(process.env.XAVENTRA_TELEGRAM_HANDOFF_QA_DIR || mkdtempSync(join(tmpdir(), 'xaventra-telegram-handoff-')))
    mkdirSync(root, { recursive: true })
    writeJson(join(root, 'authority.json'), { owner: 'node-a', epoch: 1 })
    writeFileSync(join(root, 'effects.jsonl'), '')
    const predecessor = runNode(root, 'node-a', 'predecessor')
    const deadline = Date.now() + 15_000
    while (!existsSync(join(root, 'predecessor-ready.json')) && Date.now() < deadline) await sleep(25)
    assert.ok(existsSync(join(root, 'predecessor-ready.json')), 'predecessor did not become ready')
    writeJson(join(root, 'authority.json'), { owner: 'node-b', epoch: 2 })
    const successor = runNode(root, 'node-b', 'successor')
    await Promise.all([predecessor, successor])

    const oldResult = JSON.parse(readFileSync(join(root, 'predecessor-result.json'), 'utf8'))
    const newResult = JSON.parse(readFileSync(join(root, 'successor-result.json'), 'utf8'))
    const effects = readFileSync(join(root, 'effects.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    const checks = [
        { id: 'predecessor-adapter-effect-fenced', passed: oldResult.adapterRejected === true },
        { id: 'legacy-direct-bot-effect-fenced', passed: oldResult.directRejected === true },
        { id: 'stale-inbound-update-dropped', passed: oldResult.pipelineCalls === 0 },
        { id: 'successor-inbound-update-admitted', passed: newResult.pipelineCalls === 1 },
        { id: 'exactly-one-owner-before-and-after', passed: JSON.stringify(effects) === JSON.stringify([
            { nodeId: 'node-a', content: 'before-takeover' },
            { nodeId: 'node-b', content: 'after-takeover' },
        ]) },
    ]
    const report = { sourceRevision: process.env.GITHUB_SHA || 'local', evidenceClass: 'two-real-node-processes-file-authority-and-fake-Telegram-transport-not-physical-host-or-live-Telegram', checks }
    writeJson(join(root, 'report.json'), report)
    console.log(JSON.stringify(report, null, 2))
    if (checks.some(check => !check.passed)) process.exitCode = 1
}

if (process.env.XAVENTRA_TELEGRAM_HANDOFF_CHILD === '1') await child()
else await parent()
