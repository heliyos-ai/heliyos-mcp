<!-- Thanks for contributing. Keep the PR focused on one change; open a second PR for unrelated work. -->

## What this changes

<!-- One or two sentences. Link the issue it closes, for example "Closes #12". -->

## Why

<!-- The problem an agent or a user hit, and how this fixes it. -->

## How it was tested

<!-- Which tests you added or changed. If you ran `npm run smoke` against a real workspace, say so (never include the key). -->

## Checklist

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass locally
- [ ] New or changed tools have tests in `tests/tools/` and every input parameter has a description
- [ ] `npm run readme:tools` was run if a tool was added, renamed or re-described, and the README table is committed
- [ ] `npm run test:update-tool-snapshot` was run if the public tool contract changed, and the snapshot diff is intentional
- [ ] `skills/heliyos/SKILL.md` was updated if an agent should use the new tool differently
- [ ] No API keys, tokens, customer data or internal URLs appear in code, tests, fixtures or this description
- [ ] No em dashes in user-facing text (tool descriptions, README, skill)
