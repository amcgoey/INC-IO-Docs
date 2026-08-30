# Drive File Resolution Strategy

**Decision:** Resolve Drive paths using a **Top-Down Floating Partial Path** with level-consolidation and a 20-match fail-fast threshold. 

**Why:** Google Drive permits duplicate filenames and hides nested activity from parent `modifiedTime` timestamps.
- **Reject bottom-up traversal:** Finding a common filename globally and walking up triggers massive API fan-out.
- **Reject timestamp heuristics:** Guessing the "Top 5" by `modifiedTime` starves old-but-active parent directories.

**Mechanism:** 
1. **Entry:** Start global (floating) or anchored to a `sharedDriveId`.
2. **Consolidate:** Traverse top-down, joining surviving parent IDs with `or` (`id1 in parents or id2 in parents`) to lock API calls exactly to path depth.
3. **Fail fast:** If any level exceeds 20 matches, throw `AmbiguousPathSpecError`. Demand a tighter path string from the administrator rather than guessing.
