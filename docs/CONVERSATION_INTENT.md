# Conversation versus execution

Operational vocabulary alone is not an execution request. Clear announcements
(including future passive and reports of completed work) and installation
explanations pass to the model without a mandatory tool receipt or execution-target
question. The original message is retained for the response.

`actionRequestText` in `src/core/action-intent.ts` projects the actionable clauses
for the existing intent/evidence detector and clarification gate. Mixed messages
retain their requested work. Unknown forms keep the existing routing behavior;
this bounded German/English grammar is not a general semantic-understanding claim.

The canonical dispatcher offers no tools for recognized conversation-only turns.
The common tool authorization boundary also rejects execution if a model nevertheless
proposes an effect. Tool policy, role checks, confirmation, fencing and independent
validation still apply to actual requests. Announcements never grant authority.
Conversation does not consume a pending execution clarification as consent.

The existing pipeline prompt assembler adds response guidance once, without a
fixed reply template. An announcement should receive a natural acknowledgement;
an explanation should receive an explanation. Reported changes are not live state.

## Verification

- Focused tests: action intent, clarification, execution kernel, tool authorization.
- Full regression and TypeScript build remain required before release.
- `XAVENTRA_QA_MODEL_URL=<enrolled endpoint> node scripts/check-conversation-intent.mjs`
  runs opt-in live inference in an isolated local data directory. Tools are inert,
  and any attempted effect fails the check. Inspect the recorded model responses
  as well as assertions; non-empty text alone is not conversational quality proof.
- This script is not a deployment, full daemon or Telegram end-to-end test.
  Local source changes do not change an installed bot until verified release and
  separately authorized activation complete.
