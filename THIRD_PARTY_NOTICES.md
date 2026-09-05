# Third-party notices

Xaventra contains integrations, adaptations and design references to third-party
open-source projects. These notices must remain with source and binary
distributions. They do not imply endorsement by the upstream projects.

## OpenClaw

The memory ranking modules in `src/memory/hybrid-search.ts`,
`src/memory/mmr.ts` and `src/memory/temporal-decay.ts` contain adaptations of
OpenClaw memory-core implementations. Other provider and plugin modules use
OpenClaw design concepts but remain Xaventra implementations.

Source: https://github.com/openclaw/openclaw

MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ADA v2

Xaventra's visual-awareness and approval UX were independently implemented in
TypeScript after studying ADA v2's public architecture. No ADA runtime is
bundled.

Source: https://github.com/nazirlouis/ada_v2

MIT License — Copyright (c) 2025 Nazir Louis. The standard MIT permission and
warranty terms reproduced in the OpenClaw notice above apply.

## Ada-SI

The governed Skill Forge lifecycle was informed by Ada-SI. Xaventra does not
execute or bundle Ada-SI's Python runtime; proposals pass Xaventra's own
sandbox, benchmark, canary and approval gates.

Source: https://github.com/nazirlouis/Ada-SI

MIT License — Copyright (c) 2026 Ada-SI contributors. The standard MIT
permission and warranty terms reproduced above apply.

## Hermes Agent

Xaventra exposes an interoperability adapter and studied Hermes Agent's
provider-profile and toolset patterns. Hermes Agent itself is not bundled.

Source: https://github.com/NousResearch/hermes-agent

MIT License — Copyright (c) 2025 Nous Research. The standard MIT permission
and warranty terms reproduced above apply.

## ADA Local

ADA Local was used only as a product/capability reference. Its repository did
not expose a root license file during this audit, so no ADA Local source code
is intentionally included. Any future import requires explicit license proof
and a separate review.

Source: https://github.com/nazirlouis/ada_local

## Blender MCP tools

The two vendored Blender MCP directories are distributed under their included
MIT licenses:

- `tools/mcp/blender-mcp/LICENSE`
- `tools/mcp/Blender-MCP-Server/LICENSE`

Copyright (c) 2025 llm-use.

## Package dependencies

JavaScript dependencies remain under their respective upstream licenses. The
machine-readable inventory is generated from `package-lock.json` with:

```bash
npm run sbom:generate
```

Review `SBOM.cdx.json` before every commercial binary distribution. In
particular, the current WhatsApp dependency chain includes GPL/LGPL components;
commercial distribution requires compliance review and may be separated into
an optional connector.
