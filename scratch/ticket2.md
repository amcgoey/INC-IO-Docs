## Parent
#21

## What to build
Introduces the Typebox `RecordType` schema into the Core domain. The driving adapter now relies on the domain's pure logic to validate the incoming payload instead of returning a hardcoded success. The endpoint returns 200 for valid data and 400 for invalid data, proving our domain validation rules work end-to-end.

## Acceptance criteria
- [ ] `RecordType` is defined in the domain using Typebox.
- [ ] Domain logic validates incoming payloads against `RecordType`.
- [ ] Endpoint returns 200 for valid payloads.
- [ ] Endpoint returns 400 for invalid payloads.
- [ ] Unit tests cover both valid and invalid payload scenarios.

## Blocked by
- #22
