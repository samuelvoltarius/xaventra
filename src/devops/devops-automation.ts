/**
 * DevOps Automation
 * 
 * Docker, deployment, and infrastructure automation.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'

// ============================================
// Types
// ============================================

export interface DeployConfig {
    name: string
    type: 'docker' | 'pm2' | 'systemd'
    port?: number
    env?: Record<string, string>
}

export interface ServiceStatus {
    name: string
    running: boolean
    uptime?: string
    cpu?: string
    memory?: string
}

// ============================================
// Docker
// ============================================

const DOCKERFILE_TEMPLATE = `FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY dist/ ./dist/
COPY config.json ./

# Environment
ENV NODE_ENV=production

# Start
CMD ["node", "dist/daemon.js"]
`

const DOCKER_COMPOSE_TEMPLATE = `version: '3.8'

services:
  nova:
    build: .
    container_name: nova-core
    restart: unless-stopped
    ports:
      - "\${PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./.nova-data:/app/.nova-data
      - ./.nova-memory:/app/.nova-memory
      - ./.nova-sessions:/app/.nova-sessions
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
`

/**
 * Generate Dockerfile
 */
export function generateDockerfile(targetDir: string = '.'): string {
    const path = join(targetDir, 'Dockerfile')
    writeFileSync(path, DOCKERFILE_TEMPLATE)
    console.log(`[DevOps] Generated Dockerfile at ${path}`)
    return path
}

/**
 * Generate docker-compose.yml
 */
export function generateDockerCompose(targetDir: string = '.'): string {
    const path = join(targetDir, 'docker-compose.yml')
    writeFileSync(path, DOCKER_COMPOSE_TEMPLATE)
    console.log(`[DevOps] Generated docker-compose.yml at ${path}`)
    return path
}

/**
 * Build Docker image
 */
export function dockerBuild(name: string = 'nova-core', tag: string = 'latest'): boolean {
    try {
        execSync(`docker build -t ${name}:${tag} .`, { stdio: 'inherit' })
        console.log(`[DevOps] Built Docker image: ${name}:${tag}`)
        return true
    } catch (err) {
        console.error(`[DevOps] Docker build failed: ${err}`)
        return false
    }
}

/**
 * Run Docker container
 */
export function dockerRun(name: string = 'nova-core', port: number = 3000): boolean {
    try {
        execSync(`docker run -d --name ${name} -p ${port}:3000 ${name}:latest`, { stdio: 'inherit' })
        console.log(`[DevOps] Started container: ${name} on port ${port}`)
        return true
    } catch (err) {
        console.error(`[DevOps] Docker run failed: ${err}`)
        return false
    }
}

// ============================================
// PM2
// ============================================

/**
 * Check if PM2 is installed
 */
export function isPM2Available(): boolean {
    try {
        execSync('pm2 --version', { encoding: 'utf-8', stdio: 'pipe' })
        return true
    } catch {
        return false
    }
}

/**
 * Start with PM2
 */
export function pm2Start(configPath: string = 'ecosystem.config.cjs'): boolean {
    try {
        execSync(`pm2 start ${configPath}`, { stdio: 'inherit' })
        console.log('[DevOps] Started with PM2')
        return true
    } catch (err) {
        console.error(`[DevOps] PM2 start failed: ${err}`)
        return false
    }
}

/**
 * Get PM2 status
 */
export function pm2Status(): ServiceStatus[] {
    try {
        const output = execSync('pm2 jlist', { encoding: 'utf-8' })
        const processes = JSON.parse(output) as Array<{
            name: string
            pm2_env: { status: string }
            monit: { cpu: number; memory: number }
        }>

        return processes.map(p => ({
            name: p.name,
            running: p.pm2_env.status === 'online',
            cpu: `${p.monit.cpu}%`,
            memory: `${Math.round(p.monit.memory / 1024 / 1024)}MB`,
        }))
    } catch {
        return []
    }
}

// ============================================
// Deploy Scripts
// ============================================

const DEPLOY_SCRIPT = `#!/bin/bash
set -e

echo "🚀 Deploying Nova..."

# Pull latest
git pull --ff-only

# Install dependencies
npm ci

# Build
npm run build

# Restart PM2
pm2 restart nova || pm2 start ecosystem.config.cjs

echo "✅ Deploy complete!"
`

/**
 * Generate deploy script
 */
export function generateDeployScript(targetDir: string = '.'): string {
    const scriptsDir = join(targetDir, 'scripts')
    if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true })

    const path = join(scriptsDir, 'deploy.sh')
    writeFileSync(path, DEPLOY_SCRIPT)
    console.log(`[DevOps] Generated deploy script at ${path}`)
    return path
}

// ============================================
// Health Check
// ============================================

/**
 * Simple health check endpoint handler
 */
export function healthCheck(): { status: 'ok' | 'error'; timestamp: number; uptime: number } {
    return {
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime(),
    }
}

/**
 * Generate all DevOps files
 */
export function setupDevOps(targetDir: string = '.'): void {
    generateDockerfile(targetDir)
    generateDockerCompose(targetDir)
    generateDeployScript(targetDir)
    console.log('[DevOps] Setup complete!')
}

export default {
    generateDockerfile,
    generateDockerCompose,
    dockerBuild,
    dockerRun,
    isPM2Available,
    pm2Start,
    pm2Status,
    generateDeployScript,
    healthCheck,
    setupDevOps,
}
