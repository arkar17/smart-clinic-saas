# Smart Clinic — Requirements Traceability Matrix v1.1

| Field | Value |
|---|---|
| Sources | SRS v1.1 rev B (FR/NFR/TC IDs), Technical Architecture v1.1 rev B (entities, endpoints, ADRs), Implementation & QA Plan v1.1 rev B (gates) |
| Date | 26 October 2026 (revision B) |
| Status | Baseline candidate v1.1 rev B, ready for Product Owner freeze |
| Coverage | 106 functional requirements (102 original + 4 added in rev B; 100 % mapped to a gate or explicit deferral), 36 non-functional requirements, 118 test cases (75 original SRS §16.1–16.7, 36 supplementary in SRS §16.8, 7 new rev B membership/phone tests) |

**Revision B changes:** FR-STF-007, FR-SEC-012, FR-PLT-006 (multi-clinic membership model, D-01) and FR-QUE-020 (no-phone staff exception, D-12) added; FR-STF-001…005, FR-PLT-003…005, FR-DOC-001, FR-SEC-002/005, FR-QUE-003/006/016, FR-RPT-001, FR-CLN-006 and FR-AUD-001 reworded. No requirement or test ID was removed or renumbered.

**Legend.** Gate = owning implementation gate (SC-1 … SC-5) or DEFERRED. Entities = physical tables (Architecture §11). Endpoints = REST routes (Architecture §13) or the cross-cutting mechanism that implements the requirement. Screens = SRS §15.1 IDs. Tests = all tests that verify the requirement (SRS §16, including the §16.8 supplementary tests and the rev B membership/phone tests). Acceptance criterion = the expected result of the primary test. Notes record partial deferrals.

## 1. Summary by gate

| Gate | Name | Budget cap | MUST | SHOULD | COULD | Total FRs |
|---|---|---|---|---|---|---|
| SC-1 | Foundation and Clinic Isolation | $7.00 | 37 | 3 | 0 | 40 |
| SC-2 | Public QR Portal and Appointments | $9.00 | 26 | 2 | 0 | 28 |
| SC-3 | Walk-In Tokens and Live Queue | $9.00 | 19 | 6 | 0 | 25 |
| SC-4 | Dashboards, UX and E2E | $6.00 | 5 | 4 | 0 | 9 |
| SC-5 | Release Readiness | $4.00 | 2 | 1 | 0 | 3 |
| DEFERRED | Deferred beyond MVP | — | 0 | 0 | 1 | 1 |
| **Total** | | **$35.00** | | | | **106** |

Priorities such as “MUST (reschedule SHOULD)” are counted as MUST.

## 2. SC-1 — Foundation and Clinic Isolation

| FR | Priority | Requirement | Entities | Endpoints / mechanism | Screens | Tests | Acceptance criterion | Notes |
|---|---|---|---|---|---|---|---|---|
| FR-PLT-001 | MUST | The Platform Administrator shall create a clinic tenant with name, slug, IANA time zone and the first Clinic Admin’s name and email. The new clinic… | clinic, app_user, clinic_member | POST /api/platform/clinics | PA-01 | TC-PLT-001 | TC-PLT-001: activation is refused listing missing checklist items; after setup, activation succeeds and slug becomes immutable |  |
| FR-PLT-002 | MUST | The Platform Administrator shall activate a clinic only when the setup checklist passes: weekly operating hours defined, ≥ 1 active service, ≥ 1… | clinic (checks clinic_business_hour, clinic_service, doctor, doctor_availability, doctor_service) | POST /api/platform/clinics/:id/activate | PA-01 | TC-PLT-001 | TC-PLT-001: activation is refused listing missing checklist items; after setup, activation succeeds and slug becomes immutable |  |
| FR-PLT-003 | MUST | The Platform Administrator shall suspend and reactivate a clinic, with a mandatory reason. While SUSPENDED: the public portal shows “currently… | clinic, session | POST /api/platform/clinics/:id/suspend; POST /api/platform/clinics/:id/reactivate | PA-01 | TC-PLT-002, TC-QR-002, TC-SEC-013 | TC-QR-002: an “unavailable” page is shown and booking/walk-in APIs return 404 |  |
| FR-PLT-004 | MUST | The Platform Administrator shall see a clinic list with metadata (name, slug, status, created date, active membership count) and aggregate… | clinic, clinic_member, app_user (metadata, aggregates) | GET /api/platform/clinics; GET /api/platform/users?email= | PA-01 | TC-SEC-002 | TC-SEC-002: 403/404; PA clinic list contains only metadata and aggregates |  |
| FR-PLT-005 | SHOULD | The Platform Administrator shall be able to reset any staff account’s password to a one-time temporary password. This is the only reset path for… | app_user, session | POST /api/platform/users/:id/password-reset | PA-01 | TC-PLT-003 | TC-PLT-003: a temporary password is shown once and must be changed at next login |  |
| FR-PLT-006 | SHOULD | The Platform Administrator shall deactivate and reactivate a global staff account with a mandatory reason. Deactivation blocks login and revokes all… | app_user, session | POST /api/platform/users/:id/deactivate; POST /api/platform/users/:id/reactivate | PA-01 | TC-PLT-004 | TC-PLT-004: login is refused and all sessions in both clinics are revoked within 60 s while memberships stay unchanged; reactivation restores access; a PLATFORM_ADMIN account cannot be added as a… |  |
| FR-CLN-001 | MUST | Clinic Admin shall maintain the clinic profile: display name, address, contact phone, IANA time zone, default phone region (ISO 3166 alpha-2) and… | clinic | GET /api/clinic/profile; PATCH /api/clinic/profile | A-01 | TC-CLN-003 | TC-CLN-003: changes appear on the portal; time zone is read-only after activation | Logo upload (COULD) deferred — C-10/ADR-022 |
| FR-CLN-002 | MUST | Each clinic shall have a globally unique slug (BR-010). The slug is editable only while PENDING_SETUP and becomes immutable on first activation so… | clinic | PATCH /api/clinic/profile | A-01, A-06 | TC-QR-003 | TC-QR-003: the QR payload is unchanged and the slug cannot be edited |  |
| FR-CLN-003 | MUST | Clinic Admin shall define weekly operating hours: for each weekday either CLOSED or one opening time and one closing time with zero to three breaks… | clinic_business_hour | GET /api/clinic/business-hours; PUT /api/clinic/business-hours | A-02 | TC-CLN-001, TC-SCH-001, TC-SCH-003, TC-SCH-006 | TC-CLN-001: 422 with field errors; valid hours save |  |
| FR-CLN-004 | MUST | Clinic Admin shall create, edit and delete closures: full-day (one or more dates, e.g. public holidays) or partial (a date with a start and end… | clinic_closure | GET /api/clinic/closures; POST /api/clinic/closures; PATCH /api/clinic/closures/:id; DELETE /api/clinic/closures/:id | A-02 | TC-CLN-002, TC-SCH-005 | TC-CLN-002: no slots exist tomorrow and none in 14:00–16:00 the day after; walk-in is ineligible on the closed day |  |
| FR-CLN-005 | MUST | Clinic Admin shall configure booking settings: slot granularity (5, 10, 15, 20, 30 or 60 min; default 15), reservation hold period (5–30 min; default… | clinic | GET /api/clinic/settings; PATCH /api/clinic/settings | A-01 | TC-APT-015 | TC-APT-015: public slots earlier than now+60 min or after day 30 are not offered and are rejected if requested directly |  |
| FR-CLN-006 | MUST | Clinic Admin shall configure walk-in settings: QR walk-in enabled (yes/no), daily walk-in capacity (1–500), registration opens (minutes relative to… | clinic | GET /api/clinic/settings; PATCH /api/clinic/settings | A-01 | TC-QUE-002, TC-QUE-003, TC-QUE-019 | TC-QUE-002: join is refused with the specific reason in each case and no token consumed | Per-doctor daily cap (COULD) deferred — C-10/ADR-022 |
| FR-STF-001 | MUST | Clinic Admin shall add staff to the clinic by email with one or more clinic roles: CLINIC_ADMIN, RECEPTIONIST, DOCTOR. If the email belongs to an… | app_user, clinic_member | GET /api/staff; POST /api/staff; PATCH /api/staff/:memberId | A-05 | TC-STF-001, TC-STF-004 | TC-STF-001: a global account and membership are created, a temporary password is shown once and first login forces a change; when CA adds an existing account’s email, then only a membership is created… |  |
| FR-STF-002 | MUST | A newly created global account shall receive a one-time temporary password, displayed once to the creator, and must change it at first login. Adding… | app_user | POST /api/staff | S-01, S-02 | TC-STF-001 | TC-STF-001: a global account and membership are created, a temporary password is shown once and first login forces a change; when CA adds an existing account’s email, then only a membership is created… |  |
| FR-STF-003 | MUST | Clinic Admin shall deactivate and reactivate staff memberships in their clinic. Deactivation shall revoke the user’s access to that clinic within 60… | clinic_member, session | POST /api/staff/:memberId/deactivate; POST /api/staff/:memberId/reactivate | A-05 | TC-QUE-022, TC-STF-002, TC-STF-005 | TC-STF-002: their next request within 60 s returns 403 CLINIC_SELECTION_REQUIRED and the account cannot select any clinic |  |
| FR-STF-004 | MUST | Each clinic shall always have at least one active membership with the CLINIC_ADMIN role; the system shall prevent removing that role from, or… | clinic_member | PATCH /api/staff/:memberId; POST /api/staff/:memberId/deactivate | A-05 | TC-STF-003 | TC-STF-003: the action is refused |  |
| FR-STF-005 | SHOULD | Clinic Admin shall reset a staff user’s password to a temporary password only when that user has no membership in any other clinic (BR-084);… | app_user, clinic_member, session | POST /api/staff/:memberId/reset-password | A-05 | TC-STF-001, TC-STF-006 | TC-STF-001: a global account and membership are created, a temporary password is shown once and first login forces a change; when CA adds an existing account’s email, then only a membership is created… |  |
| FR-STF-006 | MUST | Any staff user shall change their own password. | app_user, session | POST /api/auth/change-password | S-02 | TC-SEC-009 | TC-SEC-009: Password rules enforced; 6th failed login within 15 min is blocked; idle session expires after 60 min; logout invalidates the session |  |
| FR-STF-007 | MUST | A staff user with more than one active membership shall select the active clinic after login and may switch between clinics where they hold an active… | app_user, clinic_member, session (active_clinic_id, active_member_id) | GET /api/auth/me; POST /api/auth/select-clinic | S-01, S-03, staff header switcher | TC-STF-004, TC-STF-005 | TC-STF-004: clinic selection is required; with A selected U has receptionist permissions only, cannot call patients and receives 404 for every B resource; after switching to B (CSRF rotated, A stream… |  |
| FR-SVC-001 | MUST | Clinic Admin shall create and edit services with: name (2–80 chars), short operational description (≤ 300 chars, no clinical advice), duration (5–240… | clinic_service | GET /api/services; POST /api/services; PATCH /api/services/:id | A-03 | TC-SVC-001 | TC-SVC-001: refused; when deactivated, it disappears from portal and remains in reports |  |
| FR-SVC-002 | MUST | Clinic Admin shall assign one or more eligible doctors to each service. | doctor_service | PUT /api/services/:id/doctors | A-03 | TC-APT-001 | TC-APT-001: that doctor is preselected and the flow proceeds to date selection; a service with zero eligible doctors is not listed |  |
| FR-SVC-003 | MUST | A service shall not be deleted once it has any appointment or queue entry; it may be deactivated. Inactive services are hidden from new bookings and… | clinic_service | PATCH /api/services/:id; DELETE /api/services/:id | A-03 | TC-SVC-001 | TC-SVC-001: refused; when deactivated, it disappears from portal and remains in reports |  |
| FR-DOC-001 | MUST | Clinic Admin shall create doctor profiles with display name, public title/specialty label (non-clinical, e.g. “General Practitioner”), active flag… | doctor, clinic_member | GET /api/doctors; POST /api/doctors; PATCH /api/doctors/:id | A-04 | TC-DOC-003, TC-DOC-004 | TC-DOC-003: refused; a link to a membership of another clinic is impossible (composite FK) (BR-082) |  |
| FR-DOC-002 | MUST | Clinic Admin shall define each doctor’s weekly schedule: per weekday, not working or one start and end time with zero to three breaks. | doctor_availability | PUT /api/doctors/:id/availability | A-04 | TC-DOC-001, TC-SCH-004 | TC-DOC-001: a warning is shown and slots exist only 09:00–18:00 |  |
| FR-DOC-003 | MUST | Clinic Admin shall add schedule exceptions for a doctor: unavailable (full day or time range, e.g. leave) or modified hours for a specific date. | schedule_exception | GET /api/doctors/:id/exceptions; POST /api/doctors/:id/exceptions; DELETE /api/doctors/:id/exceptions/:exId | A-04 | TC-DOC-002, TC-SCH-005 | TC-DOC-002: no slots for that doctor in that range; other doctors unaffected |  |
| FR-DOC-004 | MUST | A doctor’s bookable time shall be the intersection of clinic availability and doctor availability (Section 12). Doctor hours outside clinic hours may… | doctor_availability, clinic_business_hour, clinic_closure, schedule_exception | GET /api/public/clinics/:slug/availability/slots; GET /api/public/clinics/:slug/availability/slots; GET /api/doctors/:id/schedule | A-04, P-04 | TC-DOC-001, TC-SCH-001, TC-SCH-002 | TC-DOC-001: a warning is shown and slots exist only 09:00–18:00 |  |
| FR-DOC-005 | MUST | A Doctor user shall view their own schedule, exceptions and appointments for any date, but not those of other doctors. | doctor, appointment | GET /api/doctors; GET /api/doctors/:id/schedule?from&to | D-02 | TC-SEC-004 | TC-SEC-004: 403/404 |  |
| FR-SEC-001 | MUST | Staff shall authenticate with email and password. Passwords shall be hashed with Argon2id (or bcrypt cost ≥ 12 if Argon2id is unavailable) and meet… | app_user | POST /api/auth/login | S-01 | TC-SEC-009 | TC-SEC-009: Password rules enforced; 6th failed login within 15 min is blocked; idle session expires after 60 min; logout invalidates the session |  |
| FR-SEC-002 | MUST | Sessions shall use server-side session records referenced by an HttpOnly, Secure, SameSite=Lax cookie; idle timeout 60 min and absolute lifetime 12 h… | session (selected membership) | POST /api/auth/login; POST /api/auth/logout; GET /api/auth/me; POST /api/auth/select-clinic | S-01 (all staff) | TC-SEC-009, TC-STF-004 | TC-SEC-009: Password rules enforced; 6th failed login within 15 min is blocked; idle session expires after 60 min; logout invalidates the session |  |
| FR-SEC-003 | MUST | After 5 failed logins for one account within 15 min, further attempts shall be delayed/blocked for 15 min; responses shall not reveal whether the… | app_user | POST /api/auth/login | S-01 | TC-SEC-009 | TC-SEC-009: Password rules enforced; 6th failed login within 15 min is blocked; idle session expires after 60 min; logout invalidates the session |  |
| FR-SEC-004 | MUST | Every staff API request shall be authorised server-side against the permissions matrix (Section 10). UI hiding is not a security control. | clinic_member | middleware: requirePermission (all staff routes) | all staff screens | TC-SEC-003, TC-SEC-016 | TC-SEC-003: 403 |  |
| FR-SEC-005 | MUST | The clinic context shall be derived only from the session’s selected active membership (staff) or the clinic slug/access token (public), never from a… | all 16 tenant tables (clinic_id, composite FKs); session → clinic_member | middleware: resolveClinicContext + repositories (all tenant routes) | all staff screens | TC-SEC-001, TC-SEC-012, TC-SEC-017, TC-STF-004 | TC-SEC-001: 404 and no data leak in body or timing-insensitive fields |  |
| FR-SEC-008 | MUST | All API inputs shall be validated with shared Zod schemas; unknown fields shall be rejected. | — (contracts) | middleware: Zod validation (all routes) | all forms | TC-APT-008, TC-VAL-001, TC-VAL-003 | TC-APT-008: 422 with field errors and the hold remains PENDING |  |
| FR-SEC-009 | MUST | State-changing staff requests shall be protected against CSRF (SameSite cookie plus synchroniser or double-submit token, and Origin check). | session (csrf_secret) | middleware: CSRF (all staff non-GET) | all staff forms | TC-SEC-010 | TC-SEC-010: 403 |  |
| FR-SEC-010 | MUST | Logs shall not contain access tokens, reservation secrets, passwords or full phone numbers; URLs containing tokens shall be redacted before logging. | — (logger config) | logger redaction (all routes) | — (server) | TC-SEC-011 | TC-SEC-011: application logs contain no access tokens, reservation secrets, passwords or full phone numbers |  |
| FR-SEC-011 | MUST | Platform Administrator accounts shall have no permission on clinic-tenant patient, appointment or queue resources, and no impersonation feature shall… | app_user (platform_role) | platform router has no tenant data endpoints | PA-01 | TC-SEC-002 | TC-SEC-002: 403/404; PA clinic list contains only metadata and aggregates |  |
| FR-SEC-012 | MUST | Every staff request shall carry the client’s expected active clinic (X-Clinic-Id header). The server shall reject the request with 409… | session, clinic_member | POST /api/auth/select-clinic; middleware: selected-membership re-validation + X-Clinic-Id check (all staff routes); POST /api/auth/select-clinic | all staff screens (header) | TC-SEC-017 | TC-SEC-017: 409 CLINIC_CONTEXT_MISMATCH; when the user selects a clinic where they have no active membership, then 403; a clinicId field in any request body is rejected (422); a database attempt to… |  |
| FR-AUD-001 | MUST | The system shall record an audit event for: logins (success/failure), logout, clinic selection and switching, password changes and resets; global… | audit_log | audit writer inside every mutating route | — (server) | TC-SEC-008 | TC-SEC-008: audit events with required fields exist; UPDATE/DELETE on the audit table by the app role fails |  |
| FR-AUD-002 | MUST | Each event shall store: event ID, UTC timestamp, clinic ID (nullable for platform events), actor type (STAFF, PUBLIC_PATIENT, SYSTEM), actor user ID… | audit_log | audit writer | — (server) | TC-SEC-008 | TC-SEC-008: audit events with required fields exist; UPDATE/DELETE on the audit table by the app role fails |  |
| FR-AUD-003 | MUST | Audit records shall be append-only: the application database role shall have no UPDATE or DELETE privilege on the audit table. | audit_log (grants) | migration grants | — (database) | TC-NFR-007, TC-SEC-008 | TC-SEC-008: audit events with required fields exist; UPDATE/DELETE on the audit table by the app role fails |  |

## 3. SC-2 — Public QR Portal and Appointments

| FR | Priority | Requirement | Entities | Endpoints / mechanism | Screens | Tests | Acceptance criterion | Notes |
|---|---|---|---|---|---|---|---|---|
| FR-CLN-008 | MUST | Changes to hours, closures, schedules or services shall not alter or cancel existing CONFIRMED appointments. The system shall list affected… | appointment, notification_job | PUT /api/clinic/business-hours | R-07 | TC-APT-014 | TC-APT-014: the appointment stays CONFIRMED and appears in Conflicts |  |
| FR-CLN-009 | MUST | The public clinic portal shall be available only when the clinic status is ACTIVE. | clinic | GET /api/public/clinics/:slug (status gate) | P-01, P-11 | TC-QR-002 | TC-QR-002: an “unavailable” page is shown and booking/walk-in APIs return 404 |  |
| FR-SVC-004 | MUST | A service with zero active eligible doctors shall not be offered publicly. | clinic_service, doctor_service, doctor | GET /api/public/clinics/:slug/services?mode=booking\|walk_in; GET /api/public/clinics/:slug/services (filter) | P-02 | TC-APT-001 | TC-APT-001: that doctor is preselected and the flow proceeds to date selection; a service with zero eligible doctors is not listed |  |
| FR-PAT-001 | MUST | The system shall store a clinic-scoped patient record containing only: full name as entered, normalised phone (E.164), creation source (QR_BOOKING,… | patient | POST …/reservations/:id/confirm; POST …/walk-ins; POST /api/appointments; POST /api/queue/walk-ins | R-08 | TC-PAT-001 | TC-PAT-001: the same patient is reused; when it uses “Malee Demo” with the same phone, then a new patient is created |  |
| FR-PAT-002 | MUST | On public or staff registration, the system shall reuse an existing patient in the same clinic where normalised phone matches and the normalised name… | patient | POST …/reservations/:id/confirm; POST …/walk-ins; POST /api/appointments; POST /api/queue/walk-ins | P-05, P-09, R-04, R-05 | TC-PAT-001, TC-VAL-002 | TC-PAT-001: the same patient is reused; when it uses “Malee Demo” with the same phone, then a new patient is created |  |
| FR-PAT-006 | MUST | Patient records shall never be linked, matched or searchable across clinics, including where the same phone number appears in several clinics. | patient | cross-cutting: repository scoping | — (server-side) | TC-SEC-001 | TC-SEC-001: 404 and no data leak in body or timing-insensitive fields |  |
| FR-QR-001 | MUST | Each clinic shall have exactly one permanent QR code that encodes only the canonical public URL https://<host>/c/<slug> (optionally with ?src=qr).… | clinic | GET /api/clinic/qr.png \| qr.svg | P-01, A-06 | TC-QR-001 | TC-QR-001: clinic details, today’s hours and both actions are shown |  |
| FR-QR-002 | MUST (poster SHOULD) | Clinic Admin shall download the QR code as PNG (≥ 1024 px) and SVG, and a printable A4 poster with clinic name, short instructions and the URL in… | clinic | GET /api/clinic/qr.png \| qr.svg | A-06 | TC-QR-004 | TC-QR-004: both decode to the canonical URL; the poster PDF/print view contains name, instructions and URL text | Printable poster is SHOULD; PNG/SVG MUST |
| FR-QR-003 | MUST | The QR code and public URL shall remain valid for the life of the clinic regardless of settings changes. | clinic | GET /api/clinic/qr.png \| qr.svg | A-06 | TC-QR-003 | TC-QR-003: the QR payload is unchanged and the slug cannot be edited |  |
| FR-QR-004 | MUST | The public portal shall show clinic name, address, contact phone, today’s opening hours or closure label, walk-in status (open / opens at / closed /… | clinic, clinic_business_hour, clinic_closure, queue_counter | GET /api/public/clinics/:slug | P-01 | TC-QR-001, TC-SCH-006 | TC-QR-001: clinic details, today’s hours and both actions are shown |  |
| FR-QR-005 | MUST | Each portal action shall be disabled with a plain-language reason when unavailable (e.g. no bookable services; walk-ins full; registration closes at… | clinic, clinic_service, queue_counter | GET /api/public/clinics/:slug | P-01 | TC-QUE-002 | TC-QUE-002: join is refused with the specific reason in each case and no token consumed |  |
| FR-APT-001 | MUST | The public booking flow shall list active services with online booking enabled and ≥ 1 active eligible doctor, showing name, description and duration. | clinic_service, doctor_service | GET /api/public/clinics/:slug/services?mode=booking\|walk_in | P-02 | TC-APT-001 | TC-APT-001: that doctor is preselected and the flow proceeds to date selection; a service with zero eligible doctors is not listed |  |
| FR-APT-002 | MUST | If exactly one eligible doctor exists for the chosen service, that doctor shall be preselected and shown; if several exist, the patient shall choose… | doctor_service, doctor | GET /api/public/clinics/:slug/services?mode=booking\|walk_in; GET /api/public/clinics/:slug/services?mode=booking (eligible doctors) | P-03 | TC-APT-001, TC-APT-002 | TC-APT-001: that doctor is preselected and the flow proceeds to date selection; a service with zero eligible doctors is not listed |  |
| FR-APT-003 | MUST | The system shall return available start times for a given service, doctor and date, and the list of dates with availability within the booking… | appointment, clinic_business_hour, clinic_closure, doctor_availability, schedule_exception | GET /api/public/clinics/:slug/availability/dates; GET /api/public/clinics/:slug/availability/slots | P-04 | TC-APT-003 | TC-APT-003: the availability API returns exactly the listed start times |  |
| FR-APT-004 | MUST | Availability shall be computed according to Section 12, honouring clinic hours, clinic breaks, closures, doctor hours, doctor breaks, doctor… | appointment, clinic_business_hour, clinic_closure, doctor_availability, schedule_exception | GET /api/public/clinics/:slug/availability/slots | P-04 | TC-APT-003 | TC-APT-003: the availability API returns exactly the listed start times |  |
| FR-APT-005 | MUST | Selecting a time shall create a reservation: a PENDING appointment holding that doctor-time range for the hold period, returning reservation ID, a… | appointment, idempotency_record | POST /api/public/clinics/:slug/reservations | P-04, P-05 | TC-APT-005, TC-APT-006, TC-APT-020 | TC-APT-005: at 10:09:59 the slot is blocked and at 10:10:00 it is offered again even with the expiry job stopped; the job later sets EXPIRED |  |
| FR-APT-006 | MUST | Confirmation shall require reservation ID, reservation secret, name, phone, privacy-notice acknowledgement and idempotency key, and shall atomically:… | appointment, patient, idempotency_record | POST /api/public/clinics/:slug/reservations/:id/confirm | P-05 | TC-APT-007, TC-APT-008, TC-APT-010, TC-APT-021, TC-VAL-004 | TC-APT-007: 410 HOLD_EXPIRED and no reference is issued |  |
| FR-APT-007 | MUST | On confirmation, the system shall generate a unique booking reference (BR-020) and a private access token (BR-022), and show a confirmation page with… | appointment, public_access_token | POST /api/public/clinics/:slug/reservations/:id/confirm; GET /api/public/booking/calendar.ics | P-06 | TC-APT-009 | TC-APT-009: the response contains reference SC-XXXXXXXX and private link; the link shows masked details; no public endpoint returns data for the reference alone | .ics calendar file is SHOULD |
| FR-APT-008 | MUST | The private booking page shall show clinic, service, doctor, date/time, status, booking reference, the patient’s first name and masked phone; once… | appointment, public_access_token, queue_entry | GET /api/public/booking | P-07 | TC-APT-009, TC-APT-022, TC-QUE-014 | TC-APT-009: the response contains reference SC-XXXXXXXX and private link; the link shows masked details; no public endpoint returns data for the reference alone |  |
| FR-APT-009 | SHOULD | The patient shall cancel a CONFIRMED appointment from the private page until the cancellation cutoff; after the cutoff, the page shall show the… | appointment, public_access_token | POST /api/public/booking/cancel | P-07 | TC-APT-011 | TC-APT-011: CANCELLED and slot freed; at 1 h before, cancel is refused and clinic phone shown |  |
| FR-APT-010 | MUST | Clinic Admin and Receptionist shall create appointments on a patient’s behalf. Staff-created appointments are created directly as CONFIRMED subject… | appointment, patient, public_access_token | GET /api/availability/slots; POST /api/appointments | R-04 | TC-APT-016, TC-APT-021 | TC-APT-016: it is CONFIRMED (no minimum notice for staff) and appears in day view |  |
| FR-APT-011 | MUST (reschedule SHOULD) | Clinic Admin and Receptionist shall cancel (with reason) and reschedule CONFIRMED appointments. Rescheduling keeps the same booking reference and… | appointment, public_access_token | POST /api/appointments/:id/reschedule; POST /api/appointments/:id/cancel | R-03, R-04 | TC-APT-017, TC-APT-019, TC-APT-020 | TC-APT-017: 409 and the original slot is retained; to a free slot, then reference and link are unchanged |  |
| FR-APT-014 | MUST | PENDING appointments past expiry shall be treated as non-blocking immediately (query-time check) and set to EXPIRED by a background job at least… | appointment | worker job: hold-expiry sweep | — (worker) | TC-APT-005 | TC-APT-005: at 10:09:59 the slot is blocked and at 10:10:00 it is offered again even with the expiry job stopped; the job later sets EXPIRED |  |
| FR-APT-015 | MUST | Staff shall view appointments as a day list per doctor and a filterable list (date range, doctor, service, status). | appointment | GET /api/appointments; GET /api/appointments/:id | R-03, D-02 | TC-APT-016 | TC-APT-016: it is CONFIRMED (no minimum notice for staff) and appears in day view |  |
| FR-APT-016 | MUST | The system shall show a “Conflicts” view of future CONFIRMED appointments that no longer fit current hours, closures, schedules or exceptions, with… | appointment, notification_job | GET /api/appointments/conflicts | R-07 | TC-APT-014 | TC-APT-014: the appointment stays CONFIRMED and appears in Conflicts |  |
| FR-APT-017 | SHOULD | The system shall reject public confirmation when the phone already has the configured maximum number of active future appointments at the clinic… | appointment, patient | POST /api/public/clinics/:slug/reservations/:id/confirm | P-05 | TC-APT-018 | TC-APT-018: 409 BOOKING_LIMIT_REACHED |  |
| FR-SEC-006 | MUST | Private access tokens shall be generated with a CSPRNG (≥ 256 bits, base64url), stored only as SHA-256 hashes, compared in constant time and expire… | public_access_token | GET /api/public/booking; GET /api/public/queue-entry; GET /api/public/stream | P-07, P-10, P-11 | TC-SEC-006, TC-SEC-015 | TC-SEC-006: a generic 404 page; DB stores only token hashes |  |
| FR-SEC-007 | MUST | Public endpoints shall be rate-limited per IP and per clinic (Section 14.5) and return 429 with Retry-After when exceeded. | appointment (hold hashes); in-memory limiter | middleware: rate limiter on /api/public/*, /api/auth/login | P-04, P-05, P-09, P-11 | TC-APT-023, TC-SEC-005 | TC-SEC-005: 429 with Retry-After |  |

## 4. SC-3 — Walk-In Tokens and Live Queue

| FR | Priority | Requirement | Entities | Endpoints / mechanism | Screens | Tests | Acceptance criterion | Notes |
|---|---|---|---|---|---|---|---|---|
| FR-CLN-007 | SHOULD | Clinic Admin or Receptionist shall pause and resume QR walk-in registration for today. Pause takes effect for all new registrations immediately and… | queue_counter | PUT /api/clinic/walk-in-pause; DELETE /api/clinic/walk-in-pause | R-02 (R-01 in SC-4) | TC-QUE-002 | TC-QUE-002: join is refused with the specific reason in each case and no token consumed |  |
| FR-DOC-006 | SHOULD | A Doctor or Receptionist shall mark a doctor “unavailable for the rest of today”, which creates a same-day exception, removes the doctor from walk-in… | schedule_exception, queue_entry, notification_job | POST /api/doctors/:id/unavailable-today | D-01, R-02 | TC-QUE-015 | TC-QUE-015: they disappear from walk-in options and their WAITING entries can be reassigned keeping token and sort time |  |
| FR-PAT-003 | MUST | Staff shall search patients, appointments and queue entries in their clinic by phone (full or last 4 digits), name (partial), booking reference or… | patient, appointment, queue_entry | GET /api/search?q= | R-06 | TC-PAT-002 | TC-PAT-002: matching patients in own clinic only are returned with visit history |  |
| FR-APT-012 | MUST | Receptionist or Clinic Admin shall check in a CONFIRMED appointment within the check-in window (override with reason allowed, A-019). Check-in shall… | appointment, queue_entry, queue_counter | POST /api/appointments/:id/check-in | R-06, R-03 | TC-APT-012, TC-APT-024, TC-QUE-027 | TC-APT-012: appointment CHECKED_IN, a queue entry WAITING with next token exists, and the private page shows the token |  |
| FR-APT-013 | MUST | Staff shall mark a CONFIRMED appointment NO_SHOW after the no-show grace period. At clinic day close, remaining CONFIRMED appointments for that day… | appointment | POST /api/appointments/:id/no-show | R-03 | TC-APT-013 | TC-APT-013: it becomes NO_SHOW; staff can mark NO_SHOW earlier only after grace |  |
| FR-QUE-001 | MUST | “Join Today’s Queue” shall check eligibility (Section 12.6) before showing the form and again inside the registration transaction, returning a… | clinic, queue_counter, doctor_availability, schedule_exception | GET /api/public/clinics/:slug/walk-in/eligibility; POST /api/public/clinics/:slug/walk-ins | P-08 | TC-QUE-001, TC-QUE-002, TC-QUE-003, TC-QUE-019 | TC-QUE-001: status REGISTERED, token shown, private link works |  |
| FR-QUE-002 | MUST | The walk-in flow shall list only active services with walk-in enabled and, per service, only doctors with remaining working time today (now <… | clinic_service, doctor_service, doctor | GET /api/public/clinics/:slug/services?mode=booking\|walk_in; POST /api/public/clinics/:slug/walk-ins | P-08 | TC-QUE-001 | TC-QUE-001: status REGISTERED, token shown, private link works |  |
| FR-QUE-003 | MUST | Walk-in registration shall require name, phone, privacy-notice acknowledgement and idempotency key (same validation as appointments). Public forms… | patient, idempotency_record | POST /api/public/clinics/:slug/walk-ins | P-09 | TC-QUE-001, TC-VAL-004 | TC-QUE-001: status REGISTERED, token shown, private link works |  |
| FR-QUE-004 | MUST | Each queue entry shall receive a token number unique per clinic per clinic-local date, allocated sequentially from 1 with no duplicates under… | queue_counter, queue_entry | POST /api/public/clinics/:slug/walk-ins; POST /api/public/clinics/:slug/walk-ins; POST /api/queue/walk-ins; POST /api/appointments/:id/check-in | P-10, R-05 | TC-QUE-001, TC-QUE-004, TC-QUE-013, TC-QUE-027 | TC-QUE-004: tokens are exactly 1..50 with no duplicates or gaps |  |
| FR-QUE-005 | MUST | A QR walk-in entry shall be created with status REGISTERED. The patient shall immediately see the token, status and private status link, and a clear… | queue_entry, public_access_token | POST /api/public/clinics/:slug/walk-ins | P-10 | TC-QUE-001, TC-QUE-005 | TC-QUE-001: status REGISTERED, token shown, private link works |  |
| FR-QUE-006 | MUST | Receptionist or Clinic Admin shall register a staff walk-in for a patient who is present, with name and phone (no-phone exception: FR-QUE-020); the… | queue_entry, queue_counter, patient | POST /api/queue/walk-ins | R-05 | TC-QUE-016, TC-QUE-025 | TC-QUE-016: an override reason is required and the entry starts WAITING |  |
| FR-QUE-007 | MUST | Receptionist or Clinic Admin shall confirm arrival of a REGISTERED entry, moving it to WAITING and recording arrived_at. | queue_entry | POST /api/queue/entries/:id/confirm-arrival | R-02, R-06 | TC-QUE-005, TC-QUE-026 | TC-QUE-005: it is absent from the doctor’s line and people-ahead counts; when reception confirms arrival, then WAITING with arrived_at set and position computed |  |
| FR-QUE-008 | MUST | Each doctor shall have an ordered waiting line of WAITING entries ordered by queue sort time ascending, then token number (BR-060). REGISTERED… | queue_entry | GET /api/queue/today | R-02, D-01 | TC-QUE-005, TC-QUE-006, TC-QUE-026 | TC-QUE-005: it is absent from the doctor’s line and people-ahead counts; when reception confirms arrival, then WAITING with arrived_at set and position computed |  |
| FR-QUE-009 | MUST | The doctor (or Clinic Admin on the doctor’s behalf) shall “Call next”, which moves the head of that doctor’s waiting line to CALLED. Calling a… | queue_entry | POST /api/queue/doctors/:doctorId/call-next; POST /api/queue/entries/:id/call | D-01 | TC-DOC-004, TC-QUE-006, TC-QUE-007 | TC-QUE-006: the correct head becomes CALLED; Start and Complete progress the state |  |
| FR-QUE-010 | MUST | The doctor (or Clinic Admin) shall Start (CALLED → IN_CONSULTATION) and Complete (IN_CONSULTATION → COMPLETED). Completing a SCHEDULED entry also… | queue_entry, appointment | POST /api/queue/entries/:id/start; POST /api/queue/entries/:id/complete | D-01 | TC-APT-024, TC-QUE-006, TC-QUE-023 | TC-QUE-006: the correct head becomes CALLED; Start and Complete progress the state |  |
| FR-QUE-011 | MUST | Authorised staff shall: return a CALLED entry to WAITING (patient absent; keeps original sort time and increments recall count); mark CALLED entry… | queue_entry, appointment, queue_counter | POST /api/queue/entries/:id/return-to-waiting; POST /api/queue/entries/:id/no-show; POST /api/queue/entries/:id/cancel | R-02, D-01 | TC-APT-024, TC-QUE-008, TC-QUE-024, TC-QUE-028 | TC-QUE-008: 409 INVALID_TRANSITION |  |
| FR-QUE-012 | MUST | A doctor shall have at most one entry in CALLED or IN_CONSULTATION at any time (enforced by database constraint). | queue_entry | POST /api/queue/doctors/:doctorId/call-next; POST /api/queue/entries/:id/call | D-01 | TC-QUE-010 | TC-QUE-010: 409 DOCTOR_BUSY |  |
| FR-QUE-013 | MUST | Queue changes shall be pushed via SSE to authorised subscribers: clinic staff stream, doctor stream, waiting-room display stream and the individual… | clinic_event | GET /api/public/stream; GET /api/staff/stream; GET /api/staff/stream; GET /api/public/stream; GET /api/display/stream | R-02, D-01, P-07, P-10, W-01 | TC-QUE-009, TC-QUE-021, TC-QUE-022, TC-SEC-007 | TC-QUE-009: all three render the change within 2 s (p95 over 20 runs) |  |
| FR-QUE-014 | MUST | The patient status page shall show: token, status in plain language, doctor display name, “now serving” token for that doctor, and — only when… | queue_entry, public_access_token | GET /api/public/queue-entry | P-10, P-07 | TC-QUE-014 | TC-QUE-014: only their token, status, doctor, now-serving token and people ahead are present in the HTML and SSE payloads |  |
| FR-QUE-015 | SHOULD | The patient shall leave the queue from the status page while REGISTERED or WAITING (→ CANCELLED by PATIENT), after a confirmation prompt. | queue_entry, queue_counter | POST /api/public/queue-entry/leave | P-10 | TC-QUE-017, TC-QUE-020, TC-QUE-028 | TC-QUE-017: CANCELLED by PATIENT; when CALLED, leaving is refused |  |
| FR-QUE-016 | MUST | At clinic day close (performed within 5 minutes after local midnight) the system shall finalise non-terminal entries: REGISTERED → EXPIRED; WAITING… | queue_entry, appointment | worker job: day close | — (worker) | TC-QUE-011 | TC-QUE-011: REGISTERED → EXPIRED, WAITING/CALLED → CANCELLED (SYSTEM_DAY_CLOSE), IN_CONSULTATION → COMPLETED auto_closed |  |
| FR-QUE-017 | SHOULD | A waiting-room display screen (staff-launched, kiosk mode) shall show, per doctor, the token now being called and the next tokens. It shall show… | public_access_token (DISPLAY), clinic_event | GET /api/display/board; GET /api/display/stream; GET /api/clinic/display-keys; POST /api/clinic/display-keys; DELETE /api/clinic/display-keys/:id | W-01 | TC-QUE-018, TC-QUE-022, TC-QUE-026 | TC-QUE-018: it shows called and next tokens per doctor, never names/phones/service names, and updates live; revoking the display key ends the stream |  |
| FR-QUE-018 | MUST | Public walk-in registration shall be rejected when the same normalised phone already has a non-terminal queue entry at the clinic today… | queue_entry, patient, queue_counter | POST /api/public/clinics/:slug/walk-ins | P-09 | TC-QUE-012, TC-QUE-025 | TC-QUE-012: 409 DUPLICATE_ACTIVE_REGISTRATION and the response contains no link or token |  |
| FR-QUE-019 | SHOULD | Receptionist or Clinic Admin shall reassign a WAITING entry to another doctor who offers the same service and is available today; the entry keeps its… | queue_entry | POST /api/queue/entries/:id/reassign | R-02 | TC-QUE-015, TC-QUE-023 | TC-QUE-015: they disappear from walk-in options and their WAITING entries can be reassigned keeping token and sort time |  |
| FR-QUE-020 | SHOULD | Receptionist-assisted no-phone exception (separate staff workflow): for a patient who is physically present and has no phone, Receptionist or Clinic… | patient (no_phone_reason), queue_entry, queue_counter | POST /api/queue/walk-ins | R-05 | TC-QUE-029 | TC-QUE-029: the entry starts WAITING with no private link, the patient has no phone, no matching occurs and an audit event is written; without a reason → 422; a doctor-only user → 403 |  |

## 5. SC-4 — Dashboards, UX and E2E

| FR | Priority | Requirement | Entities | Endpoints / mechanism | Screens | Tests | Acceptance criterion | Notes |
|---|---|---|---|---|---|---|---|---|
| FR-PAT-004 | SHOULD | Clinic Admin and Receptionist shall correct a patient’s name or phone; each change is audited with old and new values masked. | patient, audit_log | PATCH /api/patients/:id | R-08 | TC-SEC-008 | TC-SEC-008: audit events with required fields exist; UPDATE/DELETE on the audit table by the app role fails |  |
| FR-PAT-005 | SHOULD | Staff shall view a patient’s operational visit history in their clinic (date, service, doctor, source, final status). | patient, appointment, queue_entry | GET /api/patients/:id | R-08 | TC-PAT-002 | TC-PAT-002: matching patients in own clinic only are returned with visit history |  |
| FR-RPT-001 | MUST | The Today dashboard (Clinic Admin, Receptionist; Doctor: own-doctor subset per Section 10) shall show, updating live: appointments by status;… | appointment, queue_entry, queue_counter | GET /api/reports/today | R-01, D-01 | TC-RPT-004 | TC-RPT-004: Today dashboard counters update live |  |
| FR-RPT-002 | MUST | Clinic Admin shall view a report for a selected date range (≤ 90 days, clinic-local dates) showing completed visits by day, source (SCHEDULED,… | appointment, queue_entry | GET /api/reports/summary?from&to | A-07 | TC-RPT-002 | TC-RPT-002: cancellation, no-show and expired-registration counts and rates match definitions for a range crossing a month boundary in clinic time zone |  |
| FR-RPT-003 | MUST | The report shall show waiting time (WAITING → first CALLED: median, p90, max) and consultation duration (IN_CONSULTATION → COMPLETED: median, p90),… | queue_entry | GET /api/reports/summary?from&to | A-07 | TC-RPT-001, TC-RPT-005 | TC-RPT-001: median, p90 and max waiting time and consultation duration match hand-calculated values; auto_closed entries excluded |  |
| FR-RPT-004 | MUST | The report shall show counts and rates of: appointment cancellations (by patient / by staff), appointment no-shows, expired walk-in registrations,… | appointment, queue_entry | GET /api/reports/summary?from&to | A-07 | TC-RPT-002, TC-RPT-006 | TC-RPT-002: cancellation, no-show and expired-registration counts and rates match definitions for a range crossing a month boundary in clinic time zone |  |
| FR-RPT-005 | SHOULD | Clinic Admin shall export the aggregate report as CSV. Exports shall contain no patient names or phone numbers. | appointment, queue_entry, audit_log | GET /api/reports/summary.csv?from&to | A-07 | TC-RPT-003 | TC-RPT-003: only clinic A data is included and the CSV has no names or phones |  |
| FR-RPT-006 | MUST | All report figures shall be computed in the clinic’s time zone and scoped to the requesting user’s clinic. | clinic, appointment, queue_entry | GET /api/reports/summary?from&to | A-07, R-01 | TC-RPT-003, TC-RPT-005 | TC-RPT-003: only clinic A data is included and the CSV has no names or phones |  |
| FR-AUD-004 | SHOULD | Clinic Admin shall view and filter the clinic’s audit log; Platform Administrator shall view platform-level events only. | audit_log | GET /api/platform/audit; GET /api/audit | A-08, PA-02 | TC-SEC-008 | TC-SEC-008: audit events with required fields exist; UPDATE/DELETE on the audit table by the app role fails |  |

## 6. SC-5 — Release Readiness

| FR | Priority | Requirement | Entities | Endpoints / mechanism | Screens | Tests | Acceptance criterion | Notes |
|---|---|---|---|---|---|---|---|---|
| FR-DEM-001 | MUST | A seed command shall create at least two fictional clinics with distinct time zones, staff for every role, services, doctors, schedules, closures and… | all (seed script) | script: pnpm db:seed | all (demo banner) | TC-DEM-001 | TC-DEM-001: After seed, two clinics with all roles and history exist, the demo banner is visible, and reset restores the seeded state |  |
| FR-DEM-002 | MUST | Fictional phone numbers shall use reserved/fictional ranges where available and names shall be obviously fictional; the demo UI shall display a “Demo… | patient, app_user (seed data) | script: pnpm db:seed | all (demo banner) | TC-DEM-001 | TC-DEM-001: After seed, two clinics with all roles and history exist, the demo banner is visible, and reset restores the seeded state |  |
| FR-DEM-003 | SHOULD | A reset command shall restore the demo database to its seeded state. | all (reset script) | script: pnpm db:reset | — (script) | TC-DEM-001 | TC-DEM-001: After seed, two clinics with all roles and history exist, the demo banner is visible, and reset restores the seeded state |  |

## 7. Deferred requirements

| FR | Priority | Requirement | Reason | Proposed timing |
|---|---|---|---|---|
| FR-QR-006 | COULD | The system shall count portal visits per clinic per day, with and without src=qr, without storing IP addresses or personal data. | COULD; deferred by Product Owner decision D-05 (needs a new aggregate table). Post-MVP backlog. | Post-MVP backlog |

Partially deferred parts of in-scope requirements:

| FR | Deferred part | Owning gate of the rest |
|---|---|---|
| FR-CLN-001 | Logo upload (COULD) deferred — C-10/ADR-022 | SC-1 |
| FR-CLN-006 | Per-doctor daily cap (COULD) deferred — C-10/ADR-022 | SC-1 |
| FR-QR-002 | Printable poster is SHOULD; PNG/SVG MUST | SC-2 |
| FR-APT-007 | .ics calendar file is SHOULD | SC-2 |

## 8. Non-functional requirements

| NFR | Category | Gate | Verification | Acceptance criterion (SRS §8) |
|---|---|---|---|---|
| NFR-PERF-001 | Performance | SC-5 | TC-NFR-003 | p95 ≤ 300 ms, p99 ≤ 800 ms over a 10-minute load test (TC-NFR-003). |
| NFR-PERF-002 | Performance | SC-2 | TC-NFR-003 | p95 ≤ 400 ms; date-availability for a 30-day horizon p95 ≤ 1 s. |
| NFR-PERF-003 | Performance | SC-5 | TC-NFR-003 | p95 ≤ 500 ms including transaction and SSE publish. |
| NFR-PERF-004 | Real time | SC-3 | TC-QUE-009 | p95 ≤ 2 s from transaction commit to client render (TC-QUE-009). |
| NFR-PERF-005 | Front end | SC-4 | TC-NFR-006 | LCP ≤ 2.5 s on Lighthouse “Moto G Power / Slow 4G” profile; public route JS ≤ 250 KB gzip. |
| NFR-PERF-006 | Scalability | SC-3 | TC-NFR-003 | One backend instance sustains ≥ 1,000 concurrent SSE connections with heartbeat and < 512 MB RSS. |
| NFR-REL-001 | Reliability | SC-3 | TC-QUE-021 | Client reconnects automatically (backoff 1–30 s) and re-fetches a full snapshot on reconnect; server heartbeat every 25 s. Verified by dropping the connection… |
| NFR-REL-002 | Reliability | SC-3 | TC-NFR-004 | Running each job twice concurrently produces the same final state (TC-NFR-004). |
| NFR-REL-003 | Reliability | SC-2 | TC-APT-005 | Expired holds are non-blocking at query time even if the expiry job is stopped (TC-APT-005). |
| NFR-REL-004 | Recoverability | SC-5 | SC-5 drill record | A documented pg_dump/pg_restore procedure restores the demo database successfully at least once before release. |
| NFR-AVL-001 | Availability | Only if live hosting is approved (D-10); health endpoints SC-1 | /healthz, /readyz checks | ≥ 99.5 % monthly when hosted (non-contractual); /healthz and /readyz endpoints exist in every build. |
| NFR-SEC-001 | Security | Deployed part only if hosting approved (D-10) | Header check (deployed) | All non-local traffic over HTTPS (TLS 1.2+); HSTS max-age ≥ 180 days in deployed environments; local Docker release documents the TLS requirement for any… |
| NFR-SEC-002 | Security | SC-1 | TC-APT-022 + header test | CSP without unsafe-inline scripts, X-Content-Type-Options, frame-ancestors none (except display page if needed), Referrer-Policy no-referrer on token pages;… |
| NFR-SEC-003 | Security | SC-5 | CI audit step | npm audit shows 0 high/critical vulnerabilities in production dependencies at release. |
| NFR-SEC-004 | Security | SC-1 → SC-4 | TC-SEC-001 | Isolation suite calls every tenant-scoped endpoint with a foreign-clinic ID and receives 404 in 100 % of cases, also for users who are members of the foreign… |
| NFR-PRIV-001 | Privacy | SC-2 | Schema review + TC-SEC-015 | Public forms collect only name and phone; database schema contains no clinical fields (schema review checklist). |
| NFR-PRIV-002 | Privacy | SC-2 | TC-QUE-014, TC-APT-022 | Public pages show first name only and phone masked to last 4 digits. |
| NFR-PRIV-003 | Privacy | SC-2 | TC-APT-022 | Token pages send X-Robots-Tag: noindex, nofollow and Referrer-Policy: no-referrer. |
| NFR-USE-001 | Usability | Product Owner-run after SC-4 (IR-26) | Moderated test (SC-01..03) | SC-01 (≤ 60 s median walk-in) and SC-02 (≤ 120 s median booking) met. |
| NFR-USE-002 | Usability | SC-4 | Content review | Patient-facing text at roughly grade 6–8 reading level; every status has a one-sentence explanation. |
| NFR-ACC-001 | Accessibility | SC-4 | TC-NFR-001 | WCAG 2.2 Level AA for all MVP screens; axe-core reports 0 serious/critical violations (TC-NFR-001); manual keyboard-only walkthrough of both journeys passes. |
| NFR-ACC-002 | Accessibility | SC-3 → SC-4 | TC-NFR-005 | Status and position changes announced through aria-live=“polite”; being called announced via aria-live=“assertive”. |
| NFR-ACC-003 | Accessibility | SC-4 | TC-NFR-006 | Touch targets ≥ 44 × 44 CSS px on patient screens; layout usable at 200 % text zoom; queue token rendered ≥ 48 px. |
| NFR-RESP-001 | Responsive | SC-2 → SC-4 | TC-NFR-002 | No horizontal scroll and all actions reachable at 360 × 640 px; also verified at 430, 768 and 1280 px (TC-NFR-002). |
| NFR-RESP-002 | Responsive | SC-4 | TC-NFR-002 | Reception and admin fully usable at ≥ 1024 px; doctor workspace fully usable at ≥ 768 px (tablet); display board at 1920 × 1080. |
| NFR-COMP-001 | Compatibility | SC-4 → SC-5 | E2E smoke matrix | Latest two versions of Chrome, Edge, Firefox, Safari (macOS/iOS) and Chrome on Android pass the E2E smoke suite. |
| NFR-MNT-001 | Maintainability | SC-1 | Lint boundary rule | Modules: identity, platform, clinic, scheduling, booking, queue, reporting, audit. A lint/import rule fails the build on cross-module imports that bypass a… |
| NFR-MNT-002 | Maintainability | SC-1 | CI type-check | TypeScript strict mode; 0 type errors in CI; shared Zod schemas between client and server. |
| NFR-TST-001 | Testability | SC-1 → SC-3 | Coverage report | ≥ 80 % line coverage in scheduling, booking and queue modules (Vitest); state machines 100 % transition coverage. |
| NFR-TST-002 | Testability | SC-4 | Playwright suite | Playwright covers Journey A, Journey B, check-in, doctor flow and one permission-denied path per role. |
| NFR-TST-003 | Testability | SC-1 | Clock injection review | Business logic obtains time from an injectable clock so tests can simulate any clinic-local time. |
| NFR-OPS-001 | Operability | SC-1 | Log format check, TC-SEC-011 | JSON logs with timestamp, level, request ID, clinic ID (where applicable), route and latency; PII redacted. |
| NFR-OPS-002 | Portability | SC-5 | Clean-machine README run | `docker compose up` starts web, API and database; README setup ≤ 5 steps; migrations and seed run by command. |
| NFR-DAT-001 | Data | SC-1 | Schema review, TC-SCH-003 | All instants stored as timestamptz (UTC); clinic-local service date stored explicitly on appointments and queue entries. |
| NFR-I18N-001 | Internationalisation | SC-1 | String externalisation check | All UI strings in resource files; dates and times formatted with Intl using clinic time zone. |
| NFR-CST-001 | Cost | Every gate (ledger) | Credit ledger | Implementation credit spend ≤ USD 35 (SC-11); any requirement that threatens this is deferred by Product Owner decision. |

## 9. State-transition coverage (SRS §9)

| Transition | Tests |
|---|---|
| AT-01 — → PENDING | TC-APT-005, TC-APT-006 |
| AT-02 PENDING → CONFIRMED | TC-APT-009, TC-APT-010 |
| AT-03 PENDING → EXPIRED | TC-APT-005 |
| AT-04 PENDING → CANCELLED | TC-APT-023 |
| AT-05 — → CONFIRMED (staff) | TC-APT-016 |
| AT-06 CONFIRMED → CONFIRMED (reschedule) | TC-APT-017, TC-APT-019, TC-APT-020 |
| AT-07 CONFIRMED → CANCELLED | TC-APT-011 |
| AT-08 CONFIRMED → CHECKED_IN | TC-APT-012 |
| AT-09 CONFIRMED → NO_SHOW | TC-APT-013 |
| AT-10 CHECKED_IN → COMPLETED | TC-APT-024 |
| AT-11 CHECKED_IN → CANCELLED | TC-APT-024 |
| QT-01 — → REGISTERED | TC-QUE-001 |
| QT-02 — → WAITING | TC-QUE-016, TC-APT-012 |
| QT-03 REGISTERED → WAITING | TC-QUE-005 |
| QT-04 REGISTERED → CANCELLED | TC-QUE-028 |
| QT-05 REGISTERED → EXPIRED | TC-QUE-011 |
| QT-06 WAITING → CALLED | TC-QUE-006, TC-QUE-007 |
| QT-07 WAITING → CANCELLED | TC-QUE-017 |
| QT-08 WAITING → WAITING (reassign) | TC-QUE-015, TC-QUE-023 |
| QT-09 CALLED → IN_CONSULTATION | TC-QUE-006 |
| QT-10 CALLED → WAITING | TC-QUE-024 |
| QT-11 CALLED → NO_SHOW | TC-APT-024 |
| QT-12 IN_CONSULTATION → COMPLETED | TC-QUE-006 |
| QT-13 WAITING/CALLED → CANCELLED (day close) | TC-QUE-011 |
| QT-14 IN_CONSULTATION → COMPLETED (auto_closed) | TC-QUE-011 |
| Any illegal transition (app) | TC-QUE-008 |
| Any illegal transition (DB trigger) | TC-SEC-014 |

## 10. Required quality areas → tests

| Quality area | Tests | Gates |
|---|---|---|
| Strict tenant isolation | TC-RPT-003, TC-SEC-001, TC-SEC-002, TC-SEC-012, TC-SEC-017 | SC-1, SC-4 |
| Multi-clinic membership | TC-DOC-004, TC-PLT-004, TC-STF-004, TC-STF-005 | SC-1, SC-3 |
| Staff role authorization | TC-SEC-003, TC-SEC-004, TC-SEC-013, TC-SEC-014, TC-SEC-016, TC-STF-006 | SC-1, SC-2 |
| Public access privacy | TC-APT-009, TC-APT-022, TC-APT-023, TC-QUE-014, TC-SEC-005, TC-SEC-006, TC-SEC-011, TC-SEC-015 | SC-2, SC-3 |
| Phone and name validation | TC-APT-008, TC-PAT-001, TC-QUE-029, TC-VAL-001, TC-VAL-002, TC-VAL-003, TC-VAL-004 | SC-1, SC-2, SC-3 |
| Clinic opening/closing hours | TC-APT-003, TC-CLN-001, TC-CLN-002, TC-SCH-005, TC-SCH-006 | SC-1, SC-2, SC-3 |
| Doctor schedules and breaks | TC-APT-004, TC-DOC-001, TC-DOC-002, TC-DOC-003, TC-SCH-004 | SC-1, SC-2 |
| Timezone and DST | TC-QUE-013, TC-SCH-001, TC-SCH-002, TC-SCH-003 | SC-1, SC-3 |
| Concurrent appointment booking | TC-APT-006, TC-APT-021 | SC-2 |
| Concurrent rescheduling | TC-APT-017, TC-APT-019, TC-APT-020 | SC-2 |
| Unique daily queue tokens | TC-QUE-004, TC-QUE-027 | SC-3 |
| Walk-in capacity and cutoff | TC-QUE-002, TC-QUE-003, TC-QUE-019, TC-QUE-020 | SC-3 |
| Duplicate registration handling | TC-QUE-012, TC-QUE-025 | SC-3 |
| Arrival confirmation | TC-QUE-005, TC-QUE-026, TC-QUE-028 | SC-3 |
| Doctor call/start/complete | TC-APT-024, TC-QUE-006, TC-QUE-007, TC-QUE-008, TC-QUE-010, TC-QUE-023, TC-QUE-024 | SC-3 |
| SSE permissions and reconnection | TC-QUE-009, TC-QUE-018, TC-QUE-021, TC-QUE-022, TC-SEC-007 | SC-3 |
| Reporting accuracy | TC-RPT-001, TC-RPT-002, TC-RPT-004, TC-RPT-005, TC-RPT-006 | SC-4 |
| Accessibility | TC-NFR-001, TC-NFR-005 | SC-4 |
| Mobile responsiveness | TC-NFR-002, TC-NFR-006 | SC-4 |

## 11. Tests not tied to a single FR

These verify business rules, architecture rules or NFRs:

| Test | Verifies |
|---|---|
| TC-APT-004 | BR-050 |
| TC-NFR-001 | NFR-ACC-001–003 |
| TC-NFR-002 | NFR-RESP-001–002 |
| TC-NFR-003 | NFR-PERF-001–003 |
| TC-NFR-004 | NFR-REL-002 |
| TC-SEC-014 | Rule 12, ADR-016 |
| TC-NFR-005 | NFR-ACC-002 |
| TC-NFR-006 | NFR-PERF-005, NFR-ACC-003 |
