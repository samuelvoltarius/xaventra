type EnvValue = string | undefined | ((home: string) => string | undefined);
export declare function withTempHome<T>(fn: (home: string) => Promise<T>, opts?: {
    env?: Record<string, EnvValue>;
    prefix?: string;
}): Promise<T>;
export {};
//# sourceMappingURL=temp-home.d.ts.map