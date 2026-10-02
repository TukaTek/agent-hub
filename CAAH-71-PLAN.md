# CAAH-71 Implementation Plan

## Review Gaps to Fix

### Gap 1: Detection never fires in production
**Problem:** fieldType, autocomplete, fieldLabel added to type but never populated
**Fix:** Capture field metadata in TeachCaptureOverlay and Protected input
- Extract focused element's type, autocomplete, and safe label
- Add test proving password field keystroke has no key/text

### Gap 2: Text still stored literally
**Problem:** redactTypedText returns text unchanged by default
**Fix:** Default to placeholder, require explicit opt-in via keepLiteral flag
- Change redactTypedText to return placeholder by default
- Add keepLiteral flag to TeachRecordingEvent
- Strip key/text from non-opted-in events in recording

### Gap 3: Server-side enforcement
**Problem:** Old clients could bypass sanitization
**Fix:** Sanitize and rebuild playbook on every API save/update
- Add sanitization to taught-skills.ts save/updateDraft
- Add API test proving password events are scrubbed

### Gap 4: Legacy purge incomplete
**Problem:** Rows without fieldType have keystrokes left intact
**Fix:** For saved skills, drop ALL key/text (except keepLiteral)
- Enhance purge logic in teaching-purge.ts
- Add test for legacy rows without fieldType

### Gap 5: AC2 replay test incomplete
**Problem:** teaching-replay.test.ts doesn't test actual executor path
**Fix:** Test with mocked model client, capture request body
- Mock HTTP/model layer in executor test
- Assert secret absent, placeholder present
- Implement minimal placeholder resolution (ask user)

### Gap 6: Purge infrastructure unsafe
**Problem:** Purge could crash API, runs in tests, not idempotent
**Fix:** Wrap errors, skip in tests, run once
- Wrap purge call in app.ts
- Add real Postgres integration test
- Ensure it runs only once per process

### Gap 7: CI failures
**Problem:** Lint and typecheck errors
**Fix:** Fix all errors
- Fix teaching-purge.test.ts typecheck errors (lines 68-72, 97-100)
- Fix 5 lint errors
- Run full test suite locally

## Implementation Order

1. Fix typecheck errors (Gap 7a)
2. Add field metadata capture (Gap 1)
3. Default to placeholder redaction (Gap 2)
4. Add server-side enforcement (Gap 3)
5. Enhance legacy purge (Gap 4)
6. Complete AC2 replay test (Gap 5)
7. Secure purge infrastructure (Gap 6)
8. Fix lint errors (Gap 7b)
9. Run full test suite and wait for CI

Each step will be committed separately.
