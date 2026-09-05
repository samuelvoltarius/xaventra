# Authorization review — 2.77.2

Date: 2026-09-05. Outcome: **fixed** for the bounded findings below.

## Invariant and verified defects

User text, an OS-mode flag, stale state and colliding channel identities must not
grant owner/admin authority. Every agent tool call must be authorized before
execution or reuse of an idempotency result, including recovery and later rounds.

The old message-triggered admin override was already absent from the clean
export. Runtime tests nevertheless reproduced an independent OS-mode privilege
grant: unknown/new principals became owners and old unproven grants survived.
Telegram allow-list values also applied outside Telegram, and a colliding raw
ID could inherit another channel's stored role.

Independent candidate review identified two additional paths within that same
boundary: later runner tool rounds skipped first-round RBAC, and the CLI wrapper
dropped the principal context needed by the new channel-bound slash handler.
Both were confirmed against the implementation before correction. The reviewer
also demonstrated them with in-memory stubs; no real shell command was executed.

## Narrow shared-boundary correction

- `src/users/multi-user-middleware.ts`: remove implicit OS privileges; record
  explicit/configured grant provenance; revoke unproven owner/admin state;
  restrict configured Telegram owners to Telegram; reject cross-channel reuse.
- `src/agents/tool-authorization.ts` and `nova-runner.ts`: enforce tool policy
  and RBAC at the common execution closure before idempotency/compensation;
  replace model-supplied identity and request/consent fields with trusted input.
  Policy denial is not taught as a verified tool-execution failure.
- `src/channels/telegram.ts`, `src/tools/complete-registry.ts` and
  `src/core/slash-commands.ts`: pass channel identity to privilege checks.
- `src/core/cli-pipeline-runtime.ts`: retain trusted principal context when
  forwarding slash commands.

Configured Telegram owners, explicit local CLI/authenticated Desktop grants and
owner-authorized admin delegation remain supported. Old manually granted roles
without provenance cannot be distinguished from unsafe automatic grants and
must be reauthorized. This conservative migration is intentional.

## Ordered verification

1. Diff and syntax: `git diff --check` and `npm run typecheck` passed.
2. Security triggers: before the patch, the new middleware suite had four
   failures and one passing legitimate control. After the patch, the focused
   suites below passed (five files / 17 tests). Unknown users, persisted unsafe
   grants, foreign-channel aliases, repeated denied calls and role-check errors
   no longer cross the tested privilege boundary.
3. Legitimate controls: explicit grants survive reload, configured Telegram
   ownership remains, CLI context reaches slash handling, authorized calls reach
   the idempotency boundary, and governed read-only introspection remains allowed.
4. Package checks: full isolated suite passed (156 files / 1034 tests);
   `npm run build`, `npm run check:catalogs`, `npm run test:desktop` (four tests)
   and `npm run check:assurance` passed. Core dependency audit reported zero.

Focused command:

```bash
npm test -- src/agents/tool-authorization.test.ts src/core/cli-pipeline-runtime.test.ts src/users/owner-authorization.test.ts src/users/multi-user-middleware.test.ts src/core/message-pipeline-security.test.ts --maxWorkers=1
```

The runner regression executes the actual common closure extracted from source
with inert downstream stubs and checks all five call sites still use it. This
proves authorization happens before a recording/cache stub, not a live provider
or operating-system end-to-end run. No real command, OAuth login, production
deployment or multi-node test was performed for this patch.

## Remaining limits

This is not a claim that the entire application is free of vulnerabilities.
Transport authentication is still required: the REST API without
`NOVA_API_TOKEN` is explicitly an unauthenticated development endpoint and must
not be exposed to untrusted networks. Its caller identity is trusted only behind
an authenticated ingress. The legacy Next.js prototype is not a production
authenticated control plane. Native installers and cross-platform Desktop
packages still require separate release validation.

See [the export report](../PUBLIC_EXPORT_REPORT.md) for source/history scanning
and [the release checklist](PUBLIC_RELEASE_CHECKLIST.md) for outstanding gates.
