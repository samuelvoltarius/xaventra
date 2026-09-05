# Security policy

Xaventra controls tools, infrastructure, user-scoped memory and distributed
nodes. Please do not publish a vulnerability before a coordinated fix exists.

## Reporting

Report security issues privately to the repository owner through GitHub's
private vulnerability reporting feature. Include the affected version, attack
preconditions, impact, reproduction steps and any suggested mitigation.

Do not include live credentials, private keys, OAuth tokens, user data, public
IP addresses or production logs in a public issue.

## Security boundaries

- Model output is untrusted and is never Tool Evidence.
- Credentials remain local to a user and node.
- Main, channel and release authority require leases and fencing tokens.
- Self-modification remains inert until sandbox, regression, rollback and
  approval gates pass.
- Blue-Team functionality is defensive. Exploitation and lateral movement are
  outside the supported security capability.

## Supported versions

Security fixes target the latest public release. Older compatibility releases
may receive critical fixes when a safe migration requires them.

