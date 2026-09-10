# App icon source

CortexAI Agent Hub uses the source images in [`brand`](../../../brand).
Run `pnpm brand:generate` from the repository root to regenerate the desktop,
mobile, web, and social assets.

Desktop packaging uses `apps/desktop/assets/icon.icns` on macOS, `icon.ico` on
Windows, and `icon.png` on Linux. The development macOS icon is `icon-macos.png`.

Mobile uses `apps/mobile/assets/icon.png`, with `adaptive-icon.png` and
`monochrome-icon.png` for Android launchers. Android supplies its own mask;
the adaptive background color is configured in `apps/mobile/app.json`.
