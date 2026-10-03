# 2.85.1 Telegram and Mesh URL correctness candidate

Core and Desktop are synchronized to 2.85.1. Source candidate
`b138f49cc41fc8b4fe9d3e1e63b2280eefebd34b` passed all nine jobs in
[CI 37136664017](https://github.com/samuelvoltarius/xaventra/actions/runs/37136664017).

## Evidence

- Local Windows: 683 Core suites, 4,692 passed and 2 skipped; 23 Desktop tests;
  build, typecheck, generated catalogs and assurance pass. The earlier Windows
  long-path fixture failure is retained; process-local Git long-path support
  was used for the full rerun, without altering global settings or assertions.
- Downloaded packaged Desktop reports on Windows, Linux and macOS all identify
  the exact candidate and version. Each passes 14 UI, 5 isolated Core and
  7 full-daemon checks. These use a scripted provider, not a live Telegram user.
- Docker repair, managed activation and real isolated sandbox regression /
  rollback gates pass. The downloaded sandbox report identifies the candidate
  and `sourceDirty: false`.
- Complete history scan: 623 commits, no Gitleaks findings. Staged changes also
  passed a redacted secret scan.
- Mesh inspection tests cover current local peer/mesh binding, busy peers,
  missing or stale identities, non-owner denial, target limits, pinned address,
  bounded body, routing and service-account Snap CLI discovery. Public SSRF
  protections remain unchanged. No blanket private-network fetch permission.

## Limits and remaining release gates

The inspector only reads an owner-requested, known Tailscale peer's HTTPS root
page on port 443. It does not scan arbitrary web services, log in, follow
redirects, accept arbitrary ports/paths or execute page instructions. Node
advertisements and page content are distinguished from functional service tests.
Host-side services outside a worker container are not magically visible to the
AI service scanner. Landing-page reachability does not prove ASR/TTS operation.

No node-addressed screenshot transport was added: node requests cannot become
captures of the local desktop. Owner/enrollment and delivery gates remain.

This evidence commit still requires exact green candidate CI, then exact main
CI, signed publication and independent artifact verification before production
activation with preserved rollback. No full RC, OS-signing, live Telegram or
five-node activation acceptance is claimed by this source record.
