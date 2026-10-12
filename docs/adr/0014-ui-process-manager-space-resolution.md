# 14. Space Name-to-ID Resolution and Dual State in UI Process Manager

Date: 2026-10-12

## Status

Accepted

## Context

In the Google Workspace Add-on, the Document Space selection widget is implemented as a `textInput` with dynamic autocomplete suggestions (`initialSuggestions`), presenting human-readable display names (e.g. "Project Alpha") to the user. However, backend operations—including storage processing and dependent dynamic option queries (such as Contact folder queries)—require canonical technical identifiers (e.g. Google Drive folder or Shared Drive alphanumeric IDs).

Previously, `workspace-addon.adapter.ts` stripped space IDs prematurely via `collection.spaces.map(s => s.name)` and passed display names into `evaluateProcessUiState`. `resolveSpaceId` simply returned the raw display name, which was then forwarded downstream to Google Drive queries (e.g. `'Project Alpha' in parents`), failing silently and returning zero folder suggestions.

Furthermore, we evaluated two interface designs for `ProcessUiStateInput`:
- **Option 2A**: Adding an optional `spaces` array alongside `collectionSpaces: string[]` or `nameToKeyMap`.
- **Option 2B**: Replacing `collectionSpaces: string[]` with canonical `spaces: UiProcessSpaceItem[]` (`{ id: string; name: string }`).

## Decision

We adopt **Option 2B** and establish the following architectural invariants for UI space resolution:

1. **Anti-Corruption Layer & Domain DTO**: Driving adapters (such as `WorkspaceAddonAdapter`) map raw infrastructure space collections into pure domain DTOs (`UiProcessSpaceItem[]`) before calling `evaluateProcessUiState`. Redundant lookup maps (`nameToKeyMap`) and flat string arrays (`collectionSpaces: string[]`) are removed from `ProcessUiStateInput`.
2. **Dual State Representation**: 
   - `effectiveFormData` retains the human-readable display name so the UI widget reflects what the user typed or selected.
   - `state.spaceId` resolves and exposes the canonical technical storage ID for backend execution and dynamic suggestion queries.
3. **Resolution Rules**:
   - Case-insensitive trimming of user input before matching.
   - If input uniquely matches a known space's `name`, resolve to its `id`.
   - **Name Collisions**: If multiple spaces in the loaded collection share the exact same name, `resolveSpaceId` flags an ambiguity collision. The error is surfaced immediately in `validationErrors` (`"Multiple spaces match \"<name>\". Please choose or enter a unique space identifier."`), leaving `spaceId` undefined to prevent routing documents to the wrong container.
   - **ID-to-Name Auto-Translation**: If input directly matches a known space's `id`, `resolveSpaceId` returns the ID, and `effectiveFormData` is auto-translated to the space's human-readable `name` on refresh.
   - **Unlisted ID Fallback**: If input does not match any loaded space name or ID, it is preserved as an unlisted ID fallback.
   - **Empty Input**: Clearing the Document Space field resolves `spaceId` to `undefined` and clears dependent dynamic options.
4. **Pre-Submit Resolution**: In form submission (`actionName === 'processDocument'`), `workspace-addon.adapter.ts` resolves the space display name to its technical storage ID prior to calling `documentRunner.processDocument()`.

## Consequences

- **Pros**:
  - Provides a deep, cohesive domain module interface in `UiProcessManager` with zero parameter redundancy.
  - Fixes dynamic suggestion population (Contact suggestions) by ensuring downstream Drive queries receive valid folder IDs.
  - Prevents data corruption from duplicate space names by throwing an explicit user-facing error.
  - Preserves Google Workspace Card UI ergonomics by displaying human-readable names.
- **Cons**:
  - All callers of `evaluateProcessUiState` must supply `spaces: UiProcessSpaceItem[]`.
  - Disambiguation requires users to enter the unique storage ID when duplicate space names exist in the collection.
