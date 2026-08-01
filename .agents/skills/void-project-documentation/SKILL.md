---
name: void-project-documentation
description: Maintain the Void project's specifications, alignment interview, learning decisions, build and packaging guidance, and verification evidence under C:\Users\seungsura\void2\spec. Use for any Void planning, modernization, Codex/OpenCode comparison, implementation, troubleshooting, packaging, or retrospective task.
---

# Void project documentation

## Apply the contract

1. Read the repository-root `AGENTS.md`, `C:\Users\seungsura\void2\spec\index.md`, and `spec\project-charter.md` before changing project files.
2. Read `spec\project-alignment-interview.md` before choosing a feature or advancing a phase.
3. Read `spec\openai-agent-conformance.md` before changing AGENTS, skills, tools, or agent orchestration.
4. Read `spec\packaging-guide.md` for build or packaging work and `spec\local-git-policy.md` for Git work.
5. Store project documentation under `C:\Users\seungsura\void2\spec` as Markdown and update `spec\index.md` when the document set changes.

## Preserve user alignment

Treat the user's understanding and learning pace as the priority-zero constraint. Work on one behavior at a time. Before implementation, document the current behavior, concrete problem, reference behavior, learning objective, smallest proposed change, non-goals, success metrics, and rollback path. Present the recommendation, rationale, trade-offs, and failure modes, then wait for alignment before advancing.

Record interview answers and changed decisions in `spec\project-alignment-interview.md`. Treat `spec\ai-agent-competency-reference.md` as a study horizon, not an implementation backlog.

## Follow OpenAI conventions

Treat current public OpenAI Codex documentation as normative for `AGENTS.md` and `SKILL.md`. Treat the local Codex source as implementation study material and OpenCode as comparative material. Record conformance decisions and known deviations in `spec\openai-agent-conformance.md`.

Keep this repository skill focused on the documentation and alignment workflow. Use the `name` and `description` metadata for discovery and keep detailed procedure in this body. Add scripts or references only when instructions alone are insufficient.

## Record evidence

For implementation, build, or packaging work, record the exact scope, commands, versions, observed result, confirmed cause versus inference, workaround versus permanent fix, verification, limitations, and artifact hash when applicable. Add packaging failures to the relevant procedure in `spec\packaging-guide.md`, not to a separate failure log.

Do not report completion solely from a successful command. Verify the behavior the user selected and record what remains unverified.
