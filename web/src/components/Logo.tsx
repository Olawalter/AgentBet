export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <path d="M5 16 H14" stroke="#FF6B1A" strokeWidth="2.4" strokeLinecap="square" />
      <path d="M16.5 14.5 L27 7" stroke="#3FBF7F" strokeWidth="2.4" strokeLinecap="square" />
      <path d="M16.5 17.5 L27 25" stroke="#E0503F" strokeWidth="2.4" strokeLinecap="square" />
      <rect x="12.5" y="12.5" width="7" height="7" fill="#FF6B1A" />
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark size={size} />
      <span className="font-display font-semibold tracking-tight text-bone">
        Agent<span className="text-amber">Bet</span>
      </span>
    </span>
  );
}
