# Isolate CalculatedFields Under Document.calculated

Evaluated `CalculatedField`s are stored on a dedicated `Document.calculated` dictionary (`Record<string, unknown>`) on the `Document` entity and referenced in Stage 2 templates via `{{Document.calculated.<key>}}`, rather than being merged into `Document.data`.

When `DocumentType` schemas strip spreadsheet prefixes (such as stripping `"Calc"` from `"Calc Number"` to produce `key: "number"`), calculated field names can collide with base `DocumentField` keys (such as `Document.data.number` in `Submittal Arch`). Isolating derived `CalculatedField` values under `Document.calculated` prevents property collisions with user-supplied `Document.data` fields, keeps `Document.data` strictly restricted to base payload properties and runtime `documentDataPatch` merges, and aligns `CalculatedField` access with top-level `Identity` properties (`Document.id`, `Document.idDocument`, `Document.idGroup`).
