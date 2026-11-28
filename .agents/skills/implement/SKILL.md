---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run `npm run typecheck`, `npm run lint`, and targeted offline test files during development. Finish with `npm run test:all` (or `npm test` for app-only changes) for a clean offline baseline.

For tickets modifying Google API seams (Drive, Sheets, Docs, `DocumentLog`, `LookupOptions`, `DocumentSpaceType`, or PDF cover-sheet adapters), run only the matching scoped `npm run test:live:<scope>` suite during ticket work (see `package.json`), reserving full sequential `npm run test:live` for integration-branch verification.

Once done, use /code-review to review the work.

Commit your work to the current branch.
