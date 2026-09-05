# Skills Import — Open Agent Skills Ecosystem

> Phase 8+ Roadmap

## Konzept

Nova soll externe Skill-Pakete aus dem offenen Agent Skills Ökosystem importieren können. Das `skills` CLI (`npx skills add`) ist ein Standard der von Firebase, Vercel, und der Community getrieben wird.

## Wie es funktioniert

```
npx skills add firebase/agent-skills
    ↓
.agent/skills/firebase/ ← SKILL.md + scripts + resources
    ↓
Nova liest SKILL.md → registriert als Nova-Tools
    ↓
Skill Distributor → deploy to mesh nodes
```

## Integration in Nova

### Phase 8a: Read External Skills
- Nova kann `.agent/skills/*/SKILL.md` Files lesen
- Format: YAML Frontmatter + Markdown Instructions
- Nova injected relevante Skills als System-Prompt Kontext

### Phase 8b: Auto-Tool Registration
- Aus Skill-Instruktionen Tools generieren
- AST Security Check auf alle Skill-Scripts
- Registrierung im Smart Tool Router

### Phase 8c: Mesh Skill Sync
- Imported Skills automatisch an alle Nodes deployen
- Skill Distributor erkennt `.agent/skills/` Changes
- Signed packages für Mesh-Security

## Unterstützte Skills Quellen

| Quelle | Command | Was es bringt |
|--------|---------|---------------|
| Firebase | `npx skills add firebase/agent-skills` | Auth, Firestore, Hosting |
| Vercel | `npx skills add vercel/skills` | Edge Functions, KV |
| Community | `npx skills add user/skill-name` | Beliebige Skills |
| Lokal | Manuell in `.agent/skills/` | Eigene Skills |

## Architektur

```
┌──────────────────────────────────────┐
│           Skills Registry            │
│  .agent/skills/                      │
│  ├── firebase/SKILL.md              │
│  ├── vercel/SKILL.md                │
│  └── custom/SKILL.md               │
└─────────────┬────────────────────────┘
              │ read
┌─────────────▼────────────────────────┐
│       Nova Skill Loader (NEW)        │
│  - Parse SKILL.md YAML frontmatter  │
│  - Extract tool definitions          │
│  - AST security check               │
│  - Register in Smart Tool Router    │
└─────────────┬────────────────────────┘
              │ broadcast
┌─────────────▼────────────────────────┐
│       Skill Distributor (EXISTING)   │
│  - Sign & deploy to mesh nodes      │
│  - Version tracking                  │
└──────────────────────────────────────┘
```

## Sicherheit

- Alle externen Skills durchlaufen AST Security Check
- Keine `eval`, `child_process`, `vm` etc.
- Red-Team testet importierte Skills automatisch
- [LOCKED] Skills können nicht von L24 modifiziert werden

## Status

- [ ] Phase 8a: SKILL.md Reader
- [ ] Phase 8b: Auto-Tool Registration
- [ ] Phase 8c: Mesh Skill Sync
- [ ] Phase 8d: `nova import-skill` CLI Command
