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

`pnpm policy:manifest` is the documented regeneration path. The writer emits the checked-in
canonical JSON bytes directly, then the command validates them without a formatter rewrite. The
lower-level `--write-source-tree-manifest` command emits the same bytes. Regeneration may replace a
valid stale manifest or create a missing bootstrap manifest, but refuses malformed or duplicate-key
JSON and rejects manifest symlinks or other non-regular targets.

Replacement is crash-safe up to the guarantees of the host filesystem: the writer exclusively
creates a uniquely named same-directory regular temp file with mode `0600`, completes and syncs the
write, closes it, and atomically renames it over the target. Failed create, write, file sync, close,
or rename operations leave the previous manifest unchanged and remove only the invocation's own
temp file. Concurrent regenerators use independent temp names and install identical canonical
bytes. On non-Windows hosts the writer also syncs `.github/` after rename; if that sync fails it
reports that the new manifest is already installed and does not attempt an unsafe rollback. Parent
directory sync is skipped on Windows because Node does not provide one portable durability contract
across Windows filesystems. File and directory sync durability still depends on the operating
system, filesystem, mount, and storage hardware honoring their sync guarantees.

`node scripts/repository-policy.mjs` and the explicit check flags are read-only. The policy fails
closed when Git metadata is unavailable; a Git clone works, while a metadata-free archive cannot
silently narrow the tracked-file inventory.

Strict workflow YAML parsing, the exact workflow set, immutable full-SHA Action pins, exact
candidate checkout and provenance, authorized image build identities and local context `.`,
Gitleaks, exact CODEOWNERS rules, and external branch-protection evidence remain separate semantic
controls.
