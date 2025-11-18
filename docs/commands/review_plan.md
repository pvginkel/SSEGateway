# Plan Review — Guidance for LLM (single-pass, adversarial)

**Purpose.** Perform a one-shot, thorough plan review that surfaces real risks without relying on follow-up prompts. Write the results to:
`docs/features/<FEATURE>/plan_review.md`.

**References (normative).**

* `@docs/commands/plan_feature.md`
* `@docs/product_brief.md`
* `@AGENTS.md`
* (optional) other docs the user links

**Ignore**: minor implementation nits (imports, exact message text, small style, variable names). Assume a competent developer will handle those.

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

## What to produce (write to `plan_review.md`)

Use these headings (free-form prose inside each, but **quote evidence** with file + line ranges).

### 1) Summary & Decision
Provide an overall readiness assessment and verdict, using `<plan_review_summary_template>` to anchor the evidence and decision.

<plan_review_summary_template>
**Readiness**
<single paragraph assessing plan readiness>

**Decision**
`GO` | `GO-WITH-CONDITIONS` | `NO-GO` — <brief reason tied to evidence>
</plan_review_summary_template>

### 2) Conformance & Fit (with evidence)
Evaluate how the plan honors the governing references and meshes with the existing codebase. Summarize the results with `<plan_conformance_fit_template>`.

<plan_conformance_fit_template>
**Conformance to refs**
- `<reference>` — Pass/Fail — `plan_path:lines` — <quote>
- ...

**Fit with codebase**
- `<module/service>` — `plan_path:lines` — <assumption or gap>
- ...
</plan_conformance_fit_template>

### 3) Open Questions & Ambiguities
List unanswered questions, emphasizing the impact of each and the decision that hinges on it. Capture them with `<open_question_template>`.

<open_question_template>
- Question: <uncertainty to resolve>
- Why it matters: <impact on implementation or scope>
- Needed answer: <what information unlocks progress>
</open_question_template>

### 4) Deterministic Backend Coverage (new/changed behavior only)
For each new or changed backend behavior, document the scenarios, observability, and persistence hooks that will validate it. Employ `<plan_coverage_template>` to note any gaps; missing elements should be escalated as **Major**.

<plan_coverage_template>
- Behavior: <API/service/CLI/background task>
- Scenarios:
  - Given <context>, When <action>, Then <outcome> (`tests/path::test_name`)
- Instrumentation: <metrics/logging/alerts expected>
- Persistence hooks: <migrations/test data/DI wiring/storage updates>
- Gaps: <missing element if any>
- Evidence: <plan_path:lines or reference doc>
</plan_coverage_template>

### 5) **Adversarial Sweep (must find ≥3 credible issues or declare why none exist)**
Stress-test the plan by targeting failure modes that would surface in implementation. Record each issue with `<finding_template>`, or—if no credible issues remain—log the attempted checks and justification via `<adversarial_proof_template>`.

<finding_template>
**Severity — Title**
**Evidence:** `plan_path:lines` (+ refs) — <quote>
**Why it matters:** <impact>
**Fix suggestion:** <minimal plan change>
**Confidence:** <High / Medium / Low>
</finding_template>

<adversarial_proof_template>
- Checks attempted: <targeted invariants or fault lines>
- Evidence: <plan_path:lines or referenced sections>
- Why the plan holds: <reason the risk is closed>
</adversarial_proof_template>

### 6) **Derived-Value & Persistence Invariants (stacked entries)**
Document derived values that affect storage, cleanup, or cross-context state, providing at least three entries or a justified “none; proof.” Populate `<derived_value_template>` for each.

<derived_value_template>
- Derived value: <name>
  - Source dataset: <filtered/unfiltered inputs>
  - Write / cleanup triggered: <persistence actions>
  - Guards: <conditions or feature flags>
  - Invariant: <statement that must hold>
  - Evidence: <plan_path:lines or reference doc>
</derived_value_template>

*(Example: “Box occupancy percentage” derived from filtered `part_locations` drives storage cleanup; guard with transaction-level check to avoid orphaning.)*

> If an entry uses a **filtered** view to drive a **persistent** write/cleanup without guards, flag **Major** unless fully justified.

### 7) Risks & Mitigations (top 3)
Summarize the top plan-level risks and expected mitigations, grounding each in cited evidence. Use `<risk_template>` for consistency.

<risk_template>
- Risk: <description tied to plan evidence>
- Mitigation: <action or clarification needed>
- Evidence: <plan_path:lines or referenced ref>
</risk_template>

### 8) Confidence
State your confidence in the plan and the reasoning behind it, using `<confidence_template>` to keep the statement concise.

<confidence_template>Confidence: <High / Medium / Low> — <one-sentence rationale></confidence_template>

---

## Severity (keep it simple)

* **Blocker:** Misalignment with product brief, schema/test data drift, or untestable/undefined core behavior → tends to `NO-GO`.
* **Major:** Fit-with-codebase risks, missing coverage/migration/test data updates, ambiguous requirements affecting scope → often `GO-WITH-CONDITIONS`.
* **Minor:** Clarifications that don’t block implementation.

---

## Review method (how to think)

1. **Assume wrong until proven**: hunt for violations of layering (API vs. service), transaction safety, test coverage, data lifecycle, metrics, shutdown coordination.
2. **Quote evidence**: every claim or closure needs file:line quotes from the plan (and refs). Flag when refs contradict plan assumptions.
3. **Focus on invariants**: ensure filtering, batching, or async work doesn’t corrupt inventory state, leave hanging migrations, or orphan S3 blobs/test data.
4. **Coverage is explicit**: if behavior is new/changed, require pytest scenarios, metrics instrumentation, and persistence hooks; reject “we’ll test later”.

## Final check
All XML template demarcation tags have been removed and all XML tags inside template output has been replaced with an actual value.
