import { describe, expect, it } from 'vitest';
import { parseCodexThemeImport } from './theme';

describe('Codex theme import', () => {
  it('parses copied codex-theme-v1 text', () => {
    const theme = parseCodexThemeImport(
      'codex-theme-v1:{"codeThemeId":"notion","theme":{"accent":"#3183d8","contrast":45,"fonts":{"code":null,"ui":null},"ink":"#37352f","opaqueWindows":true,"semanticColors":{"diffAdded":"#008000","diffRemoved":"#a31515","skill":"#0000ff"},"surface":"#ffffff"},"variant":"light"}'
    );

    expect(theme.codeThemeId).toBe('notion');
    expect(theme.variant).toBe('light');
    expect(theme.theme.accent).toBe('#3183d8');
  });

  it('rejects invalid theme text', () => {
    expect(() => parseCodexThemeImport('codex-theme-v1:not-json')).toThrow(
      'Theme must be valid Codex theme text.'
    );
  });
});
