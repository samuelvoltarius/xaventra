# 2.82.0 responsibility and autonomy by default

- Integration branch `claude/release-2.82.0` on top of 2.81.0 (ed2a6e6).
  Branches, each with its own green candidate CI on the exact commit:
  P6a release button e002b80 (36875230460), P6b responsibility e2fe5ba
  (36876196319), P6c Proxmox c09abab (36877415030), P6d router 6c2fbc2
  (36876735479), P6e delegation 54918fb (36878004325), P7 watch 536dde5
  (36879806991), P7 desktop 9d09c73 (36879804614), P8 skills ef3e4de
  (36894617566), P8 causal memory 11d619d (36894762137), P8 autonomy
  defaults cf5d9f8 (36895596217), P8 vLLM switch 8063af9.
- Fixes found during integration, each with a red test first:
  delegation L1 by allowlist (36b0caa); unified never-list broke the
  Proxmox executor registration (47f0aec, named exception); Home Assistant
  switching without approval (df7e275); `send_telegram_message` to any chat
  id (3ea0078); trust ladder promoted the vLLM switch (e15d6b8).
- Release button pushes with an environment-only deploy key (owner decision
  01.10.2026); no job holds `contents: write`.
- Full suite on the integration commit: all files green except the local
  worktree-only `repair-publication` case, which is green in CI.
- Test data uses example.com only.

- Duplication cleanup (owner: "alle Punkte fixen, wirklich alle"), each
  branch with green CI on its exact head before merge: one message per
  finding (a04ca39…7d2709d), memory 7e7e988 (36907767750), tasks 85134d1
  (36909287765), approvals 1a6e7b9 (36909349520), skills/forge c738bf3
  (36940793983), watch 3849db2 (36942583115). Integration fixes, red tests
  first: missions file vs /wave (d133ee7), trust ladder signs as itself
  (89a5e16), quiet hours "-1" (cd84dfb), forge owner code bound to the call,
  orphan skill-sandbox card removed, L9 drains the proactive-learning queue.
- Full suite after the last merge: all files green except the local
  worktree-only `repair-publication` case.

Pending: candidate CI on the release commit, main CI, signed publication,
production activation, live acceptance (owner presses a real card, the
evening report shows skills/decisions/trust changes, discovered devices are
watched, `/desktop` link on the Main after host setup).
