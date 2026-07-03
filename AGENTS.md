# Agent Guidance

This is a personal project. Do not add test scaffolding, test suites, or test scripts by default.

Prefer lightweight verification that fits the change:

- Run syntax checks, builds, or targeted commands when they directly catch integration issues.
- Use manual fixture runs or CLI smoke checks for personal workflow features.
- Add automated tests only when explicitly requested or when a change is risky enough that the reason is called out first.

Keep implementation work pragmatic and scoped. Preserve existing generated package formats unless the user asks to migrate them.
