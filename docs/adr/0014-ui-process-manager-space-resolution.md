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
   - **Unknown Space Rejection**: `DocumentSpace`s represent pre-existing storage containers; users cannot create new `DocumentSpace`s from the app. If a non-empty input does not match any loaded space's `name` or `id`, `resolveSpace` flags a not-found error (`"Document space \"<input>\" was not found. Please select an existing space."`), leaving `spaceId` undefined and resetting dependent dynamic options to `"Select a Space first"`.
   - **Empty Input**: Clearing the Document Space field resolves `spaceId` to `undefined` and clears dependent dynamic options.
4. **Pre-Submit Resolution & Hydrated Space Contract**: In form submission (`actionName === 'processDocument'`), `workspace-addon.adapter.ts` resolves the space input against the loaded collection prior to calling `documentRunner.processDocument()`. If the space input is empty (`"Please select a Document Space."`), collides with duplicate names, or does not match an existing space in the collection, submission is aborted with an error update card. When matched, the full `DocumentSpace` (`{ id, typeId, name, abstractStorageId }`) is passed to `DocumentService.processDocument()`.

## Consequences

- **Pros**:
  - Provides a deep, cohesive domain module interface in `UiProcessManager` with zero parameter redundancy.
  - Fixes dynamic suggestion population (Contact suggestions) by ensuring downstream Drive queries receive valid folder IDs.
  - Prevents data corruption or invalid routing from duplicate or non-existent space names by surfacing explicit user-facing errors.
  - Preserves `DocumentModel` domain invariants by ensuring `Document.space` is always a validated `DocumentSpace` entity.
  - Preserves Google Workspace Card UI ergonomics by displaying human-readable names.
- **Cons**:
  - All callers of `evaluateProcessUiState` must supply `spaces: UiProcessSpaceItem[]`.
  - Disambiguation requires users to enter the unique storage ID when duplicate space names exist in the collection.
