/**
 * Nova Auth Setup
 * 
 * Uses pi-coding-agent's OAuth flow for authentication.
 * Run: npm run nova:auth
 */

import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const AUTH_DIR = '.nova-auth'
const PI_AUTH_FILE = join(AUTH_DIR, 'pi-auth.json')
const PI_AGENT_AUTH = join(process.env.USERPROFILE || process.env.HOME || '', '.pi', 'agent', 'auth.json')

async function main() {
    console.log('')
    console.log('╔═══════════════════════════════════════════════════════╗')
    console.log('║       Nova OAuth Setup                                ║')
    console.log('╚═══════════════════════════════════════════════════════╝')
    console.log('')

    // Check if pi-agent has auth
    if (existsSync(PI_AGENT_AUTH)) {
        console.log('✓ pi-agent Credentials gefunden!')
        console.log(`  ${PI_AGENT_AUTH}`)
        console.log('')

        // Copy to Nova
        if (!existsSync(AUTH_DIR)) {
            mkdirSync(AUTH_DIR, { recursive: true })
        }
        copyFileSync(PI_AGENT_AUTH, PI_AUTH_FILE)
        console.log(`✓ Kopiert nach: ${PI_AUTH_FILE}`)
        console.log('')
        console.log('Du kannst Nova jetzt starten: npm run nova')
        return
    }

    // No auth found - launch pi-agent for login
    console.log('Keine Credentials gefunden. Starte pi-agent Login...')
    console.log('')
    console.log('Tippe /login und wähle deinen Provider (z.B. local)')
    console.log('')

    const piCli = join('node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'cli.js')

    if (!existsSync(piCli)) {
        console.error('❌ pi-coding-agent nicht gefunden.')
        console.error('   Führe erst npm install aus.')
        process.exit(1)
    }

    // Spawn pi-agent interactively
    const child = spawn('node', [piCli], {
        stdio: 'inherit',
        shell: true,
        cwd: process.cwd(),
    })

    child.on('exit', (code) => {
        if (code === 0 && existsSync(PI_AGENT_AUTH)) {
            console.log('')
            console.log('✓ Login erfolgreich!')

            // Copy credentials
            if (!existsSync(AUTH_DIR)) {
                mkdirSync(AUTH_DIR, { recursive: true })
            }
            copyFileSync(PI_AGENT_AUTH, PI_AUTH_FILE)
            console.log(`✓ Credentials kopiert nach: ${PI_AUTH_FILE}`)
            console.log('')
            console.log('Starte Nova mit: npm run nova')
        }
    })
}

main().catch(console.error)
