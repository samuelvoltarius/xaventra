// API Route: GET /api/metrics
// Returns Prometheus-compatible metrics

import { NextResponse } from 'next/server';

export async function GET() {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();

    const metrics = `# HELP dashboard_up Whether the dashboard is running
# TYPE dashboard_up gauge
dashboard_up 1

# HELP dashboard_uptime_seconds Dashboard uptime in seconds
# TYPE dashboard_uptime_seconds gauge
dashboard_uptime_seconds ${Math.floor(uptime)}

# HELP dashboard_memory_heap_used_bytes Memory heap used in bytes
# TYPE dashboard_memory_heap_used_bytes gauge
dashboard_memory_heap_used_bytes ${memUsage.heapUsed}

# HELP dashboard_memory_heap_total_bytes Memory heap total in bytes
# TYPE dashboard_memory_heap_total_bytes gauge
dashboard_memory_heap_total_bytes ${memUsage.heapTotal}

# HELP dashboard_memory_rss_bytes Resident set size in bytes
# TYPE dashboard_memory_rss_bytes gauge
dashboard_memory_rss_bytes ${memUsage.rss}

# HELP nodejs_version_info Node.js version
# TYPE nodejs_version_info gauge
nodejs_version_info{version="${process.version}"} 1
`;

    return new NextResponse(metrics, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
        },
    });
}
