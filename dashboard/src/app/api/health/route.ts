// API Route: GET /api/health
// Returns health status for monitoring

import { NextResponse } from 'next/server';

export async function GET() {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();

    // Determine health status
    const memPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (memPercentage > 90) {
        status = 'unhealthy';
    } else if (memPercentage > 80) {
        status = 'degraded';
    }

    const health = {
        status,
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        version: process.env.npm_package_version || '1.0.0',
        memory: {
            used: memUsage.heapUsed,
            total: memUsage.heapTotal,
            percentage: Math.round(memPercentage),
        },
        services: {
            dashboard: 'running',
            clawdbot: 'running', // Could check via Gateway
        },
    };

    // Return appropriate status code
    const statusCode = status === 'unhealthy' ? 503 : status === 'degraded' ? 200 : 200;

    return NextResponse.json(health, { status: statusCode });
}
