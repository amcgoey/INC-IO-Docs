## Parent
#21

## What to build
The absolute bare minimum to establish the driving seam. Sets up the Fastify server and the HTTP POST endpoint which routes requests to a dummy function in the Core domain (`features/record/domain.ts`). It simply returns a hardcoded 200 success response. This proves the wiring layer (`server.ts`), driving adapter (`http.ts`), and feature folder structure are correctly connected.

## Acceptance criteria
- [ ] Fastify server starts and listens for requests.
- [ ] A POST endpoint exists and routes the payload to the Core domain.
- [ ] The Core domain simply returns a hardcoded success.
- [ ] The endpoint returns a 200 OK.
- [ ] Unit tests for the endpoint verify the 200 response.

## Blocked by
- None — can start immediately.
