# Subscription Action Center — Test Plan

Derived from spec sections 13 (Test plan) and 14 (Acceptance criteria).
Covers Wave 1 task A (domain library, automated) plus the integration,
interaction, and content checks that later waves must run against the
production Supabase project.

**Domain library:** `lib/subscriptions.ts` (pure functions only).
**Unit tests:** `lib/subscriptions.test.ts`, run with `npm test` (vitest run).

Legend: **[A]** = automated (vitest, runs today). **[M]** = verified-manual
(scripted procedure below; cannot be automated in Wave 1 because it needs a
live DB, auth, or a human eye).

---

## 1. Unit table — each test to spec FR to test name

| Spec §13 unit item | Spec FR | Test(s) in `lib/subscriptions.test.ts` | Status |
| --- | --- | --- | --- |
| Fixed monthly, quarterly, annual cadence convert to correct monthly equivalent | FR-04 | `monthlyEquivalentFor` — weekly/monthly/quarterly/annual + rounding | [A] |
| Variable charges use the configured representative-value rule (stable → last; variable → median of last 3 + range) | FR-01, FR-04 | `representativeAmount` — stable → `last_stable`; within 1% counts as stable; variable → `median_3` with min/max; wide spread → `range`; empty input throws | [A] |
| Refunds remain one-time and never become recurring savings | FR-25 | `savingsOutcome` — cancelled with refund: `one_time_cents` set, `annual_cents` excludes refund | [A] |
| Savings duration ends with a known promotional period | §6 savings definition | `savingsOutcome` — negotiated 3-mo promo: `annual_cents` capped, `modeled_months`=3; unknown duration: `annual_cents`=0, `modeled_months`=null; 12-mo promo annualizes fully | [A] |
| Merchant alias matching is deterministic and does not cross users | §4 | `matchMerchant` — exact alias wins, case-insensitive, first-entry tie-break, null on no match; purity assertion (no user context in signature) | [A] |
| Low-confidence or stale registry records cannot enable assisted action | §4 | `routeEligible` — killed → blocked; 2 failures/7d → suppressed; >180d stale → blocked incl. guided; assisted needs high confidence + ≤90d freshness; low confidence → guidance-only on all route kinds | [A] |
| State transitions reject invalid jumps | §8 | state machine — `submitted→confirmed_complete` throws; `kept→submitted` throws; invalid jumps set throws; happy-path edges pass; unknown states throw; 14 canonical states; every state has ≥1 edge | [A] |
| Idempotency returns the original request on duplicate submission | FR-10 | `idempotencyKey` — deterministic hex for same inputs; differs by actionType/seriesId/userId (documented duplicate-submit policy lives on the function) | [A] |
| Consent expiration blocks submission | FR-08, FR-09 | `consent` — expired → blocks with expiry reason; withdrawn → blocks with withdrawn reason; valid → null | [A] |
| Planner handoff preserves baseline and calculation versions | §7 | `buildPlannerHandoff` — versions pass through; `temp_only`=true; input deep-equal before/after (no plan mutation); copy uses "could"/"under these assumptions", never "will" | [A] |

Additional unit coverage in the same file (task-required, beyond the §13 list):

| Item | Spec FR | Test(s) | Status |
| --- | --- | --- | --- |
| Quarterly cadence in next-charge projection | FR-14, FR-24 | `nextExpectedDate` — weekly/monthly/quarterly/annual; month-end clamping (Jan 31 → Feb 28) | [A] |
| Route tokens verify only allowlisted destinations | §9 | route tokens — verifies OK for allowlisted destination; tampered signature rejected; destination not in allowlist rejected; expired rejected; wrong secret rejected; malformed rejected | [A] |
| Fuzzy matching only suggests | §4 | `suggestMerchant` — substring returns `match:"suggested"`; same name returns null from `matchMerchant` (cannot power assisted) | [A] |
| New matching charge reopens an ended series | FR-15, FR-26 | `shouldReopenSeries` — reopens after reported_complete; ignores active series; ignores older charge dates | [A] |
| Reported / likely / confirmed remain distinct states | FR-23 | state machine — all three distinct and all `isTerminalOutcome`=true; non-terminal states false | [A] |
| Honest status copy | §11 | `STATUS_COPY` — every state covered; verbatim spec copy for action_started, unsupported, confirmed_complete, needs_you; action-started copy never says "cancelled" | [A] |

Run everything:

```bash
cd ~/workspace/goals/explore-launching-coast-the-financial-planning-app/build/coast-nextjs
npm test            # vitest run — includes lib/subscriptions.test.ts (66 tests)
npx tsc --noEmit    # strict typecheck
```

---

## 2. Integration procedures (all verified-manual until APIs exist)

Each procedure states exact commands/queries against production Supabase.
Replace `sb` with the repo's Supabase CLI wrapper / `psql` connection string;
all queries run as the authenticated user role, never service_role, unless
the step is explicitly a setup step.

### 2.1 RLS cross-user denial (spec §13: row-level controls)

**What:** User B must not read, write, or transition user A's subscriptions,
actions, consent, or evidence rows.

Setup (service_role or SQL editor, one row per table):

```sql
insert into subscription_series (id, user_id, merchant_key, cadence, lifecycle_state)
values ('<SERIES_A>', '<USER_A>', 'netflix', 'monthly', 'active');

insert into action_requests (id, user_id, series_id, action_type, status, idempotency_key)
values ('<REQ_A>', '<USER_A>', '<SERIES_A>', 'cancel', 'draft', '<KEY_A>');

insert into consents (id, user_id, request_id, expires_at)
values ('<CONSENT_A>', '<USER_A>', '<REQ_A>', now() + interval '7 days');
```

Procedure, authenticated as USER_B (use the API with USER_B's JWT):

```bash
# every one of these must return 0 rows / 403 / RLS violation
curl -s -H "Authorization: Bearer <USER_B_JWT>" \
  "$SUPABASE_URL/rest/v1/subscription_series?id=eq.<SERIES_A>"
curl -s -H "Authorization: Bearer <USER_B_JWT>" \
  "$SUPABASE_URL/rest/v1/action_requests?id=eq.<REQ_A>"
curl -s -H "Authorization: Bearer <USER_B_JWT>" -X PATCH \
  -d '{"status":"withdrawn"}' \
  "$SUPABASE_URL/rest/v1/action_requests?id=eq.<REQ_A>"
curl -s -H "Authorization: Bearer <USER_B_JWT>" \
  "$SUPABASE_URL/rest/v1/consents?id=eq.<CONSENT_A>"
```

**Pass:** all return empty / denied. Also run the negative on pg_policies as
a sanity read:

```sql
select policyname, cmd, roles from pg_policies
where schemaname = 'public'
  and tablename in ('subscription_series','action_requests','consents','evidence_objects');
-- expect USING/WITH CHECK clauses referencing auth.uid() = user_id on each
```

### 2.2 Route token redirect rejection (spec §13)

**What:** a token minted for one destination must not launch another.

```bash
# 1. Create a draft + consent for a supported merchant as USER_A, then:
TOKEN=$(curl -s -X POST -H "Authorization: Bearer <USER_A_JWT>" \
  "$APP_URL/api/actions/<REQ_A>/launch" | jq -r .route_token)

# 2. Tamper the destination (re-signing requires the server secret, so the
#    attacker instead tries a token minted for merchant M against merchant N):
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  "$APP_URL/r/go?token=$TOKEN"
# expect: 302 to the registry destination_ref for merchant M

# 3. Direct-link a non-allowlisted URL — must fail closed:
curl -s -o /dev/null -w "%{http_code}\n" \
  "$APP_URL/r/go?destination=https://evil.example.com"
# expect: 400, no redirect
```

**Pass:** step 2 lands only on the registry destination; step 3 never redirects
(400). The library-level guarantee is covered by the [A] route-token tests.

### 2.3 Duplicate submit (spec FR-10, §13)

**What:** two submits with the same idempotency key return the same request.

```bash
KEY=$(node -e "const {idempotencyKey}=require('./dist-check'); console.log('x')")
# (In practice: capture the key returned by POST /actions on first create.)
FIRST=$(curl -s -X POST -H "Authorization: Bearer <USER_A_JWT>" \
  -H "Idempotency-Key: $KEY" -d '{"series_id":"<SERIES_A>","action_type":"cancel"}' \
  "$APP_URL/api/actions" | jq -r .id)
SECOND=$(curl -s -X POST -H "Authorization: Bearer <USER_A_JWT>" \
  -H "Idempotency-Key: $KEY" -d '{"series_id":"<SERIES_A>","action_type":"cancel"}' \
  "$APP_URL/api/actions" | jq -r .id)
[ "$FIRST" = "$SECOND" ] && echo PASS || echo FAIL
```

Then check the DB: exactly one open request for the (series, action_type) pair:

```sql
select count(*) from action_requests
where series_id = '<SERIES_A>' and action_type = 'cancel'
  and status not in ('withdrawn','failed','confirmed_complete');
-- expect 1
```

**Pass:** same id returned; count is 1; a second `action_events` entry was not
created for a new submission.

### 2.4 Consent expiry (spec FR-08/FR-09, §13)

**What:** an expired (or withdrawn) consent blocks `/submit`.

```sql
-- setup: expire the consent
update consents set expires_at = now() - interval '1 day' where id = '<CONSENT_A>';
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: Bearer <USER_A_JWT>" \
  "$APP_URL/api/actions/<REQ_A>/submit"
# expect: 422 with body mentioning consent expiry
```

Also test the withdrawn path:

```sql
update consents set withdrawn_at = now() where id = '<CONSENT_A>';
```

**Pass:** 422 + human-readable reason (the API should surface the string from
`consentBlocksSubmission`); the request stays in its last proven state —
assert no status change:

```sql
select status from action_requests where id = '<REQ_A>'; -- unchanged
```

### 2.5 Planner handoff temp-only (spec §7, §13)

**What:** the handoff creates a temporary scenario and never mutates the plan.

```bash
BEFORE=$(curl -s -H "Authorization: Bearer <USER_A_JWT>" \
  "$APP_URL/api/whatif/plan" | jq -c .monthly_investment_cents)
curl -s -X POST -H "Authorization: Bearer <USER_A_JWT>" \
  -d '{"action_request_id":"<REQ_A>"}' \
  "$APP_URL/api/actions/<REQ_A>/planner" | jq .temp_only,.baseline_version,.calc_version
# expect: true, "<plan-v>", "fire-monthly-v1"
AFTER=$(curl -s -H "Authorization: Bearer <USER_A_JWT>" \
  "$APP_URL/api/whatif/plan" | jq -c .monthly_investment_cents)
[ "$BEFORE" = "$AFTER" ] && echo PASS || echo FAIL
```

And for a negotiated outcome with unknown promo duration:

```bash
curl -s -X POST -H "Authorization: Bearer <USER_A_JWT>" \
  -d '{"action_request_id":"<NEGOTIATED_REQ>"}' \
  "$APP_URL/api/actions/<NEGOTIATED_REQ>/planner" | jq .number_impact_available
# expect: false, with a cash-only note
```

**Pass:** plan unchanged; temp flag true; versions echoed back.

### 2.6 Remaining integration items (spec §13) — scripted, run at release

| Item | Procedure | Pass |
| --- | --- | --- |
| Partner webhooks authenticated, replay-safe, idempotent | Replay a captured webhook twice with a valid signature; then with an invalid signature | Second replay returns 200 without a new event; invalid signature → 401 |
| Partner failure keeps last proven state | Stub connector to 500 on submit | Request stays `authorized`; no status change; timeline shows last observed status |
| Withdraw before submit prevents connector execution | Withdraw an `authorized` request, then inspect connector logs | No outbound call recorded |
| Fee created once, only on success event | Complete an assisted cancel; attempt a second fee write for the same request id | One fee row; pricing_version matches request |
| Ledger recurrence reopens the correct series | Insert a charge for a `reported_complete` series, run the recurrence job | Series → `reopened`; history rows intact (count unchanged) |
| Evidence deletion removes bytes, keeps audit | Delete an evidence object | Storage object gone; `evidence_objects` row retains id, request_id, deleted_at |
| Kill switches stop new submissions | Set merchant `active=false`, then global flag off; attempt new action | 422 with honest unsupported/stale copy |
| Notifications respect preferences/quiet hours | Trigger a reminder inside quiet hours | No push/email; in-product reminder queued |

---

## 3. Interaction / content checklist (all verified-manual)

Run through the direct and guided flows on desktop + mobile with keyboard and
a screen reader (VoiceOver/NVDA). Mark each pass/fail per build.

- [ ] Every direct and guided flow completes by keyboard alone (Tab order
      follows the visual order; focus is visible; Enter/Space activate).
- [ ] Focus moves to the new status heading after submission (spec §11).
- [ ] Timelines render as ordered lists with accessible labels.
- [ ] External-navigation warning is announced **before** the app leaves Coast
      (name the destination; "Coast cannot confirm cancellation until you
      return or we see evidence").
- [ ] Status is conveyed by text **and** icon shape, never color alone.
- [ ] Returning from a deep link never auto-selects "Cancelled" — the outcome
      step requires an explicit user choice (spec FR-11).
- [ ] The final assisted-action approval names the merchant, the exact
      request, the data disclosed, and the fee (spec FR-17).
- [ ] Double-tapping Submit creates exactly one request (idempotency key
      visible in network tab is identical on both taps).
- [ ] Draft survives sign-in expiry and recoverable network failure
      (re-authenticate → draft intact, consent re-captured if expired).
- [ ] Unsupported and stale-route states are useful and honest: no fabricated
      URL, phone number, policy, or timeline; generic checklist + feedback
      offered instead (spec §4 coverage behavior).
- [ ] Screen readers announce each status change exactly once (no double
      announcements from competing live regions).
- [ ] Touch targets ≥ 44×44px; text contrast ≥ 4.5:1 (3:1 large text);
      reduced-motion removes timeline/number animations (spec §11).
- [ ] Copy never equates "Action started" with "Cancelled"; no message claims
      a refund, cancellation, or new rate before evidence exists; every price,
      fee, and savings figure names its basis (spec §13 content tests).
- [ ] Guided steps show route version and last-verified date, with a
      "This no longer matches" report action (spec FR-12).

---

## 4. Automation summary

- **Automated today [A]:** 66 vitest unit tests in `lib/subscriptions.test.ts`
  (run with `npm test`; typechecked with `npx tsc --noEmit`).
- **Verified-manual [M]:** all of §2 (integration) and §3 (interaction/content).
  Re-run §2.1–§2.5 on every release that touches the API, RLS policies, or the
  planner bridge; re-run §3 on every UI change to the Action Center.
- **Not yet testable:** assisted-cancellation and negotiation pilots are gated
  on legal/privacy/security review (spec §10, §14) — their test procedures
  above apply only once those gates are cleared.
