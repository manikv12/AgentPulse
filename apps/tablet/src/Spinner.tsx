import { Loader2 } from 'lucide-react';

type Props = {
  size?: number;
  className?: string;
  label?: string;
};

export function Spinner({ size = 16, className = '', label }: Props) {
  return (
    <span
      className={`codex-spinner ${className}`.trim()}
      role="status"
      aria-label={label ?? 'Loading'}
    >
      <Loader2 size={size} aria-hidden="true" />
    </span>
  );
}
