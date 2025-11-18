# Plan a Feature — Technical Plan Template

**Purpose.** Produce a tight, implementation-ready *technical plan* for a feature the user describes. The output is a single Markdown file at:
`docs/features/<FEATURE>/plan.md` (where `<FEATURE>` is **snake_case**, ≤5 words).

**Keep it project‑agnostic.** All project‑specific facts (stack, modules, naming, rules) must be learned from the repository and any context docs (e.g., `AGENTS.md`) and then referenced explicitly in the plan.

**LLM instructions**
Output snippets are marked by XML brackets. The XML brackets are not to be included in the end result.

Assuming the template <output_template>:

```
<output_template>
The answer is <value>
</output_template>
```

The final document will contain the following output only:

```
The answer is 42
```

---

## Inputs you must use

* The user’s feature description/prompt (quote key phrases verbatim where accuracy matters).
* The repository snapshot (search for relevant files/functions; quote file paths and line ranges as evidence).
* Any context docs the user has provided (e.g., `AGENTS.md`, product/tech briefs, coding guidelines, API specs).

> If the prompt is ambiguous **after** code/doc research, ask a **small, blocking set** of clarifying questions; otherwise proceed.

---

## Deliverable format (headings to include in the plan)

### 0) Research Log & Findings

Summarize the discovery work that informed the plan. Describe the areas you've researched and your findings. Highlight any areas of special interest, conflicts you've identified and how you resolved them.

### 1) Intent & Scope (1–3 short paragraphs)

* **User intent** in your own words + **verbatim** snippets from the prompt for critical phrases.
* **In-scope** vs **Out of scope** bullets (tight). Avoid PM language (no timelines, success metrics).
* **Assumptions/constraints** you’ll rely on.

Use the template in `<intent_scope_template>` for each plan:

<intent_scope_template>
**User intent**

<concise restatement>

**Prompt quotes**

"<verbatim phrases you will anchor on>"

**In scope**

- <primary responsibilities the plan will cover>

**Out of scope**

- <explicit exclusions>

**Assumptions / constraints**

<dependencies, data freshness, rollout limits>
</intent_scope_template>

### 2) Affected Areas & File Map (with repository evidence)

List every module/file/function to create or change. For each, include:

* **Why** it’s touched (one sentence).
* **Evidence:** `path:line-range` quotes showing call sites, types, interfaces, or TODOs.

> Be exhaustive here; this list becomes the implementation checklist.

Use the template in `<file_map_entry_template>` for each area you list:

<file_map_entry_template>
- Area: <module / file / function>
- Why: <reason this area changes>
- Evidence: <path:line-range — short quote proving relevance>
</file_map_entry_template>

### 3) Data Model / Contracts

* **Data shapes** new/changed (request/response bodies, events/messages, DB tables/columns, config). Use concise JSON or table snippets.
* **Refactoring over back-compat.** Prefer refactoring to eliminate backwards compatibility needs; if impossible, specify the fallback strategy (idempotency, nullable defaults, versioning).

Use the template in `<data_model_template>` when documenting each contract:

<data_model_template>
- Entity / contract: <name of payload, table, event, config block>
- Shape: <concise JSON/table sketch highlighting new or changed fields>
- Refactor strategy: <how you avoid back-compat; fallback if unavoidable>
- Evidence: <path:line-range — schema or usage reference>
</data_model_template>

### 4) API / Integration Surface

* Endpoints, RPCs, CLI commands, background jobs, webhooks, or message topics that change or are added.
* For each: **method/name, path/topic, inputs, outputs, error modes**. Keep it code-free.

Use the template in `<integration_surface_template>` for every surface:

<integration_surface_template>
- Surface: <HTTP method + path / job name / topic>
- Inputs: <parameters or payloads the caller sends>
- Outputs: <response body, side effects, emitted events>
- Errors: <status codes, retry semantics, notable failure paths>
- Evidence: <path:line-range — controller/service showing current behavior>
</integration_surface_template>

### 5) Algorithms & State Machines (step-by-step)

* Describe the core algorithm(s) in numbered steps or pseudo‑flow.
* If a state machine is involved, list **states** and **transitions**; specify guards.
* Call out complexity hotspots and expected volumes.

Use the template in `<algorithm_template>` for each flow:

<algorithm_template>
- Flow: <name or trigger of the algorithm/state machine>
- Steps:
  1. <step one>
  2. <step two>
  3. <continue as needed>
- States / transitions: <state names with transition triggers; omit if none>
- Hotspots: <latency, scaling, coupling notes>
- Evidence: <path:line-range — logic reference>
</algorithm_template>

### 6) Derived State & Invariants (stacked bullets)

List derived values that influence storage/cleanup/cross-context state. Provide ≥3 entries or justify “none”. For each derived value, use the template in `<derived_value_template>`:

<derived_value_template>
- Derived value: <name>
  - Source: <filtered/unfiltered inputs and where they come from>
  - Writes / cleanup: <what follows from the derived value>
  - Guards: <conditions, feature flags, retries>
  - Invariant: <what must stay true>
  - Evidence: <file:line>
</derived_value_template>

> If a **filtered** view drives a **persistent** write/cleanup, call it out explicitly under Guards and propose a protection.

### 7) Consistency, Transactions & Concurrency

* Where transactions begin/end; what must be **atomic**; how partial failure rolls back.
* Idempotency keys or de‑duplication where retried work is possible.
* Ordering guarantees (eventual vs strong) and any locking/optimistic concurrency.

Structure your answer with the template in `<consistency_template>`:

<consistency_template>
- Transaction scope: <where the unit of work starts/stops>
- Atomic requirements: <writes that must succeed together or roll back>
- Retry / idempotency: <keys, guards, replay handling>
- Ordering / concurrency controls: <locks, version checks, queue ordering>
- Evidence: <path:line-range — ORM/session usage or job orchestration>
</consistency_template>

### 8) Errors & Edge Cases

* Enumerate expected failure modes and **how they surface** to callers/users.
* Validation rules; limits and bounds; timeouts/retries.

Log each case using the template in `<error_case_template>`:

<error_case_template>
- Failure: <what goes wrong>
- Surface: <API/service/job that observes it>
- Handling: <status code, retry, user message, escalation>
- Guardrails: <validation, limits, monitoring to prevent recurrence>
- Evidence: <path:line-range — existing behavior or TODO>
</error_case_template>

### 9) Observability / Telemetry

* Metrics, logs, and traces you will emit (names/labels at a glance).
* Any alerts or counters that prove the feature works in production.

Detail observability with the template in `<telemetry_template>`:

<telemetry_template>
- Signal: <metric/log/trace name>
- Type: <counter, gauge, histogram, structured log, trace span>
- Trigger: <when you emit it and from where>
- Labels / fields: <dimensions that differentiate outcomes>
- Consumer: <dashboard, alert, runbook pointer>
- Evidence: <path:line-range — existing metrics hooks>
</telemetry_template>

### 10) Background Work & Shutdown

* Any background workers/threads/jobs; when they start/stop.
* Required shutdown hooks or lifecycle notifications.

Describe each worker using the template in `<background_work_template>`:

<background_work_template>
- Worker / job: <name or module>
- Trigger cadence: <event-driven, schedule, startup-only>
- Responsibilities: <work performed and dependencies>
- Shutdown handling: <notification hooks, timeouts, rollback steps>
- Evidence: <path:line-range — scheduler or coordinator reference>
</background_work_template>

### 11) Security & Permissions (if applicable)

* Authn/authz touchpoints, sensitive fields, redaction, rate limits.

Capture changes with the template in `<security_template>` (omit if truly not applicable):

<security_template>
- Concern: <authentication, authorization, data exposure, rate limit>
- Touchpoints: <endpoints/services enforcing the rule>
- Mitigation: <how you enforce / log / alert>
- Residual risk: <what remains and why it’s acceptable>
- Evidence: <path:line-range — auth decorators, policy definitions>
</security_template>

### 12) UX / UI Impact (if applicable)

* Entry points, screens/forms affected, notable interactions (modal vs page, validation moments).
* No mockups; list components/routes you expect to change and why.

Outline UI changes with the template in `<ux_impact_template>` (omit if no UX impact):

<ux_impact_template>
- Entry point: <page, modal, route, CLI command>
- Change: <copy, layout, validation, navigation adjustment>
- User interaction: <what the user experiences differently>
- Dependencies: <frontend components or backend contracts relied on>
- Evidence: <path:line-range — component/view reference>
</ux_impact_template>

### 13) Deterministic Test Plan (new/changed behavior only)

For each API/service/CLI/job/state machine:

* **Scenarios** (Given/When/Then bullets).
* **Test hooks/fixtures** needed (factories, dependency injection, stable datasets).
* **Gaps** you intentionally leave for later (if any) with rationale.

Structure each surface’s coverage with the template in `<test_plan_template>`:

<test_plan_template>
- Surface: <API/service/CLI/job/state machine name>
- Scenarios:
  - Given <context>, When <action>, Then <outcome>
  - <add more scenarios as needed>
- Fixtures / hooks: <factories, dataset prep, dependency injection tweaks>
- Gaps: <anything deferred + justification>
- Evidence: <path:line-range — existing tests or helper utilities>
</test_plan_template>

### 14) Implementation Slices (only if large)

* Order small slices that land value early (e.g., schema → service → API → UI).
* Each slice: 1–2 sentences and the files it touches.

Lay out the sequence with the template in `<implementation_slice_template>`:

<implementation_slice_template>
- Slice: <name or milestone>
- Goal: <value the slice ships>
- Touches: <primary files/modules you will update>
- Dependencies: <what must happen before/after; feature flags if any>
</implementation_slice_template>

### 15) Risks & Open Questions

* Top 3–5 **risks** with tiny mitigations (one line each).
* **Open questions** that would change the design (each with why it matters).

Use the templates in `<risk_template>` and `<open_question_template>`:

<risk_template>
- Risk: <what could go wrong>
- Impact: <blast radius or severity>
- Mitigation: <quick action to reduce likelihood or impact>
</risk_template>

<open_question_template>
- Question: <missing info that affects the design>
- Why it matters: <decision or dependency blocked>
- Owner / follow-up: <who can answer or where to research>
</open_question_template>

### 16) Confidence (one line)

* High/Medium/Low with a short reason.

Use the template in `<confidence_template>`:

<confidence_template>Confidence: <High / Medium / Low> — <one-sentence rationale></confidence_template>

---

## Method (how to work while writing the plan)

1. **Research-first.** Scan the repo and context docs before asking questions; quote file/line evidence for every claim.
2. **Be minimal.** Prefer the smallest viable changes that satisfy intent.
3. **No code.** Pseudocode and data snippets only; keep the plan implementable by a competent developer.
4. **Name the feature folder well.** Use `<FEATURE>` that’s short, descriptive, and snake_case.
5. **Stop condition.** The plan is done when all sections above are filled with enough precision that another developer can implement without guessing.

## Final check
All XML template demarcation tags have been removed and all XML tags inside template output has been replaced with an actual value.
