# Auth test fixtures

## hub-agent-hub-service-config.v1.sample.json

A verbatim copy of Hub's published sample of the Agent Hub service config. Do not edit it. To update it, copy the file again from Hub and update this record.

- Source repository: `TukaTek/cortexai-hub`
- Source path: `docs/agent-hub-service-config.v1.sample.json`
- Source commit: `c140bd6c3e017c6eec1036c1219d0fca5ce1b18e` (CAH-204, cortexai-hub#103)
- Git blob SHA: `e9312cd569440288de7df550b9969ea7427e633a` (`git hash-object` of this file must match)

The contract test in `../hub-policy-contract.test.ts` checks that `parseHubPolicy` accepts it unchanged.
