# Adaptive reasoning policy

Xaventra treats reasoning effort as an execution setting, not a persona feature.
The deterministic Context Policy chooses the effort before the model call:

| Turn | Local-model effort | Purpose |
|---|---|---|
| Fast chat / lookup | `none` | Lowest latency and visible-answer reliability |
| Any tool-bearing turn | `none` | Deterministic structured tool selection |
| Balanced text analysis | `low` | Bounded deliberation |
| Deep text analysis | `medium` | More deliberation without maximum cost |
| Research text synthesis | `high` | Highest policy-selected effort |

For OpenAI-compatible local endpoints the request carries `reasoning_effort`.
For Ollama, `none` additionally maps to `think: false`. Provider reasoning is
retained only as protected runtime metadata and is never substituted for the
visible answer.

If a reasoning-enabled request returns reasoning but neither visible content nor
a tool call, Xaventra classifies it as a reasoning-only result rather than an
offline provider. It may retry once with reasoning disabled. The retry passes
through the same per-run inference budget, timeout, policy and validation gates;
it cannot grant itself additional tokens or tool authority.

This follows Qwen's documented non-thinking mode for vLLM function calling and
the OpenAI Agents guidance to keep reasoning low/off for latency-sensitive work.
It deliberately avoids unbounded empty-response retries. Provider fallback,
tool execution and independent completion validation remain separate concerns.

References:

- [Qwen function calling](https://qwen.readthedocs.io/en/latest/framework/function_call.html)
- [vLLM reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)
- [OpenAI Agents model settings](https://openai.github.io/openai-agents-js/guides/models/)
- [OpenClaw thinking levels](https://github.com/openclaw/openclaw/blob/main/docs/tools/thinking.md)
- [Hermes LLM access](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugin-llm-access.md)

## Boundaries

- This policy does not expose private chain-of-thought.
- A model that ignores non-thinking mode is not retried indefinitely.
- A reasoning-only result with a valid structured tool call is accepted as a tool
  selection, not mistaken for an empty response.
- Production adoption and channel-level latency require separate live evidence.
