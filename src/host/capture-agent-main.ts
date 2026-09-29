import { listenCaptureAgent } from './capture-agent.js'

if (process.argv.length !== 4) throw Error('Usage: capture-agent-main <local-socket> <private-token-file>')
const server = listenCaptureAgent(process.argv[2], process.argv[3])
server.on('error', () => { console.error('Capture adapter startup failed'); process.exitCode = 1 })
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)))
