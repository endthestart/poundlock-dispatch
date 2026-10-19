# Poundlock ecosystem compatibility

Dispatch is the project and orchestration client in the Poundlock family.
[Poundlock](https://github.com/endthestart/poundlock) owns inference discovery,
admission, runtime readiness, managed external access, usage and durable jobs.
[Poundlock Toolkit](https://github.com/endthestart/poundlock-toolkit) runs before
Poundlock is installed and measures what a machine and model can do. Each has its
own repository, version and releases.

[`compat/poundlock.json`](compat/poundlock.json) says what this Dispatch needs from
a controller: API major 1, contract revision 3 or later, and a list of features.
The connection test reads the controller's `GET /api/v1/capabilities` and refuses
one that does not meet it, naming the version to upgrade to. Additive fields are
tolerated. Profile ID, request name, destination, routing revision, availability
and suitability stay separate facts.

## Tested combination

| Dispatch | Poundlock | Toolkit |
|---|---|---|
| 0.3.0 | 0.3.0 (API 1, contract revision 5) | 0.5.0 |

Contract revision 5 adds the capacity queue. Dispatch asks to wait in line for a
busy model; an older controller ignores that and answers at once, as before.

## Changing a contract

1. Change the owning schema and its fixture in Poundlock, additively.
2. Release Poundlock.
3. Update Dispatch and its fixtures, and raise `minimum_contract_revision` only
   when Dispatch needs the new feature.
