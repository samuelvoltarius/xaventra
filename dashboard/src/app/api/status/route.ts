import { NextResponse } from 'next/server';

// This legacy application has no authoritative Core status adapter. Never
// return static "running" services or a fabricated production inventory.
export async function GET() {
    return NextResponse.json({
        timestamp: new Date().toISOString(),
        verified: false,
        source: 'legacy-dashboard',
        error: 'Core status is unavailable; use the Xaventra Control Plane',
    }, { status: 503 });
}
