# Fast-Track and Guarded Reads

We will route pure data queries directly from driving adapters to driven ports (Fast-Track Read), bypassing the domain core entirely. We will only route queries through `domain.ts` (Guarded Read) when they require business-level authorization, data masking, or invariant-based calculations. 

This CQRS-style query bypass prevents `domain.ts` from being polluted with pass-through boilerplate methods that enforce no business rules.

## Considered Options
- **Strict Domain Pass-Through:** Rejected. Routing every read through the domain core provides a uniform entry point but clutters the domain with empty methods that do nothing but hand data from infrastructure to the UI.
- **Full CQRS (Separate Read Models):** Rejected. Overkill for simple features and violates strict feature encapsulation unless the read layer is modeled as its own dedicated feature.
