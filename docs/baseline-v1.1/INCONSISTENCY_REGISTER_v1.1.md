# Smart Clinic — Inconsistency Register v1.1 (revision B)

| Field | Value |
|---|---|
| Date | 26 October 2026 (revision B — Product Owner baseline review) |
| Status | Baseline candidate v1.1 rev B — **all items decided; no item blocks the freeze** |
| Scope | SRS v1.1, Technical Architecture v1.1 (ERD, API inventory, permission matrix, ADR log, diagrams), Implementation & QA Plan v1.1, traceability and test matrices |
| Decision IDs | D-01 … D-16 are recorded in SRS §19.3 (decision record) |

**Type:** Contradiction, Gap, Risk, Doc defect. **Severity:** High / Medium / Low.

**Status:**
- *Closed* — resolved by a decision or correction that is applied in the documents.
- *Accepted* — residual risk knowingly accepted by the Product Owner.
- *Deferred* — intentionally outside the MVP, with a recorded decision.

## 1. Summary

| | Closed | Accepted | Deferred | Total |
|---|---|---|---|---|
| Original items IR-01 … IR-29 | 24 | 3 | 2 | 29 |
| Revision B items IR-30 … IR-36 | 7 | 0 | 0 | 7 |
| **Total** | **31** | **3** | **2** | **36** |

## 2. Original items (IR-01 … IR-29) — final decisions

| ID | Sev. | Finding (short) | Decision / resolution applied | Where applied | Status |
|---|---|---|---|---|---|
| IR-01 | High | Notification worker vs. SRS ban on patient messaging | **D-02:** internal operational staff alerts only; no patient SMS or external email | ADR-014, SRS §18, Arch C-01 | Closed |
| IR-02 | Medium | Phone uniqueness index vs. family members | **D-03:** duplicate check for public QR walk-ins only; staff may register family members sharing a phone | SRS 13.2 reworded, ADR-009, TC-QUE-025 | Closed |
| IR-03 | Medium | Identical idempotent replay vs. hashed tokens | **D-04:** encrypted responses (AES-256-GCM, key from secure configuration), 24 h expiry, automated tests | ADR-011, TC-APT-010, TC-SEC-015 | Accepted |
| IR-04 | Medium | Per-browser hold limit without a session | Strictly necessary hold cookie, mentioned in the privacy notice (**D-16**) | SRS BR-054, ADR-023 | Closed |
| IR-05 | Low | Doctor access to Today dashboard | Own-doctor subset (matrix followed) | SRS FR-RPT-001 rev B | Closed |
| IR-06 | Low | Platform admin denied an anonymous page | Shown as N/A | SRS §10, permission CSV | Closed |
| IR-07 | Medium | COULD items need new storage | **D-05:** logo upload, per-doctor walk-in capacity and portal visit counters deferred | SRS FR-CLN-001/006, FR-QR-006, §18; ADR-022 | Deferred |
| IR-08 | Low | Missing error codes in SRS 13.5 | Codes merged into SRS 13.5 | SRS 13.5 rev B, Arch §15 | Closed |
| IR-09 | Low | Arrival-deadline setting with one value | Fixed end-of-day rule | SRS FR-CLN-006 rev B | Closed |
| IR-10 | High | Gate caps = $35 with no contingency | **D-06:** $35 total kept; gate amounts are planning caps, not guarantees; stop and ask at 100 % | Plan §3–4, gate checkpoints | Closed |
| IR-11 | High | SC-1 breadth vs. $7 | **D-07:** optional SC-1 features deferred first, to protect the tenant and membership model | Plan SC-1 freeze list | Closed |
| IR-12 | Medium | FR-PLT-004 / FR-DOC-005 data arrives in SC-2 | Split acceptance; re-verified at SC-2 closure | Plan SC2-BE-10 | Closed |
| IR-13 | Low | Settings in SC-1, enforcement and conflicts later | Accepted sequencing | Traceability | Closed |
| IR-14 | Medium | FR-APT-013 needs the day-close worker | Owned by SC-3 | Traceability | Closed |
| IR-15 | Medium | Tenant tests placed in SC-4 by the brief | Harness built in SC-1, extended each gate, completed in SC-4 | Plan, test notes | Closed |
| IR-16 | Medium | CI only in SC-5 | **D-08:** minimal GitHub Actions CI from SC-1 | Plan SC1-BE-02, ADR-038 | Closed |
| IR-17 | Medium | Seeds vs. need for data | Test fixtures allowed in the test database; demo seed only with approval, in SC-5 | Plan rule R-05 | Closed |
| IR-18 | Medium | Load-test dataset vs. demo seed | **D-09:** separate fictional datasets in an approved, disposable test database | Plan SC5-BE-04, ADR-038 | Closed |
| IR-19 | High | Hosting-dependent NFRs, no hosting chosen | **D-10:** local Docker release in scope; live hosting needs separate approval. NFR-AVL-001 and the deployed part of NFR-SEC-001 apply only if hosting is approved | SRS §8, §18; Plan SC-5 | Deferred |
| IR-20 | Medium | Test gaps in SRS §16 | 36 supplementary tests merged into SRS §16.8 | SRS §16.8, acceptance CSV | Closed |
| IR-21 | Low | API SRS-reference omissions | References fixed (FR-SVC-004, FR-DOC-004, FR-APT-002, FR-APT-017) | Arch §13 | Closed |
| IR-22 | Low | Day close “at midnight” vs. 5-minute job | Within 5 minutes after local midnight | SRS FR-QUE-016 rev B | Closed |
| IR-23 | Medium | Provisional business defaults | **D-14:** all retained as binding decisions; each OQ marked Decided | SRS §19.1, §19.3 | Closed |
| IR-24 | Medium | RLS and CAPTCHA undecided | **D-11:** no CAPTCHA or RLS in the first MVP; strong tenant scoping, abuse controls and documented residual risks | SRS 14.2, §18; ADR-004, ADR-017 | Accepted |
| IR-25 | Low | No private link for staff walk-ins | Confirmed; stated in FR-QUE-006 | SRS FR-QUE-006 rev B | Closed |
| IR-26 | Medium | Usability test needs real people | Product Owner-run activity after SC-4, using the fictional demo | Plan SC-4 deferred work | Accepted |
| IR-27 | Medium | SC-3 carries 6 SHOULD items | Ordered freeze list (display board, no-phone exception, reassign, unavailable-today, leave queue, pause) | Plan SC-3 | Closed |
| IR-28 | Low | 107/37 counts in chat summaries | Documents were correct | — | Closed |
| IR-29 | Low | Screenshots must not show real data | Fictional seed with demo banner only | Plan SC-5 | Closed |

## 3. Revision B items (IR-30 … IR-36)

| ID | Area | Type | Sev. | Finding | Resolution applied | Status |
|---|---|---|---|---|---|---|
| IR-30 | Requirements ↔ architecture ↔ approved scope | Contradiction | High | The approved product lets one staff user belong to several independent clinics. SRS rev A (A-010, OQ-021 default) and Architecture rev A (`clinic_member UNIQUE (user_id)`) restricted each user to one clinic. | **D-01:** global accounts with many memberships (`UNIQUE (clinic_id, user_id)`); roles and activation per membership; clinic selection and switching; per-request re-validation; a session cannot reference another user’s membership (composite FK); membership deactivation is per clinic; doctor profiles are per clinic; Platform Administrator access stays separate. Applied to: SRS (FR-STF-001…005/007, FR-PLT-003…006, FR-DOC-001, FR-SEC-002/005/012, BR-081…085, §10, S-03); ERD and data dictionary; ADR-034…036; API (select-clinic, platform account routes); permission CSV (CAP-STF-02, CAP-PLT-06/07, CAP-CLN-09); staff flow diagram, sitemap and roles diagram; plan SC-1; tests TC-STF-004/005/006, TC-PLT-004, TC-DOC-004, TC-SEC-017. | Closed |
| IR-31 | Patient journeys | Contradiction (summary vs. SRS) | Low | The baseline review’s journey summaries omit the service-selection step that is part of the approved journeys. | **D-13:** journeys preserved as approved, including the service step (hidden when only one service exists); canonical summaries added to SRS §6. | Closed |
| IR-32 | Security (new risk from D-01) | Risk | High | With shared accounts, a Clinic Admin could reset the password or change the email of someone who also works in another clinic, and so gain that clinic’s access. | BR-084 / ADR-035: allowed only for accounts with no other membership; otherwise only the Platform Administrator or the account owner. TC-STF-006. | Closed |
| IR-33 | Security (new risk from D-01) | Risk | Medium | Two browser tabs in different clinics share one session; a switch in one tab could make the other act on the wrong clinic. | FR-SEC-012 / ADR-036: X-Clinic-Id consistency header → 409 CLINIC_CONTEXT_MISMATCH; IDs from another clinic return 404. TC-SEC-017. | Closed |
| IR-34 | Phone requirements | Gap | Medium | SRS B-E6 implied serving patients without a phone, but no workflow was documented; public validation had to stay strict. | **D-12:** BR-037 (public forms always require a valid name and phone, no bypass); FR-QUE-020 separate staff no-phone exception with mandatory reason; tests TC-VAL-004, TC-QUE-029. | Closed |
| IR-35 | Documentation quality | Doc defect | Medium | DOCX tables of contents were empty until fields were updated manually. | All three DOCX files now contain a populated Word TOC field: hyperlinked entries with page numbers, updatable in Word. | Closed |
| IR-36 | Documentation quality | Doc defect | Low | Counts, statuses and cross-references had to change after this revision. | Updated everywhere: 106 FRs (102 original + 4), 36 NFRs, 118 tests, 20 tables, 98 endpoints, 47 capabilities, 38 ADRs; status “Baseline candidate v1.1 rev B” in every file. | Closed |

## 4. Cross-check results (revision B)

| Check | Result |
|---|---|
| All 102 original FRs present with unchanged IDs | 102 / 102 (17 reworded; none removed or renumbered) |
| FRs mapped to a gate or explicit deferral | 106 / 106 (105 in gates, 1 deferred: FR-QR-006) |
| FRs mapped to entities, endpoints or mechanisms, and screens | 106 / 106 |
| In-scope FRs with at least one test | 105 / 105 |
| SRS state transitions with a test | 25 / 25 |
| Permission capabilities mapped to endpoints | 46 / 47 directly; CAP-PLT-05 is cross-cutting (TC-SEC-001/002) |
| ERD tables = data-dictionary tables (single generated model) | 20 / 20 |
| Tenant tables with `clinic_id NOT NULL` and composite FKs | 16 / 16, plus the session → clinic_member composite FK |
| Journeys A and B → endpoints, screens, flow diagrams | Complete; service step present |
| Staff sign-in and clinic selection → SRS 6.3.0, flow diagram page, S-03, API, tests | Complete |
| Required quality areas with tests (incl. multi-clinic membership) | 19 / 19 |
| Gate order respects dependencies | Yes (split acceptance IR-12/13 documented) |

## 5. Items intentionally left for later (not blocking the freeze)

| Item | Decision | When it must be revisited |
|---|---|---|
| Data-retention and deletion policy | D-15 | Before any use with real patient data |
| Legal review of the privacy notice | D-16 | Before any use with real patient data |
| Live hosting | D-10 | When the Product Owner wants a public demo |
| Moderated usability test (SRS SC-01…SC-03) | IR-26 | After SC-4, before release sign-off |
| Product Owner freeze signature | — | Now (SRS §1.3 approval table) |
