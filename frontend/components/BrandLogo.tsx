import Image from "next/image";

// Wordmark files are 328×132; height drives the rendered size.
const RATIO = 328 / 132;

/**
 * TotalDealer wordmark. Both variants are rendered and CSS picks one, so the
 * right logo is there on first paint — the theme class is set by an inline
 * script before hydration, which a `useState` read would miss.
 */
export function BrandLogo({ height = 32, className = "" }: { height?: number; className?: string }) {
  const width = Math.round(height * RATIO);
  const common = { width, height, unoptimized: true, style: { height, width: "auto" } } as const;
  return (
    <span className={`inline-flex shrink-0 ${className}`.trim()}>
      <Image src="/brand/td-logo.png" alt="TotalDealer" className="block dark:hidden" {...common} />
      <Image src="/brand/td-logo-white.png" alt="TotalDealer" className="hidden dark:block" {...common} />
    </span>
  );
}
