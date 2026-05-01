import type { AgentProvider, CatalogModel } from '@agent-pulse/shared';

export type ProviderTone = 'codex' | 'claude-code' | 'copilot';
export type ModelPickerGroup = {
  id: string;
  label: string;
  models: CatalogModel[];
  collapsible: boolean;
};

export function providerForThread(provider: AgentProvider | undefined): AgentProvider {
  return provider ?? 'codex';
}

export function providerLabel(provider: AgentProvider | undefined): string {
  switch (providerForThread(provider)) {
    case 'claude-code':
      return 'Claude';
    case 'copilot':
      return 'Copilot';
    case 'codex':
    default:
      return 'Codex';
  }
}

export function providerTone(provider: AgentProvider | undefined): ProviderTone {
  return providerForThread(provider);
}

export function providerForModel(model: Pick<CatalogModel, 'provider'> | undefined): AgentProvider {
  return providerForThread(model?.provider);
}

export function normalizeProviderModelSlug(
  provider: AgentProvider | undefined,
  modelSlug: string | undefined
): string | undefined {
  const trimmed = modelSlug?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (providerForThread(provider) === 'codex') {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (providerForThread(provider) === 'copilot') {
    return lower === 'default' || lower === 'copilot' ? trimmed : trimmed;
  }
  if (lower === 'opus' || lower.includes('opus')) {
    return 'opus';
  }
  if (lower === 'sonnet' || lower.includes('sonnet')) {
    return 'sonnet';
  }
  return trimmed;
}

export function groupModelsForPicker(
  provider: AgentProvider | undefined,
  models: CatalogModel[]
): ModelPickerGroup[] {
  if (providerForThread(provider) !== 'copilot') {
    return models.length > 0
      ? [{ id: providerForThread(provider), label: providerLabel(provider), models, collapsible: false }]
      : [];
  }

  const groups = new Map<string, ModelPickerGroup>();
  for (const model of models) {
    const group = copilotModelVendorGroup(model);
    const existing = groups.get(group.id);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.set(group.id, { ...group, models: [model], collapsible: true });
    }
  }
  return [...groups.values()];
}

function copilotModelVendorGroup(
  model: Pick<CatalogModel, 'slug' | 'displayName'>
): Omit<ModelPickerGroup, 'models' | 'collapsible'> {
  const slug = model.slug.trim().toLowerCase();
  const displayName = model.displayName.trim().toLowerCase();
  if (slug.startsWith('gpt-') || displayName.startsWith('gpt')) {
    return { id: 'openai', label: 'OpenAI GPT' };
  }
  if (slug.startsWith('claude-') || displayName.startsWith('claude')) {
    return { id: 'anthropic', label: 'Anthropic Claude' };
  }
  if (slug.startsWith('gemini-') || displayName.startsWith('gemini')) {
    return { id: 'google', label: 'Google Gemini' };
  }
  return { id: 'other', label: 'Other models' };
}
