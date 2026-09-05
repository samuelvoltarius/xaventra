# Nova observability stack

The stack receives OTLP HTTP/gRPC from every Nova node, stores metrics in
Prometheus and traces in Tempo, and exposes both through Grafana.

1. Copy `.env.example` to `.env` and set a strong Grafana password.
2. Run `docker compose config` to validate the configuration.
3. Run `docker compose up -d`.

Nova nodes should use the private Tailscale collector address where possible:
`NOVA_OTEL_ENDPOINT=http://100.64.0.12:4318`.

No prompts, message contents, tool arguments, secrets, or model responses are
sent as telemetry attributes. Evidence metadata is limited to run/tool status,
latency, routing and verification state.
