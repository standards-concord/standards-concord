import type { SignInProvider } from "./types.js";

const tones = ["home", "drive", "docs", "tasks", "calendar", "contacts"] as const;

/** Accept a literal opaque RGB colour, never arbitrary CSS. */
export function validColor(value: string | undefined): string | undefined {
  return value && /^#[\da-f]{6}$/iu.test(value) ? value : undefined;
}

/** WCAG sRGB relative luminance for six-digit hex colours. */
export function relativeLuminance(color: string): number {
  if (!validColor(color)) throw new TypeError("Expected a six-digit hex colour");
  const linearChannel = (offset: number) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return linearChannel(1) * 0.2126 + linearChannel(3) * 0.7152 + linearChannel(5) * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** White where it meets AA normal-text contrast, otherwise near-black. */
export function foregroundFor(background: string): string {
  return contrastRatio(background, "#ffffff") >= 4.5 ? "#ffffff" : "#111111";
}

/** The first Unicode character, with a fallback for an empty display name. */
export function monogramFor(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() || "?";
}

/** Stable across renders and provider ordering; colours follow the active theme. */
export function toneFor(issuer: string): string {
  let hash = 0;
  for (const character of issuer)
    hash = (Math.imul(hash, 31) + (character.codePointAt(0) ?? 0)) >>> 0;
  return `var(--app-${tones[hash % tones.length]})`;
}

/** Rotate the app palette by a provider's zero-based list position. */
export function toneAt(index: number): string {
  return `var(--app-${tones[index % tones.length]})`;
}

/** HTTP(S) only; single-slash local paths require explicit opt-in for help links. */
export function safeHref(
  value: string | undefined,
  allowSameOriginPath = false,
): string | undefined {
  const target = value?.trim();
  // URL parsers can discard embedded whitespace or treat backslashes as slashes.
  if (!target || /[\s\\]/u.test(target)) return undefined;
  try {
    if (allowSameOriginPath && target.startsWith("/") && !target.startsWith("//")) {
      return target;
    }
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Display metadata only. URL validation and login resolution belong to the host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function signUpTarget(providers: readonly SignInProvider[]): string | undefined {
  for (const provider of providers) {
    const target = safeHref(provider.signUpUrl);
    if (target) return target;
  }
  return undefined;
}
