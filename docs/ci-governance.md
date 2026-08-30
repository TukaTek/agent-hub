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
JSON and rejects manifest symlinks or other non-regular targets. A read-only snapshot-handle close
failure is terminal because closure is unproven; a later snapshot cannot turn that failure into
success.

Replacement is crash-safe up to the guarantees of the host filesystem. The writer exclusively
creates a uniquely named same-directory regular temp file with mode `0600`, writes the canonical
bytes completely, applies the final mode, and syncs it. It keeps that canonical file handle open
through pathname-based rename, parent-directory sync, and final destination validation and owned
inode accounting. Before rename it checks the handle and pathname as regular files, checks
device/inode identity where Node exposes meaningful values, link count, size, and mode, and reads
the file back through both paths to require byte-for-byte and SHA-256 equality with the canonical
output.

Rename is not the success boundary. While the canonical handle is still open, the writer opens and
reads the destination without following symlinks. It requires the destination to name that same
inode and to contain and fully validate as the expected canonical manifest. A different inode is
accepted only when its exact bytes, hash, metadata, and full manifest validation prove that an
identical concurrent generator won the race and the invocation-owned inode has link count zero or
is otherwise fully accounted for. The destination is checked before and after parent-directory sync
and the canonical handle closes only after the final validation and accounting step. Any other
during-rename or post-rename change fails the operation.

If install verification fails after rename has or may have run, the writer makes one bounded recovery
attempt. It restores the byte-identical previously validated manifest with a new independently
named exclusive temp file and the same write, sync, metadata, read-back, rename, and destination
verification cycle. Recovery never calls itself or retries indefinitely. A verified restoration is
reported together with the original failure. If restoration cannot be proved, the command returns
a prominent fail-closed recovery error stating that manifest integrity is uncertain; it does not
claim that prior bytes were preserved. Missing-manifest bootstrap has no prior bytes to restore and
therefore fails with the same integrity warning if a post-rename race is detected.

Failed attempts never pathname-unlink an entry whose identity can change between validation and
deletion. With its recorded device/inode identity and, where possible, the still-open handle, the
writer scans at most 4,096 entries in `.github/` and selects only one regular entry with that exact
identity and a safe single-link count. Exactly 4,096 observed entries is allowed; observing a
4,097th entry fails closed. This also finds a canonical temp displaced under another filename.

For an owned entry that still has a directory link, cleanup creates an invocation-specific
quarantine hard link with the filesystem's exclusive `link` operation. Unlike rename, this cannot
overwrite an existing or concurrently replaced quarantine pathname. The writer validates both
links as the recorded inode with link count two. Node has no portable unlink-by-handle operation,
so it then reports a prominent fail-closed residual-integrity error and preserves the paths rather
than risk deleting unrelated content substituted at either pathname. A replacement injected after
quarantine validation is therefore never passed to pathname unlink. If the owned handle already
reports link count zero, no residual exists and accounting succeeds without quarantine. If inode
identity is unavailable, the scan is too large, the quarantine is occupied, or identity/link-count
checks are inconclusive, the writer likewise fails closed and does not claim cleanup succeeded.

On non-Windows hosts the writer syncs `.github/` after verified replacement and then re-reads and
fully validates the destination whether sync succeeds or fails. It retains the owned handle during
both paths. A noncanonical change after a successful sync enters the same single bounded recovery.
A byte-identical canonical concurrent replacement may win only after the handle proves that the
invocation-owned inode has no directory link. If a hostile writer moves that inode outside the
bounded `.github/` scan, the open handle exposes its nonzero link count and the command returns
explicit residual-integrity uncertainty rather than success. Parent-directory sync is skipped on
Windows because Node does not provide one portable durability contract across Windows filesystems.
File and directory durability still depends on the operating system, filesystem, mount, and storage
hardware honoring their sync guarantees.

Nested writer, recovery, scan, and handle-close failures are flattened into concise CLI-visible
cause text. Messages preserve actionable error codes such as `EIO` and `EACCES`, collapse multiline
output, redact common credential shapes, remove absolute paths, and never print stacks.

These checks defend against accidental or concurrent same-account replacement that is observable
through Node's pathname, handle, metadata, and read-back APIs. Node has no portable rename- or
unlink-by-open-handle primitive. Exclusive hard-link quarantine prevents destination overwrite, and
the absence of identity-bound unlink is handled by preserving residuals, not by pretending a
pathname check closes the gap. This protocol cannot turn a Git worktree writable by a hostile user
or process into a security boundary. Isolated CI workspaces, exact-head verification, and
protected-branch review enforcement remain authoritative controls.

`node scripts/repository-policy.mjs` and the explicit check flags are read-only. The policy fails
closed when Git metadata is unavailable; a Git clone works, while a metadata-free archive cannot
silently narrow the tracked-file inventory.

Strict workflow YAML parsing, the exact workflow set, immutable full-SHA Action pins, exact
candidate checkout and provenance, authorized image build identities and local context `.`,
Gitleaks, exact CODEOWNERS rules, and external branch-protection evidence remain separate semantic
controls.
