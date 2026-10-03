# Auth test fixtures

Both Hub files below are verbatim copies from `TukaTek/cortexai-hub`. Do not edit them. To update one, copy it again from Hub, then update its record here and the pinned sha256 in `../hub-fixtures-drift.test.ts`. That test fails if a file's bytes or its record here drift. If our parser disagrees with a case in Hub's file, report the case to Hub and don't change the file.

## hub-agent-hub-service-config.v1.sample.json

Hub's published sample of the Agent Hub service config. Its assignment rows are `{tenantUserId, tenantId, productId, role}` under the `agent-hub-assignments.v1` marker.

- Source repository: `TukaTek/cortexai-hub`
- Source path: `docs/agent-hub-service-config.v1.sample.json`
- Source commit: `5348df5354c869245bc43dfb909db23cfe0688fd` (CAH-204, cortexai-hub#103)
- sha256: `6d689c9828be64482f9afaa06da215fa9f2b2a9701e212ca24aed19cc74230a6`
- Git blob SHA: `021b9b9909a00eeaf989c2178fbbf78c55d8e660` (`git hash-object` of this file must match)

The contract test in `../hub-policy-contract.test.ts` checks that `parseHubPolicy` accepts it unchanged.

## hub-agent-hub-settings.v1.invalid-values.json

Hub's shared bad-value fixture. Hub's save-time validation and this parser both run it, so a value Hub saves is one Agent Hub accepts. It has `settings` cases (a Hub setting path and a value), `toolkitIds` cases, and `valid` cases that both sides must accept.

- Source repository: `TukaTek/cortexai-hub`
- Source path: `docs/agent-hub-settings.v1.invalid-values.json`
- Source commit: `5348df5354c869245bc43dfb909db23cfe0688fd` (CAH-204, cortexai-hub#103)
- sha256: `e3f8ed44e90b7d7ded55a89682985788ad058b369c707a852ad2fa24af8aa817`
- Git blob SHA: `e50eea578635777240f708d1bcd14279651e8544` (`git hash-object` of this file must match)

`../hub-policy-invalid-values.test.ts` applies each case to a copy of the sample above. A settings case must fail as `HUB_CONFIG_INVALID` with reason `setting:<path>`, a toolkit id must fail in either Composio tier, and every valid case must parse.
