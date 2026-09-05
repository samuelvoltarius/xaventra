/**
 * PM2 Ecosystem Configuration
 * 
 * Auto-restart Nova on crash, health monitoring, log management.
 * 
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 monit
 *   pm2 logs nova
 */

module.exports = {
    apps: [
        {
            name: 'nova',
            script: 'dist/daemon.js',
            cwd: __dirname,

            // Auto-restart
            autorestart: true,
            watch: false,
            max_restarts: 10,
            min_uptime: '10s',
            restart_delay: 5000,

            // Memory limits
            max_memory_restart: '1G',

            // Environment
            env: {
                NODE_ENV: 'production',
            },
            env_development: {
                NODE_ENV: 'development',
            },

            // Logging
            log_file: '.nova-logs/combined.log',
            out_file: '.nova-logs/out.log',
            error_file: '.nova-logs/error.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
            merge_logs: true,

            // Health check
            exp_backoff_restart_delay: 100,

            // Graceful shutdown
            kill_timeout: 5000,
            wait_ready: true,
            listen_timeout: 10000,
        },

    ],
}
