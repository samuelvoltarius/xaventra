/**
 * Nova Boot Sequence - Stage 2: Self-Provisioning
 * 
 * This runs after genesis.sh and handles:
 * 1. Environment detection
 * 2. Missing dependency installation
 * 3. Security hardening (via L15)
 * 4. Supervisor startup
 * 
 * Nova "grows" her missing organs (Vision, Docker, etc.)
 */

import { execSync, exec } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { platform } from 'node:os'
import { resolveConfigPath } from './config/config-path.js'
import { join } from 'node:path'


// ============================================
// Types
// ============================================

interface BootStatus {
    stage: 'checking' | 'installing' | 'securing' | 'starting' | 'ready' | 'failed'
    missingDependencies: string[]
    installedDependencies: string[]
    securityIssues: string[]
    errors: string[]
}

interface DependencyCheck {
    name: string
    command: string
    installer: () => Promise<void>
    required: boolean
    layer: string
}

// ============================================
// Boot Sequence
// ============================================

class NovaBoot {
    private status: BootStatus = {
        stage: 'checking',
        missingDependencies: [],
        installedDependencies: [],
        securityIssues: [],
        errors: [],
    }

    private isGenesis: boolean = false
    private isRoot: boolean = false

    constructor() {
        this.isGenesis = process.argv.includes('--genesis')
        this.isRoot = process.getuid?.() === 0 || false

        console.log(`
╔═══════════════════════════════════════════════╗
║           NOVA BOOT SEQUENCE v2.0             ║
║            Stage 2: Self-Provisioning         ║
╚═══════════════════════════════════════════════╝
`)
        console.log(`🔍 Mode: ${this.isGenesis ? 'GENESIS (first boot)' : 'NORMAL'}`)
        console.log(`🔐 Root: ${this.isRoot ? 'YES' : 'NO (limited self-repair)'}`)
        console.log('')
    }

    async boot(): Promise<void> {
        try {
            // Stage 2A: Check Environment
            await this.checkEnvironment()

            // Stage 2B: Install Missing Dependencies (if root)
            if (this.status.missingDependencies.length > 0 && this.isRoot) {
                await this.installDependencies()
            }

            // Stage 2C: Security Hardening (Genesis mode)
            if (this.isGenesis) {
                await this.securityHardening()
            }

            // Stage 2D: Nova Doctor Model Setup
            await this.setupDoctorModel()

            // Stage 2E: Verify System Integrity
            await this.verifyIntegrity()

            // Stage 2F: Start Supervisor
            await this.startSupervisor()

        } catch (err) {
            console.error('❌ Boot sequence failed:', err)
            this.status.stage = 'failed'
            this.status.errors.push(String(err))
            process.exit(1)
        }
    }

    // ============================================
    // Stage 2A: Environment Check
    // ============================================

    private async checkEnvironment(): Promise<void> {
        console.log('🔍 Stage 2A: Checking environment...')
        this.status.stage = 'checking'

        const dependencies: DependencyCheck[] = [
            {
                name: 'playwright',
                command: 'npx playwright --version',
                installer: this.installPlaywright.bind(this),
                required: false,
                layer: 'L10 Vision',
            },
            {
                name: 'docker',
                command: 'docker --version',
                installer: this.installDocker.bind(this),
                required: false,
                layer: 'DevOps',
            },
            {
                name: 'pm2',
                command: 'pm2 --version',
                installer: this.installPM2.bind(this),
                required: true,
                layer: 'Process Manager',
            },
            {
                name: 'git',
                command: 'git --version',
                installer: async () => { },  // Should be installed by genesis
                required: true,
                layer: 'Core',
            },
        ]

        for (const dep of dependencies) {
            const exists = this.checkCommand(dep.command)

            if (exists) {
                console.log(`  ✅ ${dep.name} (${dep.layer})`)
            } else {
                console.log(`  ❌ ${dep.name} (${dep.layer}) - MISSING`)
                this.status.missingDependencies.push(dep.name)
            }
        }

        console.log('')
    }

    private checkCommand(command: string): boolean {
        try {
            execSync(command, { stdio: 'pipe' })
            return true
        } catch {
            return false
        }
    }

    // ============================================
    // Stage 2B: Install Dependencies
    // ============================================

    private async installDependencies(): Promise<void> {
        console.log('🔧 Stage 2B: Installing missing dependencies...')
        this.status.stage = 'installing'

        for (const dep of this.status.missingDependencies) {
            try {
                console.log(`  📦 Installing ${dep}...`)

                switch (dep) {
                    case 'playwright':
                        await this.installPlaywright()
                        break
                    case 'docker':
                        await this.installDocker()
                        break
                    case 'pm2':
                        await this.installPM2()
                        break
                }

                this.status.installedDependencies.push(dep)
                console.log(`  ✅ ${dep} installed`)
            } catch (err) {
                console.error(`  ❌ Failed to install ${dep}: ${err}`)
                this.status.errors.push(`Install ${dep}: ${err}`)
            }
        }

        console.log('')
    }

    private async installPlaywright(): Promise<void> {
        execSync('npm install playwright', { stdio: 'pipe', cwd: process.cwd() })
        execSync('npx playwright install chromium', { stdio: 'pipe' })
    }

    private async installDocker(): Promise<void> {
        const os = platform()

        if (os === 'linux') {
            // Docker official install script
            execSync('curl -fsSL https://get.docker.com | sh', { stdio: 'pipe' })
            execSync('systemctl enable docker', { stdio: 'pipe' })
            execSync('systemctl start docker', { stdio: 'pipe' })
        } else {
            console.log('  ⚠️ Docker auto-install only supported on Linux')
        }
    }

    private async installPM2(): Promise<void> {
        execSync('npm install -g pm2', { stdio: 'pipe' })
    }

    // ============================================
    // Stage 2C: Security Hardening (Genesis)
    // ============================================

    private async securityHardening(): Promise<void> {
        console.log('🔒 Stage 2C: Security hardening...')
        this.status.stage = 'securing'

        const checks = [
            this.checkSSHSecurity,
            this.checkFirewall,
            this.checkOpenPorts,
        ]

        for (const check of checks) {
            try {
                await check.call(this)
            } catch (err) {
                console.error(`  ⚠️ Security check failed: ${err}`)
            }
        }

        // Run L15 Security Scanner on self
        try {
            console.log('  🔍 Running L15 Security Scanner...')
            const { getSecurityScanner } = await import('./layers/L15-security-scanner.js')
            const scanner = getSecurityScanner()
            const result = await scanner.scanDirectory(process.cwd())

            if (result.summary.critical > 0) {
                console.log(`  ⚠️ Found ${result.summary.critical} critical security issues!`)
                this.status.securityIssues.push(...result.issues.map(i => i.description))
            } else {
                console.log('  ✅ No critical security issues found')
            }
        } catch (err) {
            console.log('  ⚠️ L15 not available yet (first boot)')
        }

        console.log('')
    }

    private async checkSSHSecurity(): Promise<void> {
        const sshConfig = '/etc/ssh/sshd_config'

        if (!existsSync(sshConfig)) {
            console.log('  ⏭️ SSH not installed')
            return
        }

        const config = readFileSync(sshConfig, 'utf-8')

        // Check for password auth
        if (config.includes('PasswordAuthentication yes')) {
            console.log('  ⚠️ SSH: Password auth enabled (consider key-only)')
            this.status.securityIssues.push('SSH password auth enabled')
        } else {
            console.log('  ✅ SSH: Key-only auth')
        }

        // Check root login
        if (config.includes('PermitRootLogin yes')) {
            console.log('  ⚠️ SSH: Root login enabled')
            this.status.securityIssues.push('SSH root login enabled')
        } else {
            console.log('  ✅ SSH: Root login disabled')
        }
    }

    private async checkFirewall(): Promise<void> {
        const hasUfw = this.checkCommand('ufw status')
        const hasFirewalld = this.checkCommand('firewall-cmd --state')

        if (!hasUfw && !hasFirewalld) {
            console.log('  ⚠️ No firewall detected!')
            this.status.securityIssues.push('No firewall installed')

            // Auto-install UFW if root
            if (this.isRoot && platform() === 'linux') {
                console.log('  🔧 Installing UFW...')
                try {
                    execSync('apt-get install -y ufw && ufw default deny incoming && ufw default allow outgoing && ufw allow ssh && ufw --force enable', { stdio: 'pipe' })
                    console.log('  ✅ UFW installed and configured')
                } catch {
                    console.log('  ❌ UFW install failed')
                }
            }
        } else {
            console.log('  ✅ Firewall active')
        }
    }

    private async checkOpenPorts(): Promise<void> {
        try {
            const output = execSync('ss -tuln 2>/dev/null || netstat -tuln', { encoding: 'utf-8' })

            // Check for common dangerous ports
            const dangerousPorts = ['3306', '5432', '27017', '6379']  // MySQL, Postgres, MongoDB, Redis

            for (const port of dangerousPorts) {
                if (output.includes(`:${port}`)) {
                    console.log(`  ⚠️ Port ${port} is exposed (bind to localhost!)`)
                    this.status.securityIssues.push(`Port ${port} exposed`)
                }
            }
        } catch {
            console.log('  ⏭️ Port check skipped')
        }
    }

    // ============================================
    // Stage 2D: Nova Doctor Model Setup
    // ============================================

    private async setupDoctorModel(): Promise<void> {
        const { selectBestModel, downloadBestModel } = await import('./llm/download-models.js')
        const { selectInstalledModel, getDoctorModelsDir, verifyDoctorArtifact } = await import('./llm/doctor-artifacts.js')
        const installed = selectInstalledModel()
        if (installed) {
            try {
                await verifyDoctorArtifact(join(getDoctorModelsDir(), installed.filename), installed)
                console.log(`🏥 Doctor artifact verified: ${installed.filename} (not yet loaded)`)
                return
            } catch { console.warn('🏥 Doctor artifact failed integrity verification; not usable') }
        }

        const best = selectBestModel()
        if (!best) {
            console.log('🏥 Nova Doctor: no suitable model for this hardware — skipping')
            return
        }

        // In genesis mode: always download
        // In normal mode: only download if --download-models flag set
        const shouldDownload = this.isGenesis || process.argv.includes('--download-models')

        if (!shouldDownload) {
            console.log(`🏥 Nova Doctor: model not installed (${best.filename}, ${best.sizeMB} MB)`)
            console.log('   Run: nova-boot --download-models   to download automatically')
            console.log('   Or:  npm run doctor:download        to download now')
            return
        }

        console.log('🏥 Stage 2D: Downloading Nova Doctor model...')
        await downloadBestModel((msg) => console.log(msg))
    }

    // ============================================
    // Stage 2E: Verify Integrity
    // ============================================

    private async verifyIntegrity(): Promise<void> {
        console.log('🔍 Stage 2E: Verifying system integrity...')

        // Check config
        if (!existsSync(resolveConfigPath())) {
            throw new Error('xaventra.config.json not found!')
        }

        const config = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'))

        // Check API key
        const hasApiKey = config.llm?.apiKey ||
            process.env.OPENAI_API_KEY ||
            false
        if (!hasApiKey) {
            console.log('  ⚠️ No API key configured!')
            console.log('     Set OPENAI_API_KEY env var or add to xaventra.config.json')
            console.log('     Set OPENAI_API_KEY env var or add to xaventra.config.json')
        } else {
            console.log('  ✅ API key configured')
        }

        // Check L13 AST for self-consistency
        try {
            console.log('  🔍 Running L13 dependency check...')
            const { getASTAnalyzer } = await import('./layers/L13-ast-analyzer.js')
            const ast = getASTAnalyzer()
            await ast.buildRepoMap()
            console.log('  ✅ Dependency graph built')
        } catch {
            console.log('  ⏭️ L13 not available yet')
        }

        console.log('')
    }

    // ============================================
    // Stage 2E: Start Supervisor
    // ============================================

    private async startSupervisor(): Promise<void> {
        console.log('🚀 Stage 2E: Starting Nova Supervisor...')
        this.status.stage = 'starting'

        // Print summary
        console.log('')
        console.log('╔═══════════════════════════════════════╗')
        console.log('║        BOOT SEQUENCE COMPLETE         ║')
        console.log('╚═══════════════════════════════════════╝')
        console.log('')
        console.log(`📦 Installed: ${this.status.installedDependencies.join(', ') || 'none'}`)
        console.log(`⚠️ Warnings: ${this.status.securityIssues.length}`)
        console.log(`❌ Errors: ${this.status.errors.length}`)
        console.log('')

        // Start the main daemon
        try {
            // Import and run daemon directly
            this.status.stage = 'ready'
            console.log('🧠 Nova is now ALIVE!')
            console.log('')

            // Dynamic import of daemon entry point
            await import('./daemon.js')
        } catch (err) {
            console.error('❌ Failed to start daemon:', err)
            throw err
        }
    }
}

// ============================================
// Entry Point
// ============================================

const boot = new NovaBoot()
boot.boot().catch(err => {
    console.error('💀 FATAL:', err)
    process.exit(1)
})
