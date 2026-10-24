export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "cortexai-agent-hub.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  /** Modals: a step lighter than the page so they read as raised above it. */
  dialog: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  /** Fill and hairline where native Liquid Glass is unavailable (Android, iOS before 26). */
  glassFill: string;
  glassStroke: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  /** White in both themes: the user bubble is a solid fill (light grey in dark, near-black in light). */
  chatUserForeground: string;
  muted: string;
  mutedForeground: string;
  /** Tertiary text: placeholders, list markers, quote bars, timestamps. */
  faintForeground: string;
  accent: string;
  accentForeground: string;
  /** Destructive text and outlines. */
  destructive: string;
  /** Solid destructive fill (Hang up, a filled Delete); its text is `destructiveForeground`. */
  destructiveFill: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  link: string;
  /** Backing behind a link's site icon. White in both themes so dark logos stay visible on any bubble. */
  faviconPlate: string;
  success: string;
  warning: string;
  statusWorking: string;
  /** Unread dot. The one blue in the inbox, in both themes. */
  unread: string;
  /** Working dot on a busy bot's avatar. The one green, in both themes. */
  workingDot: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
  brand: string;
  brandForeground: string;
  brandSurface: string;
  brandSurfaceForeground: string;
} & SurfaceLadderTokens;

// Adapted from OpenMausBot src/styles.css (Apache-2.0). Modified by TukaTek.
/**
 * Semantic surface ladder, from the page up: `app` < `panel` < `card` < `raised`.
 * Each slot that shadcn already names takes that slot's value, so the shadcn
 * names stay valid aliases. Every ink clears 4.5:1 on every surface and `focus`
 * clears 3:1, enforced by `scripts/check-contrast.mjs`.
 */
export type SurfaceLadderTokens = {
  app: string;
  panel: string;
  raised: string;
  raisedHover: string;
  menu: string;
  /** Recessed fields and wells. */
  inset: string;
  /** A control drawn on a card. */
  control: string;
  hairline: string;
  ink: string;
  inkSecondary: string;
  /** Quietest text that still clears 4.5:1: timestamps, hints, placeholders. */
  inkTertiary: string;
  /** Keyboard focus ring. */
  focus: string;
  bubbleUser: string;
  bubbleUserInk: string;
  /** Brand orange fill. `accent` stays shadcn's hover fill. */
  accentFill: string;
  accentBorder: string;
  /** Orange text on `app`, `panel`, `card` and `menu`. */
  accentText: string;
  /** Text on `accentFill`. */
  accentInk: string;
  successInk: string;
  danger: string;
  dangerInk: string;
  warningInk: string;
};

const darkBase = {
  background: "#141414",
  dialog: "#1E1E1E",
  foreground: "#FFFFFF",
  card: "#202020",
  cardForeground: "#FFFFFF",
  popover: "#202020",
  popoverForeground: "#FFFFFF",
  glassFill: "#2C2C2E",
  glassStroke: "#FCFCFC26",
  primary: "#FFFFFF",
  primaryForeground: "#000000",
  secondary: "#7676803D",
  secondaryForeground: "#FFFFFF",
  chatUser: "#5C5C5C",
  chatUserForeground: "#FFFFFF",
  muted: "#202020",
  mutedForeground: "#EBEBF599",
  faintForeground: "#EBEBF573",
  accent: "#78788052",
  accentForeground: "#FFFFFF",
  destructive: "#FF9592",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#FCFCFC14",
  input: "#54545899",
  ring: "#3B82F6",
  sidebar: "#1E1E1E",
  sidebarForeground: "#FFFFFF",
  sidebarBorder: "#FCFCFC14",
  sidebarAccent: "#2B2B2E",
  sidebarAccentForeground: "#FFFFFF",
  link: "#459FFE",
  faviconPlate: "#FFFFFF",
  success: "#3FA266",
  warning: "#DB941E",
  statusWorking: "#459FFE",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(4, 4, 5, 0.62)",
  scrollbar: "#2A2A2E",
  scrollbarHover: "#414147",
  brand: "#F7933B",
  brandForeground: "#231F20",
  brandSurface: "#231F20",
  brandSurfaceForeground: "#FFFFFF",
} as const;

export const darkTokens = {
  ...darkBase,
  app: darkBase.background,
  panel: darkBase.sidebar,
  raised: darkBase.sidebarAccent,
  raisedHover: "#353538",
  menu: darkBase.popover,
  inset: "#191919",
  control: darkBase.sidebarAccent,
  hairline: darkBase.border,
  ink: darkBase.foreground,
  inkSecondary: darkBase.mutedForeground,
  inkTertiary: "#EBEBF594",
  focus: darkBase.brand,
  bubbleUser: darkBase.chatUser,
  bubbleUserInk: darkBase.chatUserForeground,
  accentFill: darkBase.brand,
  accentBorder: darkBase.brand,
  accentText: darkBase.brand,
  accentInk: darkBase.brandForeground,
  successInk: darkBase.background,
  danger: darkBase.destructive,
  dangerInk: darkBase.background,
  warningInk: darkBase.background,
} as const satisfies ColorTokens;

const lightBase = {
  background: "#FCFCFC",
  dialog: "#FFFFFF",
  foreground: "#000000",
  card: "#EFEFEF",
  cardForeground: "#000000",
  popover: "#FFFFFF",
  popoverForeground: "#000000",
  glassFill: "#FFFFFF",
  glassStroke: "#14141416",
  primary: "#000000",
  primaryForeground: "#FFFFFF",
  secondary: "#7676801F",
  secondaryForeground: "#000000",
  chatUser: "#0B0B0B",
  chatUserForeground: "#FFFFFF",
  muted: "#F2F2F1",
  mutedForeground: "#3C3C43B3",
  faintForeground: "#3C3C4394",
  accent: "#78788029",
  accentForeground: "#000000",
  destructive: "#CE2C31",
  destructiveFill: "#E5484D",
  destructiveForeground: "#FFFFFF",
  border: "#14141414",
  input: "#3C3C434A",
  ring: "#6C6C70",
  sidebar: "#F7F7F7",
  sidebarForeground: "#000000",
  sidebarBorder: "#14141414",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#000000",
  link: "#0C64C1",
  faviconPlate: "#FFFFFF",
  success: "#007041",
  warning: "#885A07",
  statusWorking: "#0C64C1",
  unread: "#006CEB",
  workingDot: "#3FA266",
  overlay: "rgba(0, 0, 0, 0.19)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
  brand: "#F7933B",
  brandForeground: "#231F20",
  brandSurface: "#231F20",
  brandSurfaceForeground: "#FFFFFF",
} as const;

export const lightTokens = {
  ...lightBase,
  app: lightBase.background,
  panel: lightBase.sidebar,
  raised: lightBase.sidebarAccent,
  raisedHover: "#F0F0F0",
  menu: lightBase.popover,
  inset: lightBase.muted,
  control: "#E4E4E4",
  hairline: lightBase.border,
  ink: lightBase.foreground,
  // Opaque: the translucent iOS label colours measure ~4.2:1 on cards.
  inkSecondary: "#5E5E63",
  inkTertiary: "#636368",
  focus: "#B85600",
  bubbleUser: lightBase.chatUser,
  bubbleUserInk: lightBase.chatUserForeground,
  accentFill: lightBase.brand,
  accentBorder: "#B85600",
  accentText: "#A84E00",
  accentInk: lightBase.brandForeground,
  successInk: "#FFFFFF",
  danger: lightBase.destructive,
  dangerInk: "#FFFFFF",
  warningInk: "#FFFFFF",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const fontWeight = { regular: "400", medium: "500", semibold: "600" } as const;

/**
 * Native text styles on the system font, in points: iOS body text is 17/22. Titles use the
 * font's own line spacing, written out so they don't inherit a smaller body line height.
 */
export const typeScale = {
  title: { fontSize: 22, lineHeight: 26, fontWeight: fontWeight.semibold },
  headline: { fontSize: 19, lineHeight: 23, fontWeight: fontWeight.semibold },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: fontWeight.medium },
  body: { fontSize: 17, lineHeight: 22 },
  secondary: { fontSize: 15, lineHeight: 19 },
  caption: { fontSize: 14, lineHeight: 18 },
  footnote: { fontSize: 12, lineHeight: 16 },
} as const;

/**
 * Text grows with the iOS text size until body text reaches 23pt, the xxxLarge size. Larger
 * accessibility sizes keep that size, so message bubbles, rows and cards keep their layout.
 */
export const MAX_FONT_SCALE = 23 / typeScale.body.fontSize;

export const botColors = [
  "#3EC5A8",
  "#F5A03C",
  "#6A6BF5",
  "#9B5CF6",
  "#3B82F6",
  "#F2622A",
  "#D9508A",
] as const;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function renderBlock(selector: string, colorScheme: ResolvedAppearance, palette: ColorTokens) {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n  --radius: ${RADIUS};\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @cortexai-agent-hub/ui-tokens generate`. Edit src/index.ts instead. */\n/* Surface ladder adapted from OpenMausBot src/styles.css (Apache-2.0). Modified by TukaTek. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
  ].join("\n\n")}\n`;
}
