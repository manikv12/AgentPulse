import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CatalogReader,
  parseFrontmatter,
  parsePluginConfigBlocks,
  readPlugins,
  readSkills,
  readModels
} from './catalog';

function createCodexHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'codex-home-'));
}

function writeFile(target: string, content: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

describe('parsePluginConfigBlocks', () => {
  it('parses qualified plugin headers and enabled flags', () => {
    const result = parsePluginConfigBlocks(
      `[other-section]\n` +
        `enabled = false\n\n` +
        `[plugins."github@openai-curated"]\nenabled = true\n\n` +
        `[plugins."alpaca@openai-curated"]\nenabled = false\n` +
        `[plugins."browser-use@openai-bundled"]\nenabled = true\n`
    );
    expect(result.get('github@openai-curated')).toEqual({ enabled: true });
    expect(result.get('alpaca@openai-curated')).toEqual({ enabled: false });
    expect(result.get('browser-use@openai-bundled')).toEqual({ enabled: true });
    expect(result.has('other-section')).toBe(false);
  });
});

describe('parseFrontmatter', () => {
  it('extracts simple key/value pairs from YAML frontmatter', () => {
    const fm = parseFrontmatter(
      '---\nname: test-skill\ndescription: "Hello"\nargument-hint: "[arg]"\n---\nbody'
    );
    expect(fm.get('name')).toBe('test-skill');
    expect(fm.get('description')).toBe('Hello');
    expect(fm.get('argument-hint')).toBe('[arg]');
  });

  it('returns empty map when no frontmatter is present', () => {
    expect(parseFrontmatter('# heading').size).toBe(0);
  });
});

describe('readPlugins', () => {
  it('joins config.toml enable state with cached manifests and synthesises icon URLs', () => {
    const codexHome = createCodexHome();
    writeFile(
      path.join(codexHome, 'config.toml'),
      `[plugins."alpaca@openai-curated"]\nenabled = true\n[plugins."ghosted@openai-curated"]\nenabled = false\n`
    );
    const versionDir = path.join(
      codexHome,
      'plugins',
      'cache',
      'openai-curated',
      'alpaca',
      'b066e4a0'
    );
    writeFile(
      path.join(versionDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'alpaca',
        author: { name: 'Alpaca' },
        homepage: 'https://alpaca.markets/',
        interface: {
          displayName: 'Alpaca',
          shortDescription: 'Stop watching the markets.',
          category: 'Research',
          composerIcon: './assets/app-icon.png'
        }
      })
    );
    writeFile(path.join(versionDir, 'assets', 'app-icon.png'), 'PNG');

    const plugins = readPlugins(codexHome);
    const alpaca = plugins.find((plugin) => plugin.qualifiedSlug === 'alpaca@openai-curated');
    expect(alpaca).toBeDefined();
    expect(alpaca?.displayName).toBe('Alpaca');
    expect(alpaca?.shortDescription).toBe('Stop watching the markets.');
    expect(alpaca?.enabled).toBe(true);
    expect(alpaca?.iconUrl).toBe('/catalog/plugins/alpaca%40openai-curated/icon');

    const ghosted = plugins.find((plugin) => plugin.qualifiedSlug === 'ghosted@openai-curated');
    expect(ghosted).toBeDefined();
    expect(ghosted?.enabled).toBe(false);
    expect(ghosted?.displayName).toBe('ghosted');
    expect(ghosted?.iconUrl).toBeUndefined();
  });
});

describe('readSkills', () => {
  it('parses SKILL.md frontmatter for each entry', () => {
    const codexHome = createCodexHome();
    writeFile(
      path.join(codexHome, 'memories', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo description\nargument-hint: "[goal]"\n---\nbody'
    );
    const skills = readSkills(codexHome);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('demo-skill');
    expect(skills[0].description).toBe('Demo description');
    expect(skills[0].argumentHint).toBe('[goal]');
  });
});

describe('readModels', () => {
  it('reads list-visibility models and supported reasoning levels', () => {
    const codexHome = createCodexHome();
    writeFile(
      path.join(codexHome, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.5',
            display_name: 'GPT-5.5',
            description: 'Frontier model',
            default_reasoning_level: 'medium',
            visibility: 'list',
            priority: 0,
            supported_reasoning_levels: [
              { effort: 'low', description: 'Low' },
              { effort: 'high', description: 'High' }
            ]
          },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' }
        ]
      })
    );
    const models = readModels(codexHome);
    expect(models).toHaveLength(1);
    expect(models[0].slug).toBe('gpt-5.5');
    expect(models[0].supportedReasoningLevels).toEqual([
      { effort: 'low', description: 'Low' },
      { effort: 'high', description: 'High' }
    ]);
  });
});

describe('CatalogReader', () => {
  it('caches results between calls and exposes the icon path', async () => {
    const codexHome = createCodexHome();
    const versionDir = path.join(
      codexHome,
      'plugins',
      'cache',
      'openai-curated',
      'alpaca',
      'b066e4a0'
    );
    writeFile(
      path.join(versionDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'alpaca',
        interface: {
          displayName: 'Alpaca',
          composerIcon: './assets/app-icon.png'
        }
      })
    );
    writeFile(path.join(versionDir, 'assets', 'app-icon.png'), 'PNG');
    writeFile(
      path.join(codexHome, 'config.toml'),
      `[plugins."alpaca@openai-curated"]\nenabled = true\n`
    );
    const reader = new CatalogReader({ codexHome });
    try {
      const first = await reader.listPlugins();
      const second = await reader.listPlugins();
      expect(first).toBe(second);
      expect(reader.resolvePluginIconPath('alpaca@openai-curated')).toBe(
        path.join(versionDir, 'assets', 'app-icon.png')
      );
      expect(reader.resolvePluginIconPath('does-not-exist@somewhere')).toBeUndefined();
    } finally {
      reader.dispose();
    }
  });
});
