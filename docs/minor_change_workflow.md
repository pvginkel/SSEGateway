# Minor Change Workflow

## Overview

This document describes an automated workflow to do minor work that can be completed unattended by an LLM. Examples of the type of work that this workflow is useful for:

- Minor bug fixes where the bug is clear.
- Cosmetic changes.
- Simple dependency updates.

## Workflow Steps

### 0. Establish Feature Directory

**Before invoking any agents**, determine the feature directory path where all planning documents will be stored:

```
docs/features/<FEATURE_NAME>/
```

Where `<FEATURE_NAME>` is a snake_case identifier for the component being extracted (e.g., `bug_fix`, `status_badge_refactor`).

Create this directory using `mkdir -p docs/features/<FEATURE_NAME>/` before proceeding.

**Document Paths**:
- Change Brief: `docs/features/<FEATURE_NAME>/change_brief.md`
- Plan: `docs/features/<FEATURE_NAME>/plan.md`
- Plan Review: `docs/features/<FEATURE_NAME>/plan_review.md`
- Code Review: `docs/features/<FEATURE_NAME>/code_review.md`

You will provide these **explicit full paths** to every agent invocation in the following steps.

### 1. Write the Change Brief

Clearly describe at a functional level the work that needs to be done based on the users input. This can be a single sentence like:

- "Fix the spelling error on button X on screen Y."
- "Add a field for storing X to entity Y and show it on the list and detail screen."

It can also be a more wordy description. This is essential in the case of bug fixes that need a reproduction.

If confidence is low that the change brief describes the change clearly, respond back to the user with this and abort the session.

Write the change brief to: docs/features/<FEATURE_NAME>/change_brief.md

### 2. Create a Plan

Use the `plan-writer` agent to create a detailed implementation based on the change brief.

```
Use the Task tool with the plan-writer agent to create a plan for delivering the change described in docs/features/<FEATURE_NAME>/change_brief.md.

Since this is a minor change, resolve all questions autonomously.

Write the plan to: docs/features/<FEATURE_NAME>/plan.md
```

**Important**: Provide the explicit full path to the plan file in your agent prompt (e.g., `docs/features/bug_fix/change_brief.md` and `docs/features/bug_fix/plan.md`).

### 3. Review the Plan

Use the `plan-reviewer` agent to validate the plan:

```
Use the Task tool with the plan-reviewer agent to review the plan at docs/features/<FEATURE_NAME>/plan.md.

The review output will be written to: docs/features/<FEATURE_NAME>/plan_review.md

Apply the output to improve the plan. If significant changes are needed, run the plan-reviewer again to validate the updated plan.
```

**Important**: Provide explicit full paths to both the plan and plan review files in your agent prompt (e.g., `docs/features/bug_fix/plan.md` and `docs/features/bug_fix/plan_review.md`).

**Iteration Rule**: If the review suggests substantial changes, update the plan and re-review. Repeat until the plan passes review without major concerns.

### 4. Execute the Plan

The workflow to execute a plan and review the results is written up in `docs/plan_execution_workflow.md`. Use the workflow in that document to execute the plan you created.

## Related Documentation

- `CLAUDE.md` — Project instructions and verification requirements
- `docs/plan_execution_workflow.md` — Plan execution and code review workflow
- `docs/contribute/architecture/application_overview.md` — Architecture patterns
- `docs/commands/plan_feature.md` — Feature planning template
- `docs/commands/review_plan.md` — Plan review criteria
- `docs/commands/code_review.md` — Code review standards
