import { useState } from 'react';

type CodexMarkProps = {
  size?: 'sm' | 'md' | 'lg';
};

export function CodexMark({ size = 'md' }: CodexMarkProps) {
  const [errored, setErrored] = useState(false);

  return (
    <span className={`codex-mark codex-mark-${size}`} aria-hidden="true">
      {errored ? (
        <CodexFallbackGlyph />
      ) : (
        <img alt="" src="/assets/codex-icon.png" onError={() => setErrored(true)} />
      )}
    </span>
  );
}

function CodexFallbackGlyph() {
  return (
    <svg viewBox="0 0 64 64" role="presentation" focusable="false">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#0d0d0d" />
      <path
        d="M20 26 L14 32 L20 38"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M44 26 L50 32 L44 38"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M37 22 L27 42"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
