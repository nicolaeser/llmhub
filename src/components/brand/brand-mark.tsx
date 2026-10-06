const SIZES = {
  sm: { box: "size-8", glyph: "size-5" },
  md: { box: "size-9", glyph: "size-6" },
} as const;

export default function BrandMark({
  size = "sm",
}: {
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground ${s.box}`}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className={s.glyph} fill="currentColor" aria-hidden>
        <path
          d="M12 5.5v7.25l6.28 3.63M12 12.75l-6.28 3.63"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="12.75" r="3.25" />
        <circle cx="12" cy="5.5" r="2.25" />
        <circle cx="18.28" cy="16.38" r="2.25" />
        <circle cx="5.72" cy="16.38" r="2.25" />
      </svg>
    </span>
  );
}
