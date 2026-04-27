import type { CatalogCommand, CatalogPlugin, CatalogSkill } from '@agent-pulse/shared';
import { File, Sparkles, Slash, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

export type MentionTrigger = '@' | '/';

export type MentionItem =
  | {
      kind: 'plugin';
      id: string;
      label: string;
      description?: string;
      iconUrl?: string;
      insertText: string;
    }
  | {
      kind: 'skill';
      id: string;
      label: string;
      description?: string;
      iconUrl?: string;
      insertText: string;
    }
  | {
      kind: 'file';
      id: string;
      label: string;
      description?: string;
      insertText: string;
    }
  | {
      kind: 'command';
      id: string;
      label: string;
      description?: string;
      insertText: string;
    };

export type MentionPickerProps = {
  trigger: MentionTrigger;
  query: string;
  plugins?: CatalogPlugin[];
  skills?: CatalogSkill[];
  commands?: CatalogCommand[];
  files?: { path: string; relativePath: string }[];
  filesLoading?: boolean;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
};

const MAX_RESULTS = 30;

export function MentionPicker({
  trigger,
  query,
  plugins = [],
  skills = [],
  commands = [],
  files = [],
  filesLoading = false,
  onSelect,
  onClose
}: MentionPickerProps) {
  const items = useMemo(() => buildItems(trigger, query, { plugins, skills, commands, files }), [
    trigger,
    query,
    plugins,
    skills,
    commands,
    files
  ]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (items.length > 0 ? (current + 1) % items.length : 0));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (items.length > 0 ? (current - 1 + items.length) % items.length : 0));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (items[activeIndex]) {
          event.preventDefault();
          onSelect(items[activeIndex]);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [activeIndex, items, onClose, onSelect]);

  if (items.length === 0 && !filesLoading) {
    return (
      <div className="codex-mention-picker is-empty" role="listbox">
        <p className="codex-mention-empty">
          {trigger === '/' ? 'No matching commands.' : 'No matches yet — keep typing.'}
        </p>
      </div>
    );
  }

  return (
    <div className="codex-mention-picker" role="listbox">
      {filesLoading ? <p className="codex-mention-loading">Searching files…</p> : null}
      <ul className="codex-mention-list">
        {items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={`codex-mention-row ${index === activeIndex ? 'is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(item)}
              role="option"
              aria-selected={index === activeIndex}
            >
              <span className="codex-mention-icon" aria-hidden="true">
                {renderIcon(item)}
              </span>
              <span className="codex-mention-text">
                <span className="codex-mention-label">{item.label}</span>
                {item.description ? (
                  <span className="codex-mention-description">{item.description}</span>
                ) : null}
              </span>
              <span className="codex-mention-tag">{kindLabel(item.kind)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderIcon(item: MentionItem): ReactElement {
  if (item.kind === 'plugin') {
    if (item.iconUrl) {
      return <img className="codex-mention-plugin-icon" src={item.iconUrl} alt="" />;
    }
    return <Workflow size={16} />;
  }
  if (item.kind === 'skill') {
    if (item.iconUrl) {
      return <img className="codex-mention-plugin-icon" src={item.iconUrl} alt="" />;
    }
    return <Sparkles size={16} />;
  }
  if (item.kind === 'command') {
    return <Slash size={16} />;
  }
  return <File size={16} />;
}

function kindLabel(kind: MentionItem['kind']): string {
  if (kind === 'plugin') return 'Plugin';
  if (kind === 'skill') return 'Skill';
  if (kind === 'command') return 'Command';
  return 'File';
}

function buildItems(
  trigger: MentionTrigger,
  query: string,
  catalog: {
    plugins: CatalogPlugin[];
    skills: CatalogSkill[];
    commands: CatalogCommand[];
    files: { path: string; relativePath: string }[];
  }
): MentionItem[] {
  const lowered = query.toLowerCase();

  if (trigger === '/') {
    return catalog.commands
      .filter((command) => match(command.name, lowered) || match(command.description ?? '', lowered))
      .slice(0, MAX_RESULTS)
      .map((command) => ({
        kind: 'command' as const,
        id: `command:${command.slug}`,
        label: `/${command.name}`,
        description: command.description,
        insertText: `/${command.name} `
      }));
  }

  const items: MentionItem[] = [];
  for (const plugin of catalog.plugins) {
    if (!plugin.enabled) {
      continue;
    }
    if (!match(plugin.displayName, lowered) && !match(plugin.shortDescription ?? '', lowered) && !match(plugin.slug, lowered)) {
      continue;
    }
    items.push({
      kind: 'plugin',
      id: `plugin:${plugin.qualifiedSlug}`,
      label: plugin.displayName,
      description: plugin.shortDescription,
      iconUrl: plugin.iconUrl,
      insertText: `@${plugin.slug} `
    });
  }
  for (const skill of catalog.skills) {
    if (!match(skill.name, lowered) && !match(skill.description ?? '', lowered)) {
      continue;
    }
    items.push({
      kind: 'skill',
      id: `skill:${skill.slug}`,
      label: skill.name,
      description: skill.description,
      iconUrl: skill.iconUrl,
      insertText: `@${skill.slug} `
    });
  }
  for (const file of catalog.files) {
    items.push({
      kind: 'file',
      id: `file:${file.relativePath}`,
      label: file.relativePath,
      description: undefined,
      insertText: `@${file.relativePath} `
    });
  }
  return items.slice(0, MAX_RESULTS);
}

function match(value: string, query: string): boolean {
  if (!query) {
    return true;
  }
  return value.toLowerCase().includes(query);
}
