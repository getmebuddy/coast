import CountUp from "./CountUp";

/** HeroNumber — the one number per screen. */
export default function HeroNumber({
  cents,
  label,
  sub,
}: {
  cents: number;
  label: string;
  sub?: string;
}) {
  return (
    <div className="text-left">
      <p className="text-[var(--type-micro-size)] uppercase tracking-[0.14em] text-[var(--text-micro)]">
        {label}
      </p>
      <CountUp
        cents={cents}
        className="text-hero font-bold text-[var(--text-hero-number)] leading-none mt-1 block"
      />
      {sub && (
        <p className="mt-2 text-[var(--type-caption-size)] text-[var(--text-secondary)]">{sub}</p>
      )}
    </div>
  );
}
