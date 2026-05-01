import { describe, expect, it } from 'vitest';
import { groupModelsForPicker, normalizeProviderModelSlug, providerLabel, providerTone } from './providers';

describe('provider helpers', () => {
  it('labels and tones GitHub Copilot threads', () => {
    expect(providerLabel('copilot')).toBe('Copilot');
    expect(providerTone('copilot')).toBe('copilot');
  });

  it('keeps Copilot model slugs provider-specific', () => {
    expect(normalizeProviderModelSlug('copilot', 'gpt-5.2')).toBe('gpt-5.2');
  });

  it('groups Copilot picker models by underlying vendor', () => {
    const groups = groupModelsForPicker('copilot', [
      { slug: 'gpt-5.4', displayName: 'GPT-5.4', provider: 'copilot' },
      { slug: 'claude-opus-4.6', displayName: 'Claude Opus 4.6', provider: 'copilot' },
      { slug: 'gemini-3-pro-preview', displayName: 'Gemini 3 Pro Preview', provider: 'copilot' }
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ id: 'openai', label: 'OpenAI GPT', collapsible: true }),
      expect.objectContaining({ id: 'anthropic', label: 'Anthropic Claude', collapsible: true }),
      expect.objectContaining({ id: 'google', label: 'Google Gemini', collapsible: true })
    ]);
  });
});
