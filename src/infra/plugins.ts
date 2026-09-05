type Hook = (data: unknown) => unknown | Promise<unknown>;

export class PluginManager {
  private plugins: unknown[] = [];
  private hooks = new Map<string, Hook[]>();
  private commands: unknown[] = [];

  constructor(private readonly pluginDir = "plugins") {}

  async loadAll(): Promise<void> {
    void this.pluginDir;
    this.plugins = [];
  }

  listPlugins(): unknown[] {
    return [...this.plugins];
  }

  registerHook(name: string, hook: Hook): void {
    const hooks = this.hooks.get(name) ?? [];
    hooks.push(hook);
    this.hooks.set(name, hooks);
  }

  async runHook(name: string, data: unknown): Promise<unknown> {
    let current = data;
    for (const hook of this.hooks.get(name) ?? []) {
      current = await hook(current);
    }
    return current;
  }

  hasCommand(name: string): boolean {
    return this.commands.some((command: any) => command?.name === name);
  }

  getCommands(): unknown[] {
    return [...this.commands];
  }
}
