import type { AgentProvider, CatalogModel } from '@agent-pulse/shared';

export type ProviderTone = 'codex' | 'claude-code';

export function providerForThread(provider: AgentProvider | undefined): AgentProvider {
  return provider ?? 'codex';
}

export function providerLabel(provider: AgentProvider | undefined): string {
  switch (providerForThread(provider)) {
    case 'claude-code':
      return 'Claude';
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
  if (providerForThread(provider) !== 'claude-code') {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'opus' || lower.includes('opus')) {
    return 'opus';
  }
  if (lower === 'sonnet' || lower.includes('sonnet')) {
    return 'sonnet';
  }
  return trimmed;
}
