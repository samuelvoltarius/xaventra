type Metric = {
  name: string;
  help: string;
  type: "counter";
  values: Map<string, number>;
};

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
}

class MetricsRegistry {
  private entries = new Map<string, Metric>();

  counter(name: string, help: string): Metric {
    let metric = this.entries.get(name);
    if (!metric) {
      metric = { name, help, type: "counter", values: new Map() };
      this.entries.set(name, metric);
    }
    return metric;
  }

  increment(name: string, help: string, labels: Record<string, string>, value = 1): void {
    const metric = this.counter(name, help);
    const key = labelKey(labels);
    metric.values.set(key, (metric.values.get(key) ?? 0) + value);
  }

  toPrometheus(): string {
    return Array.from(this.entries.values())
      .map((metric) => {
        const values = Array.from(metric.values.entries()).map(([labels, value]) =>
          labels ? `${metric.name}{${labels}} ${value}` : `${metric.name} ${value}`,
        );
        return [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...values].join("\n");
      })
      .join("\n");
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(
      Array.from(this.entries.entries()).map(([name, metric]) => [
        name,
        Object.fromEntries(metric.values.entries()),
      ]),
    );
  }
}

export const registry = new MetricsRegistry();

export const metrics = {
  messageReceived(channel: string): void {
    registry.increment("nova_messages_total", "Nova messages by direction and channel", {
      channel,
      direction: "received",
    });
  },
  messageSent(channel: string): void {
    registry.increment("nova_messages_total", "Nova messages by direction and channel", {
      channel,
      direction: "sent",
    });
  },
  llmRequest(provider: string, model: string): void {
    registry.increment("nova_llm_requests_total", "Nova LLM requests by provider and model", {
      provider,
      model,
    });
  },
  llmTokens(provider: string, model: string, tokens: number): void {
    registry.increment("nova_llm_tokens_total", "Nova LLM token estimates by provider and model", {
      provider,
      model,
    }, tokens);
  },
};

export class MetricsServer {
  constructor(public readonly port: number) {}
}
