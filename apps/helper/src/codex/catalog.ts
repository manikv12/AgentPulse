import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CatalogCommandSchema,
  CatalogModelSchema,
  CatalogPluginSchema,
  CatalogSkillSchema,
  type CatalogCommand,
  type CatalogModel,
  type CatalogPlugin,
  type CatalogSkill
} from '@agent-pulse/shared';

const execFileAsync = promisify(execFile);

export type CatalogReaderOptions = {
  codexHome?: string;
};

export type CatalogChangeKind = 'plugins' | 'skills' | 'commands' | 'models';

export type CatalogChangeListener = (kind: CatalogChangeKind) => void;

const BUILT_IN_COMMANDS: CatalogCommand[] = [
  { slug: 'compact', name: 'compact', description: 'Compact the conversation to free up context.', builtIn: true },
  { slug: 'new', name: 'new', description: 'Start a new thread in this workspace.', builtIn: true },
  { slug: 'model', name: 'model', description: 'Switch the model and reasoning effort.', builtIn: true },
  { slug: 'feedback', name: 'feedback', description: 'Send feedback to the Codex team.', builtIn: true },
  { slug: 'clear', name: 'clear', description: 'Clear the conversation transcript.', builtIn: true },
  { slug: 'help', name: 'help', description: 'Show the in-app help.', builtIn: true },
  { slug: 'review', name: 'review', description: 'Run a code review on the current branch.', builtIn: true }
].map((command) => CatalogCommandSchema.parse(command));

export class CatalogReader {
  private readonly codexHome: string;
  private readonly watchers: FSWatcher[] = [];
  private readonly listeners = new Set<CatalogChangeListener>();
  private pluginsCache?: CatalogPlugin[];
  private skillsCache?: CatalogSkill[];
  private modelsCache?: CatalogModel[];
  private disposed = false;

  constructor(options: CatalogReaderOptions = {}) {
    this.codexHome = options.codexHome ?? path.join(homedir(), '.codex');
  }

  start(): void {
    this.tryWatch(path.join(this.codexHome, 'config.toml'), () => this.invalidate('plugins'));
    this.tryWatch(path.join(this.codexHome, 'plugins', 'cache'), () => this.invalidate('plugins'));
    this.tryWatch(path.join(this.codexHome, 'memories', 'skills'), () => this.invalidate('skills'));
    this.tryWatch(path.join(this.codexHome, 'models_cache.json'), () => this.invalidate('models'));
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    this.watchers.length = 0;
    this.listeners.clear();
  }

  onChange(listener: CatalogChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listPlugins(): Promise<CatalogPlugin[]> {
    if (this.pluginsCache) {
      return this.pluginsCache;
    }
    const plugins = readPlugins(this.codexHome);
    this.pluginsCache = plugins;
    return plugins;
  }

  async listSkills(): Promise<CatalogSkill[]> {
    if (this.skillsCache) {
      return this.skillsCache;
    }
    const skills = readSkills(this.codexHome);
    this.skillsCache = skills;
    return skills;
  }

  async listCommands(): Promise<CatalogCommand[]> {
    return BUILT_IN_COMMANDS;
  }

  async listModels(): Promise<CatalogModel[]> {
    if (this.modelsCache) {
      return this.modelsCache;
    }
    const models = readModels(this.codexHome);
    this.modelsCache = models;
    return models;
  }

  resolvePluginIconPath(qualifiedSlug: string): string | undefined {
    return resolveIconPath(this.codexHome, qualifiedSlug);
  }

  resolveSkillIconPath(slug: string): string | undefined {
    return resolveSkillIconPath(this.codexHome, slug);
  }

  async listProjectFiles(
    projectPath: string,
    query: string,
    limit = 50
  ): Promise<{ files: { path: string; relativePath: string }[]; truncated: boolean }> {
    if (!path.isAbsolute(projectPath)) {
      throw new Error('Project path must be absolute');
    }
    const trimmed = query.trim();
    const args = ['--files', '--hidden', '--glob', '!.git/**'];
    let stdout = '';
    try {
      const result = await execFileAsync('rg', args, {
        cwd: projectPath,
        maxBuffer: 16 * 1024 * 1024
      });
      stdout = result.stdout;
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        return { files: [], truncated: false };
      }
      throw error;
    }
    const lines = stdout.split('\n').filter((line) => line.length > 0);
    const matched = trimmed
      ? lines.filter((line) => line.toLowerCase().includes(trimmed.toLowerCase()))
      : lines;
    const truncated = matched.length > limit;
    return {
      files: matched.slice(0, limit).map((relativePath) => ({
        relativePath,
        path: path.join(projectPath, relativePath)
      })),
      truncated
    };
  }

  private invalidate(kind: CatalogChangeKind): void {
    if (kind === 'plugins') {
      this.pluginsCache = undefined;
    }
    if (kind === 'skills') {
      this.skillsCache = undefined;
    }
    if (kind === 'models') {
      this.modelsCache = undefined;
    }
    for (const listener of this.listeners) {
      try {
        listener(kind);
      } catch {
        // ignore listener failures
      }
    }
  }

  private tryWatch(target: string, onChange: () => void): void {
    if (this.disposed || !existsSync(target)) {
      return;
    }
    try {
      const stats = statSync(target);
      const watcher = watch(target, { recursive: stats.isDirectory() }, () => {
        onChange();
      });
      watcher.on('error', () => {
        // ignore watcher errors; readers will fall back to fresh disk reads
      });
      this.watchers.push(watcher);
    } catch {
      // platform may not support recursive watch; ignore
    }
  }
}

export function readPlugins(codexHome: string): CatalogPlugin[] {
  const configPath = path.join(codexHome, 'config.toml');
  const configBlocks = parsePluginConfigBlocks(safeReadFile(configPath));
  const cacheRoot = path.join(codexHome, 'plugins', 'cache');
  const manifests = readAllPluginManifests(cacheRoot);

  const merged = new Map<string, CatalogPlugin>();

  for (const manifest of manifests) {
    const qualified = `${manifest.slug}@${manifest.marketplace}`;
    const enabled = configBlocks.get(qualified)?.enabled ?? false;
    const candidate: CatalogPlugin = {
      slug: manifest.slug,
      marketplace: manifest.marketplace,
      qualifiedSlug: qualified,
      displayName: manifest.displayName ?? manifest.slug,
      shortDescription: manifest.shortDescription,
      longDescription: manifest.longDescription,
      category: manifest.category,
      developerName: manifest.developerName,
      websiteUrl: manifest.websiteUrl,
      enabled,
      iconUrl: manifest.iconRelative
        ? `/catalog/plugins/${encodeURIComponent(qualified)}/icon`
        : undefined,
      aliases: manifest.aliases
    };
    merged.set(qualified, CatalogPluginSchema.parse(candidate));
  }

  for (const [qualified, block] of configBlocks) {
    if (merged.has(qualified)) {
      continue;
    }
    const [slug, marketplace] = splitQualifiedSlug(qualified);
    if (!slug || !marketplace) {
      continue;
    }
    merged.set(
      qualified,
      CatalogPluginSchema.parse({
        slug,
        marketplace,
        qualifiedSlug: qualified,
        displayName: slug,
        enabled: block.enabled
      })
    );
  }

  return [...merged.values()].sort((a, b) => {
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

export function readSkills(codexHome: string): CatalogSkill[] {
  const skillsRoot = path.join(codexHome, 'memories', 'skills');
  if (!existsSync(skillsRoot)) {
    return [];
  }
  const entries = safeReaddir(skillsRoot);
  const skills: CatalogSkill[] = [];

  for (const entry of entries) {
    const skillDir = path.join(skillsRoot, entry);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) {
      continue;
    }
    const frontmatter = parseFrontmatter(safeReadFile(skillFile));
    const iconRelative = pickSkillIconRelative(skillDir, frontmatter.get('icon'));
    skills.push(
      CatalogSkillSchema.parse({
        slug: entry,
        name: frontmatter.get('name') ?? entry,
        description: frontmatter.get('description'),
        argumentHint: frontmatter.get('argument-hint'),
        source: 'user',
        scopePath: skillDir,
        iconUrl: iconRelative
          ? `/catalog/skills/${encodeURIComponent(entry)}/icon`
          : undefined
      })
    );
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const SKILL_ICON_CANDIDATES = ['icon.png', 'icon.svg', 'icon.jpg', 'icon.jpeg', 'icon.webp'];

function pickSkillIconRelative(skillDir: string, frontmatterIcon?: string): string | undefined {
  if (frontmatterIcon) {
    const resolved = path.resolve(skillDir, frontmatterIcon);
    if (isInside(skillDir, resolved) && existsSync(resolved)) {
      return frontmatterIcon;
    }
  }
  for (const candidate of SKILL_ICON_CANDIDATES) {
    if (existsSync(path.join(skillDir, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

function resolveSkillIconPath(codexHome: string, slug: string): string | undefined {
  const skillDir = path.join(codexHome, 'memories', 'skills', slug);
  if (!existsSync(skillDir)) {
    return undefined;
  }
  const skillFile = path.join(skillDir, 'SKILL.md');
  const frontmatter = existsSync(skillFile)
    ? parseFrontmatter(safeReadFile(skillFile))
    : new Map<string, string>();
  const relative = pickSkillIconRelative(skillDir, frontmatter.get('icon'));
  if (!relative) {
    return undefined;
  }
  const absolute = path.resolve(skillDir, relative);
  return isInside(skillDir, absolute) ? absolute : undefined;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function readModels(codexHome: string): CatalogModel[] {
  const modelsPath = path.join(codexHome, 'models_cache.json');
  const text = safeReadFile(modelsPath);
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as { models?: unknown };
    if (!parsed || !Array.isArray(parsed.models)) {
      return [];
    }
    const models: CatalogModel[] = [];
    for (const raw of parsed.models) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const record = raw as Record<string, unknown>;
      const slug = stringField(record, 'slug');
      const displayName = stringField(record, 'display_name') ?? slug;
      if (!slug || !displayName) {
        continue;
      }
      const supported: { effort: string; description?: string }[] | undefined = Array.isArray(
        record.supported_reasoning_levels
      )
        ? (record.supported_reasoning_levels as unknown[]).flatMap((entry) => {
            if (!entry || typeof entry !== 'object') {
              return [];
            }
            const level = entry as Record<string, unknown>;
            const effort = stringField(level, 'effort');
            if (!effort) {
              return [];
            }
            const description = stringField(level, 'description');
            return [description ? { effort, description } : { effort }];
          })
        : undefined;

      const visibility = stringField(record, 'visibility');
      if (visibility && visibility !== 'list') {
        continue;
      }

      models.push(
        CatalogModelSchema.parse({
          slug,
          displayName,
          description: stringField(record, 'description'),
          defaultReasoningLevel: stringField(record, 'default_reasoning_level'),
          supportedReasoningLevels: supported,
          visibility,
          priority: typeof record.priority === 'number' ? record.priority : undefined
        })
      );
    }
    return models.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  } catch {
    return [];
  }
}

type PluginManifest = {
  slug: string;
  marketplace: string;
  displayName?: string;
  shortDescription?: string;
  longDescription?: string;
  category?: string;
  developerName?: string;
  websiteUrl?: string;
  aliases?: string[];
  iconRelative?: string;
  iconAbsolute?: string;
};

function readAllPluginManifests(cacheRoot: string): PluginManifest[] {
  if (!existsSync(cacheRoot)) {
    return [];
  }
  const manifests: PluginManifest[] = [];
  const marketplaces = safeReaddir(cacheRoot).filter((entry) =>
    isDirectory(path.join(cacheRoot, entry))
  );

  for (const marketplace of marketplaces) {
    const marketplaceDir = path.join(cacheRoot, marketplace);
    const slugs = safeReaddir(marketplaceDir).filter((entry) =>
      isDirectory(path.join(marketplaceDir, entry))
    );
    for (const slug of slugs) {
      const slugDir = path.join(marketplaceDir, slug);
      const manifest = readPluginManifestFromSlugDir(slugDir, slug, marketplace);
      if (manifest) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
}

function readPluginManifestFromSlugDir(
  slugDir: string,
  slug: string,
  marketplace: string
): PluginManifest | undefined {
  const versionDirs = safeReaddir(slugDir).filter((entry) =>
    isDirectory(path.join(slugDir, entry))
  );
  if (versionDirs.length === 0) {
    return undefined;
  }
  const ordered = versionDirs.sort((a, b) => {
    const aTime = safeMtimeMs(path.join(slugDir, a));
    const bTime = safeMtimeMs(path.join(slugDir, b));
    return bTime - aTime;
  });
  for (const version of ordered) {
    const versionDir = path.join(slugDir, version);
    const manifestPath = path.join(versionDir, '.codex-plugin', 'plugin.json');
    if (!existsSync(manifestPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(safeReadFile(manifestPath)) as Record<string, unknown>;
      const interfaceRecord = (parsed.interface as Record<string, unknown> | undefined) ?? {};
      const author = (parsed.author as Record<string, unknown> | undefined) ?? {};
      const iconRelative =
        stringField(interfaceRecord, 'composerIcon') ?? stringField(interfaceRecord, 'logo');
      const iconAbsolute = iconRelative
        ? path.resolve(versionDir, iconRelative)
        : undefined;
      const aliases = Array.isArray(parsed.aliases)
        ? (parsed.aliases as unknown[]).filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0
          )
        : undefined;
      return {
        slug: stringField(parsed, 'name') ?? slug,
        marketplace,
        displayName: stringField(interfaceRecord, 'displayName'),
        shortDescription: stringField(interfaceRecord, 'shortDescription'),
        longDescription: stringField(interfaceRecord, 'longDescription'),
        category: stringField(interfaceRecord, 'category'),
        developerName:
          stringField(interfaceRecord, 'developerName') ?? stringField(author, 'name'),
        websiteUrl:
          stringField(interfaceRecord, 'websiteURL') ?? stringField(parsed, 'homepage'),
        aliases,
        iconRelative,
        iconAbsolute
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveIconPath(codexHome: string, qualifiedSlug: string): string | undefined {
  const [slug, marketplace] = splitQualifiedSlug(qualifiedSlug);
  if (!slug || !marketplace) {
    return undefined;
  }
  const slugDir = path.join(codexHome, 'plugins', 'cache', marketplace, slug);
  if (!existsSync(slugDir)) {
    return undefined;
  }
  const manifest = readPluginManifestFromSlugDir(slugDir, slug, marketplace);
  return manifest?.iconAbsolute;
}

function splitQualifiedSlug(qualified: string): [string?, string?] {
  const at = qualified.lastIndexOf('@');
  if (at <= 0 || at === qualified.length - 1) {
    return [undefined, undefined];
  }
  return [qualified.slice(0, at), qualified.slice(at + 1)];
}

export function parsePluginConfigBlocks(
  text: string
): Map<string, { enabled: boolean }> {
  const result = new Map<string, { enabled: boolean }>();
  if (!text) {
    return result;
  }
  const lines = text.split('\n');
  let currentSlug: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('[plugins.')) {
      const match = line.match(/^\[plugins\.(?:"([^"]+)"|'([^']+)'|([^\]\s]+))\]$/);
      currentSlug = match ? match[1] ?? match[2] ?? match[3] : undefined;
      if (currentSlug) {
        result.set(currentSlug, { enabled: false });
      }
      continue;
    }
    if (line.startsWith('[')) {
      currentSlug = undefined;
      continue;
    }
    if (!currentSlug || !line) {
      continue;
    }
    const enableMatch = line.match(/^enabled\s*=\s*(true|false)/);
    if (enableMatch) {
      result.set(currentSlug, { enabled: enableMatch[1] === 'true' });
    }
  }
  return result;
}

export function parseFrontmatter(text: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!text.startsWith('---\n')) {
    return result;
  }
  const end = text.indexOf('\n---', 4);
  if (end === -1) {
    return result;
  }
  const block = text.slice(4, end);
  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (value) {
      result.set(key, value);
    }
  }
  return result;
}

function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function safeMtimeMs(target: string): number {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
