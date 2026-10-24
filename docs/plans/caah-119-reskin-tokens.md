# CAAH-119: visual refresh phase (a) — tokens, motion, type

Port the structure of OpenMausBot's token system (Apache-2.0, upstream
https://github.com/milind-soni/OpenMausBot) under the CortexAI brand. Web and
desktop adopt it through `packages/ui-tokens` and `packages/ui-web`; mobile only
gains new token keys.

## Decisions

- **Additive only.** Every existing `ColorTokens` key keeps its value, so mobile,
  desktop and every shadcn component render exactly as before. The new semantic
  ladder lives next to the shadcn names; where a slot already exists the new key
  takes the existing value (`app` = `background`, `panel` = `sidebar`, `card` =
  `card`, `menu` = `popover`, `hairline` = `border`, `ink` = `foreground`,
  `bubbleUser` = `chatUser`, `danger` = `destructive`, ...). New values exist
  only where no shadcn slot fits or where the existing value cannot meet the
  contrast gate (light `inkSecondary`/`inkTertiary` are opaque because the iOS
  translucent labels measure ~4.2:1 on cards).
- **Accent naming.** shadcn already owns `--accent` (hover fill), so the brand
  accent fill is `accentFill` (`--accent-fill`), mirroring `destructiveFill`;
  `accentBorder`, `accentText`, `accentInk` follow. Accent = existing brand
  orange `#F7933B` (no confirmed guideline hex). Light theme uses darker orange
  text/focus/border so they clear AA.
- **No skins.** Only `[data-theme="dark"]` and `[data-theme="light"]`; no Grok
  blue.
- **Adoption is a later phase.** `--ring`, `--primary` etc. are unchanged; this
  phase ships the tokens, utilities and the contrast gate. The visible changes are
  the chat copy rule and the icon wrapper.
- **Radii unchanged.** `--radius` 0.75rem scale stays; no `--radius-lg/xl`
  overrides without screenshot evidence of parity issues.
- **Motion.** `@theme` animation tokens panel-in, pop-in, pop-out, msg-in,
  shimmer, status-pulse, rise, spot-in with keyframes copied verbatim.
  `rise` is capped at 240ms (upstream uses 320ms); every token is <=240ms. Reduced motion sets every token to
  `none`, so variants (`data-open:animate-pop-in`) are covered too.
- **Glass.** `--shadow-popover` + `.glass-surface` (inset highlight, 24/64 drop,
  28px backdrop blur); solid `--menu` fill under
  `prefers-reduced-transparency: reduce`.
- **Type.** Geist stays. `chat-copy` utility: 15px / 1.75 with a local-only
  `cah-chat` face for Arabic and Hebrew, applied to chat bubbles.
- **Icons.** Sidebar and composer already use lucide only (no inline SVGs to
  replace). Add `<Icon>` (16 / 1.75) to `ui-web` and use it there; tiny chip
  glyphs keep an explicit smaller size.

## Steps

1. Attribution: `NOTICE`, `third_party/openmausbot/LICENSE`.
2. Tokens: new keys in `packages/ui-tokens/src/index.ts`, regenerate
   `tokens.css`, update tests.
3. Contrast gate: `packages/ui-tokens/scripts/check-contrast.mjs` (adapted from
   `check-skin-contrast.mjs`), parsed from `tokens.css`, run from the package
   `check` script so CI's Typecheck job runs it.
4. `ui-web/styles.css`: Tailwind color mappings, shadow, glass, motion; a unit
   test that every `var(--x)` in the `@theme inline` map is defined in
   `tokens.css` (catches removed vars).
5. Chat copy rule in `apps/web/src/styles.css` and the bubbles.
6. `<Icon>` wrapper; sidebar header + composer.
7. Playwright fixture + spec for reduced motion (`emulateMedia`) and reduced
   transparency (Chromium CDP `Emulation.setEmulatedMedia`, since
   `emulateMedia` has no transparency option).

## Verification

- `tokens.css` diff is additions only (45 lines, 0 removed): mobile's token
  export changes only by additions.
- Contrast gate: dark and light, 49 pairs each, none below target.
- `styles.test.ts` fails if a `@theme inline` mapping reads a var missing from
  either theme (the "removed var" grep, as a unit test).
- `e2e/motion-tokens.spec.ts` runs against the Vite server alone (no API).

## Screenshots

The before/after set needs the full stack (`pnpm dev` with Postgres and the
API) driven by testkit fixtures. That is not available in this environment, so
screenshots are left for the CI E2E job / the PR author; this is noted rather
than substituted with unrelated captures.
