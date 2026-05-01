type AppMarkProps = {
  size?: 'sm' | 'md' | 'lg';
};

export function AppMark({ size = 'md' }: AppMarkProps) {
  return (
    <span className={`codex-mark codex-mark-${size}`} aria-hidden="true">
      <img alt="" src="/icon.svg" />
    </span>
  );
}