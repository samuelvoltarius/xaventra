# 2.81.0 autonomy phases 1–5

- Integration branch `claude/release-2.81.0` on top of 2.80.1 (83d88a8).
  Phase branches, each with its own green CI: P1a buttons 6a2089d
  (36860788242), P1b planner 640900e (36861021007), P2 sensing (36861679008),
  P3 thinking cffae83 (36861381434), P4 self-update 21b1f45 (36861088619).
  Phase 5 (G2 9327c77+bff26c2, software scout e16ecf0) carried over by
  cherry-pick after the history cleanup. Capability router fix from a peer
  session (34ae809), counter-checked: 8 of 9 tests red without it.
- Integration by Claude: planner delivery port → Telegram/Knopf-Karten;
  thought hub for sensing/thinking/self-update with a closed action list;
  chain test (discovered printer approved only after the owner presses Ja)
  red without the executor wiring.
- Each phase: tests red first, every safeguard reverted alone turns tests
  red (counter-probe logs under the private `.nova-data/claude-tmp/`).
- Test data uses example.com only; the owner's real address was removed from
  a test and from the public branch history.

Pending: full suite and candidate CI on the final commit, main CI, signed
publication, production activation, live acceptance (owner presses a real
card, status card on a real task, sensing/thinking switched on step by step).
