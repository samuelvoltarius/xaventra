/**
 * Type declarations for packages without types
 */

declare module 'ari-client' {
    export function connect(
        url: string,
        username: string,
        password: string
    ): Promise<AriClient>

    export interface AriClient {
        on(event: string, callback: (...args: any[]) => void): void
        start(appName: string): Promise<void>
        stop(): void
        channels: {
            originate(options: {
                endpoint: string
                app: string
                callerId?: string
                variables?: Record<string, string>
            }): Promise<{ id: string }>
        }
    }
}
