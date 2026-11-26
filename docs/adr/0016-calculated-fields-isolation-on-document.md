# Isolate CalculatedFields Under Document.calculated

Evaluated `CalculatedField`s are stored on a dedicated `Document.calculated` dictionary (`Record<string, unknown>`) on the `Document` entity and referenced in Stage 2 templates via `{{Document.calculated.<key>}}`, rather than being merged into `Document.data`.

When `DocumentType` schemas strip spreadsheet prefixes (such as stripping `"Calc"` from `"Calc Number"` to produce `key: "number"`), calculated field names can collide with base `DocumentField` keys (such as `Document.data.number` in `Submittal Arch`). Isolating derived `CalculatedField` values under `Document.calculated` prevents property collisions with user-supplied `Document.data` fields, keeps `Document.data` strictly restricted to base payload properties and runtime `documentDataPatch` merges, and aligns `CalculatedField` access with top-level `Identity` properties (`Document.id`, `Document.idDocument`, `Document.idGroup`).

## Amendment (2026-11-25 — Declarative CalculatedField Transforms and Lookup Guardrails)

- `HandlebarsAdapter` remains strictly logic-less per [0003-handlebars-for-injection-not-logic.md](0003-handlebars-for-injection-not-logic.md).
- `CalculatedField` reads base `Document.data` and `LookupOptions`-enriched `DocumentField` properties (such as `specTag.key`).
- `CalculatedField.template` remains required; evaluation runs in strict `template -> transforms -> lookup` order using only the closed allowlist of pure string transforms (`prefix`, `uppercase`) and single-hop `OptionSource` lookup bindings (`lookup: { source, matchProperty, resultProperty }`) resolved through `LookupOptions`.
- `CalculatedField`s remain flat and cannot reference other `CalculatedField`s or `Identity` properties; any new transform primitive requires a new ADR amendment.
