# CI governance pilot

Rakazo uses a conservative whole-tree manifest for the CAAH-30 pilot. The policy runs
`git ls-files --stage -z` at the repository root and binds every tracked regular file at the
checkout except `.github/ci-executable-surface.json`, which is excluded only to avoid
self-reference. Each entry records its normalized POSIX path, Git mode and type, byte length,
and SHA-256 content digest. The manifest also records an aggregate SHA-256 over the ordered
entries.

This is deliberately not a claim that the policy understands shell commands or executable
reachability. Comments, heredocs, quoted text, wrappers, application code, documentation, and
binary files are treated the same way: their tracked bytes and Git modes must match the reviewed
manifest.

The tradeoff is intentional: every source-controlled byte, mode, add, removal, or rename requires
`pnpm policy:manifest`. That refresh changes the exact CODEOWNED manifest rule
`/.github/ci-executable-surface.json @acepgh`, so a protected branch can require the designated
owner to review every repository change during the pilot. The manifest and CODEOWNERS file cannot
enforce their own review. Live branch protection or an equivalent repository ruleset remains a
required process control.

`pnpm policy:manifest` is the only regeneration path. It is deterministic and may replace a
valid stale manifest or create a missing bootstrap manifest. It refuses malformed or duplicate-key
JSON. `node scripts/repository-policy.mjs` and the explicit check flags are read-only. The policy
fails closed when Git metadata is unavailable; a Git clone works, while a metadata-free archive
cannot silently narrow the tracked-file inventory.

Strict workflow YAML parsing, the exact workflow set, immutable full-SHA Action pins, exact
candidate checkout and provenance, authorized image build identities and local context `.`,
Gitleaks, exact CODEOWNERS rules, and external branch-protection evidence remain separate semantic
controls.
