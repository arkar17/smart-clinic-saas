# Smart Clinic — Project Documents (Baseline v1.1, revision B)

Planning documents for **Smart Clinic — Multi-Clinic Management SaaS**, a portfolio project. Every patient name, phone number and clinic in these documents and in all demo data is fictional.

**Status of the whole set:** Baseline candidate v1.1 rev B (26 October 2026), ready for Product Owner freeze. No application code exists, and no Claude Code Cloud credits have been used.

## 1. Document set and authority

Documents are listed in order of authority. If two documents disagree, the higher one governs, and the conflict is logged in `INCONSISTENCY_REGISTER_v1.1.md`.

| # | File | Purpose | Format |
|---|---|---|---|
| 1 | `01_Smart_Clinic_SRS_v1.1.docx` | Scope and requirements: 106 FR (102 original + 4 added in rev B), 36 NFR, business rules, state machines, permissions, 118 acceptance tests, decision record D-01…D-16 | Word, populated TOC |
| 2 | `02_Smart_Clinic_Technical_Architecture_v1.1.docx` | Architecture, 20-table data dictionary, 98 REST endpoints, algorithms, security, multi-clinic session model | Word, populated TOC |
| 3 | `ADR_LOG_v1.1.md` | 38 architecture and business decisions | Markdown |
| 4 | `PERMISSION_MATRIX_v1.1.csv` | 47 capabilities × 5 roles, with scope rules and endpoints | CSV |
| 5 | `01_system_workflow.drawio` | System context and deployment; request, transaction and event flow (2 pages) | diagrams.net |
| 6 | `02_patient_and_staff_flows.drawio` | Journey A, Journey B, staff sign-in and clinic selection, appointment and queue state machines (5 pages) | diagrams.net |
| 7 | `03_database_erd.drawio` | Physical ERD, 20 tables (generated from the same model as the data dictionary) | diagrams.net |
| 8 | `04_role_permissions.drawio` | Global account → clinic memberships → roles → scopes → capability groups; enforcement pipeline | diagrams.net |
| 9 | `05_navigation_sitemap.drawio` | Web routes by realm, screen IDs, guards, clinic switcher | diagrams.net |
| 10 | `03_Smart_Clinic_Implementation_and_QA_Plan_v1.1.docx` | Five gates SC-1…SC-5, tasks, planning caps, QA strategy, Claude Code operating rules | Word, populated TOC |
| 11 | `TRACEABILITY_MATRIX_v1.1.md` | FR → gate, entities, endpoints, screens, tests, acceptance criteria; coverage of NFRs, transitions and quality areas | Markdown |
| 12 | `ACCEPTANCE_TEST_MATRIX_v1.1.csv` | 118 tests with gate, level, quality area, expected result and run policy | CSV |
| 13 | `INCONSISTENCY_REGISTER_v1.1.md` | 36 items (29 original + 7 from revision B), all decided | Markdown |
| 14 | `README_DOCUMENTS.md` | This index | Markdown |

## 2. Revision B at a glance

- **Staff model corrected to multi-clinic membership (D-01).**
  - One global staff account can hold one membership per clinic (`UNIQUE (clinic_id, user_id)`), each with its own roles, activation and doctor-profile link.
  - Staff select and switch the active clinic. The server re-validates the selected membership on every request and checks the `X-Clinic-Id` header.
  - A session cannot reference another user's membership (composite FK).
  - Platform Administrator access stays separate.
- **All register items decided.** Product Owner decisions D-01…D-16 are in SRS §19.3. All open questions are marked Decided.
- **Phone rule.**
  - Public QR booking and walk-in always require a valid name and phone (BR-037).
  - Patients without a phone go only through a separate receptionist workflow (FR-QUE-020).
- **Journeys A and B preserved as approved**, including the service-selection step.
- **Budget.** The USD 35 total and the five gates are kept. Gate amounts are planning caps, not guarantees. A minimal CI workflow runs from SC-1.

## 3. How to use the set

- **Product Owner:** sign the approval tables (SRS §1.3, Plan §1.2) to freeze the baseline. SC-1 kickoff is a separate approval.
- **Claude Code Cloud session:** start each gate with the kickoff prompt (Plan §4.4). Read only the current gate's traceability rows plus the specific SRS or architecture section a task needs. Stop at the gate boundary.
- **Reviewer / QA:** filter `ACCEPTANCE_TEST_MATRIX_v1.1.csv` by `gate` and update `status` (Not run / Pass / Fail / Blocked) at gate closure.
- **Opening diagrams:** in https://app.diagrams.net choose File → Open from → Device. Multi-page files have tabs at the bottom.
- **Tables of contents:** the TOCs are filled in and hyperlinked. After editing a document in Word, right-click the TOC and choose Update Field.

## 4. ID conventions

| Prefix | Meaning | Defined in |
|---|---|---|
| FR-xxx-nnn / NFR-xxx-nnn | Functional / non-functional requirement | SRS §7 / §8 |
| BR-nnn, A-nnn, OQ-nnn, D-nn | Business rule, assumption, open question (all decided), Product Owner decision | SRS §11, §19 |
| AT-nn / QT-nn | Appointment / queue transition | SRS §9 |
| TC-xxx-nnn | Test case (§16.1–16.7 original and rev B, §16.8 supplementary) | SRS §16, acceptance CSV |
| CAP-xxx-nn | Permission capability | Permission matrix CSV |
| ADR-nnn | Architecture or business decision | ADR log |
| C-nn / U-nn | Architecture finding / decision status | Architecture §3, §25 |
| SCn-BE-nn / SCn-FE-nn | Gate backend / frontend task | Plan §5–9 |
| IR-nn | Inconsistency register item | Register |

## 5. Gates and planning caps

| Gate | Scope | Planning cap |
|---|---|---|
| SC-1 | Foundation, clinic isolation, multi-clinic membership, minimal CI | $7.00 |
| SC-2 | Public QR portal and appointments | $9.00 |
| SC-3 | Walk-in tokens and live queue | $9.00 |
| SC-4 | Dashboards, UX and E2E | $6.00 |
| SC-5 | Release readiness (local Docker release) | $4.00 |
| **Total allocation** | | **$35.00** |

## 6. Credit ledger (to be filled by the user after each gate)

| Gate | Date closed | Balance before | Balance after | Spent | Planning cap | Within cap? | Deferred items | Approved to continue (name/date) |
|---|---|---|---|---|---|---|---|---|
| SC-1 | | | | | $7.00 | | | |
| SC-2 | | | | | $9.00 | | | |
| SC-3 | | | | | $9.00 | | | |
| SC-4 | | | | | $6.00 | | | |
| SC-5 | | | | | $4.00 | | | |
| **Total** | | | | | **$35.00** | | | |

## 7. Change control

- Requirement changes go into a new SRS revision first; downstream documents follow.
- Decisions are recorded in SRS §19.3 and in the register. Decisions that change behaviour also get an ADR.
- Requirement and test IDs are never renumbered. A withdrawn item is marked Withdrawn.
- All files keep version v1.1. Revisions are tracked as “rev A”, “rev B” in each revision history.
