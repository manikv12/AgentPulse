import {
  AppearanceSettingsSchema,
  ImportedCodexThemeSchema,
  type AppearanceSettings,
  type ImportedCodexTheme,
  type ThemePreference
} from '@agent-pulse/shared';
import { useCallback, useEffect, useState } from 'react';

export type { AppearanceSettings, ImportedCodexTheme, ThemePreference } from '@agent-pulse/shared';

const STORAGE_KEY = 'agent-pulse:theme';
const APPEARANCE_STORAGE_KEY = 'agent-pulse:appearance';
const CODEX_THEME_PREFIX = 'codex-theme-v1:';

const CUSTOM_THEME_VARIABLES = [
  '--accent',
  '--accent-contrast',
  '--accent-hover',
  '--app-gradient',
  '--backdrop',
  '--bg',
  '--border',
  '--border-strong',
  '--focus-ring',
  '--glass-bg',
  '--glass-bg-strong',
  '--glass-border',
  '--glass-highlight',
  '--glass-shadow',
  '--markdown-body-tone',
  '--markdown-code-bg',
  '--markdown-code-border',
  '--markdown-code-sheen',
  '--markdown-code-text',
  '--markdown-heading',
  '--markdown-highlight-bg',
  '--markdown-highlight-text',
  '--markdown-link',
  '--markdown-marker',
  '--markdown-quote-bg',
  '--markdown-quote-border',
  '--markdown-quote-text',
  '--markdown-rule',
  '--markdown-strong',
  '--markdown-table-bg',
  '--markdown-table-text',
  '--popup-bg',
  '--popup-bg-strong',
  '--popup-border',
  '--popup-shadow',
  '--shadow-drawer',
  '--shadow-md',
  '--shadow-sm',
  '--surface',
  '--surface-muted',
  '--surface-sunken',
  '--text',
  '--text-muted',
  '--text-subtle',
  '--tone-blue',
  '--tone-blue-bg',
  '--tone-green',
  '--tone-green-bg',
  '--tone-red',
  '--tone-red-bg',
  '--ui-code-font-family',
  '--ui-font-family'
];

function readStored(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'system';
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function defaultAppearanceSettings(): AppearanceSettings {
  return {
    codexThemes: {},
    themePreference: 'system'
  };
}

export function normalizeAppearanceSettings(input: unknown): AppearanceSettings {
  return AppearanceSettingsSchema.catch(defaultAppearanceSettings()).parse(input);
}

function readStoredAppearance(): AppearanceSettings {
  if (typeof window === 'undefined') {
    return defaultAppearanceSettings();
  }
  const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
  if (!raw) {
    return defaultAppearanceSettings();
  }
  try {
    return normalizeAppearanceSettings(JSON.parse(raw));
  } catch {
    return defaultAppearanceSettings();
  }
}

function writeStoredAppearance(appearance: AppearanceSettings) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
}

function effectiveVariant(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') {
    return preference;
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function mix(left: string, leftPercent: number, right: string, rightPercent = 100 - leftPercent): string {
  return `color-mix(in srgb, ${left} ${leftPercent}%, ${right} ${rightPercent}%)`;
}

function clearCustomTheme(root: HTMLElement) {
  root.removeAttribute('data-codex-theme');
  for (const variable of CUSTOM_THEME_VARIABLES) {
    root.style.removeProperty(variable);
  }
}

function cssFont(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return `${trimmed}, ${fallback}`;
}

function applyImportedTheme(root: HTMLElement, importedTheme: ImportedCodexTheme | undefined) {
  clearCustomTheme(root);
  if (!importedTheme) {
    return;
  }

  const { accent, fonts, ink, opaqueWindows, semanticColors, surface } = importedTheme.theme;
  root.setAttribute('data-codex-theme', importedTheme.variant);
  root.style.setProperty('--bg', surface);
  root.style.setProperty('--surface', mix(surface, 92, ink));
  root.style.setProperty('--surface-muted', mix(surface, 96, ink));
  root.style.setProperty('--surface-sunken', mix(surface, 84, ink));
  root.style.setProperty('--border', mix(surface, 72, ink));
  root.style.setProperty('--border-strong', mix(surface, 58, ink));
  root.style.setProperty('--text', ink);
  root.style.setProperty('--text-muted', mix(ink, 70, surface));
  root.style.setProperty('--text-subtle', mix(ink, 52, surface));
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-contrast', surface);
  root.style.setProperty('--accent-hover', mix(accent, 84, ink));
  root.style.setProperty('--focus-ring', accent);
  root.style.setProperty('--shadow-sm', `0 1px 2px ${mix(ink, 14, 'transparent')}`);
  root.style.setProperty('--shadow-md', `0 8px 28px ${mix(ink, 12, 'transparent')}`);
  root.style.setProperty('--shadow-drawer', `-8px 0 24px ${mix(ink, 18, 'transparent')}`);
  root.style.setProperty('--backdrop', mix(ink, 42, 'transparent'));
  root.style.setProperty('--tone-blue', accent);
  root.style.setProperty('--tone-blue-bg', mix(accent, 16, surface));
  root.style.setProperty('--tone-green', semanticColors.diffAdded ?? '#2da44e');
  root.style.setProperty('--tone-green-bg', mix(semanticColors.diffAdded ?? '#2da44e', 14, surface));
  root.style.setProperty('--tone-red', semanticColors.diffRemoved ?? '#cf222e');
  root.style.setProperty('--tone-red-bg', mix(semanticColors.diffRemoved ?? '#cf222e', 14, surface));
  root.style.setProperty('--markdown-body-tone', mix(ink, 82, surface));
  root.style.setProperty('--markdown-heading', ink);
  root.style.setProperty('--markdown-strong', accent);
  root.style.setProperty('--markdown-link', accent);
  root.style.setProperty('--markdown-marker', mix(ink, 58, surface));
  root.style.setProperty('--markdown-quote-border', mix(accent, 32, surface));
  root.style.setProperty('--markdown-quote-bg', mix(accent, 10, surface));
  root.style.setProperty('--markdown-quote-text', mix(ink, 72, surface));
  root.style.setProperty('--markdown-code-bg', mix(surface, 86, ink));
  root.style.setProperty('--markdown-code-text', ink);
  root.style.setProperty('--markdown-code-border', mix(surface, 62, ink));
  root.style.setProperty('--markdown-code-sheen', mix(accent, 8, 'transparent'));
  root.style.setProperty('--markdown-table-bg', mix(surface, 88, ink));
  root.style.setProperty('--markdown-table-text', ink);
  root.style.setProperty('--markdown-rule', mix(surface, 62, ink));
  root.style.setProperty('--markdown-highlight-bg', mix(accent, 18, surface));
  root.style.setProperty('--markdown-highlight-text', mix(accent, 82, ink));
  root.style.setProperty('--glass-bg', opaqueWindows ? mix(surface, 92, ink) : mix(surface, 72, 'transparent'));
  root.style.setProperty('--glass-bg-strong', opaqueWindows ? mix(surface, 88, ink) : mix(surface, 82, 'transparent'));
  root.style.setProperty('--glass-border', mix(surface, 62, ink));
  root.style.setProperty('--glass-highlight', mix(surface, 80, 'transparent'));
  root.style.setProperty('--glass-shadow', `0 14px 40px ${mix(ink, 18, 'transparent')}`);
  root.style.setProperty('--popup-bg', mix(surface, 96, ink));
  root.style.setProperty('--popup-bg-strong', mix(surface, 92, ink));
  root.style.setProperty('--popup-border', mix(surface, 60, ink));
  root.style.setProperty('--popup-shadow', `0 24px 60px ${mix(ink, 20, 'transparent')}`);
  root.style.setProperty(
    '--app-gradient',
    `radial-gradient(900px 620px at 8% -10%, ${mix(accent, 12, 'transparent')}, transparent 58%),
    radial-gradient(760px 560px at 100% 110%, ${mix(ink, 8, 'transparent')}, transparent 55%)`
  );
  root.style.setProperty(
    '--ui-font-family',
    cssFont(
      fonts.ui,
      '"Söhne", "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    )
  );
  root.style.setProperty(
    '--ui-code-font-family',
    cssFont(fonts.code, 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace')
  );
}

function applyTheme(preference: ThemePreference, appearance = readStoredAppearance()) {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', preference);
  }

  applyImportedTheme(root, appearance.codexThemes[effectiveVariant(preference)]);
}

export function useThemePreference(): {
  theme: ThemePreference;
  appearance: AppearanceSettings;
  setAppearance: (next: AppearanceSettings) => void;
  setTheme: (next: ThemePreference) => void;
} {
  const [theme, setThemeState] = useState<ThemePreference>(() => readStored());
  const [appearance, setAppearanceState] = useState<AppearanceSettings>(() => readStoredAppearance());

  useEffect(() => {
    applyTheme(theme, appearance);
    if (theme !== 'system' || typeof window === 'undefined') {
      return;
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) {
      return;
    }
    const listener = () => applyTheme(theme, appearance);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [appearance, theme]);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const setAppearance = useCallback((next: AppearanceSettings) => {
    const parsed = normalizeAppearanceSettings(next);
    setAppearanceState(parsed);
    writeStoredAppearance(parsed);
    setThemeState(parsed.themePreference);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, parsed.themePreference);
    }
  }, []);

  return { theme, appearance, setAppearance, setTheme };
}

export function initThemeFromStorage() {
  applyTheme(readStored(), readStoredAppearance());
}

export function parseCodexThemeImport(source: string, sourceName?: string): ImportedCodexTheme {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('Theme file is empty.');
  }
  const rawJson = trimmed.startsWith(CODEX_THEME_PREFIX)
    ? trimmed.slice(CODEX_THEME_PREFIX.length)
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Theme must be valid Codex theme text.');
  }

  const theme = ImportedCodexThemeSchema.omit({ importedAt: true }).parse({
    ...(parsed as Record<string, unknown>),
    sourceName
  });
  return theme;
}
