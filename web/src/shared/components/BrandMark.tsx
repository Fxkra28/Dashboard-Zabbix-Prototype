import { useState } from 'react';

/**
 * The HCML logo, on the white plate its own artwork requires.
 *
 * The ink measures #2B5584: 7.68:1 on white but 2.02:1 on the sidebar's chrome, so laying the file
 * straight onto the chrome would make it unreadable. The plate is the only thing that makes the
 * logo legible there, and it disappears on a white surface, so one treatment covers every placement
 * (DESIGN.md section 8).
 *
 * Two variants, because the supplied artwork is a stacked lockup that does not survive being
 * shrunk: "Husky-CNOOC" and "Madura Limited" are a third and a sixth the height of "HCML", so in a
 * 40px rail they render at 4px and turn to grey texture. The rail gets the square H icon, the
 * favicon's crop of the same file (DESIGN.md section 9).
 *
 * Falls back to the monogram when the image will not load, as on any deploy that drops the asset: a
 * broken-image glyph in the chrome of a wall display is worse than a monogram nobody looks at
 * twice.
 */
export default function BrandMark({
  variant = 'lockup',
  alt = '',
}: {
  /** `lockup` is the full three-line logo; `icon` is the square H alone. */
  variant?: 'lockup' | 'icon';
  /**
   * Empty wherever the name is already written beside the logo, so a screen
   * reader does not say "HCML" twice. The rail hides that text, so it passes a
   * real name instead.
   */
  alt?: string;
}) {
  const src = variant === 'icon' ? '/logo-icon.png' : '/logo.png';
  // Per file: the rail toggles the variant in place, and the other file may
  // load; one that failed is not asked for again, which flashed an empty plate.
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const missing = failed.has(src);

  return (
    <div
      className={`brand-mark brand-mark-${variant}`}
      // The monogram is two letters of the name; the name itself goes to the screen reader.
      {...(missing && alt ? { role: 'img', 'aria-label': alt } : {})}
    >
      {missing ? (
        <span className="brand-mark-fallback" aria-hidden="true">
          HC
        </span>
      ) : (
        <img src={src} alt={alt} onError={() => setFailed((f) => new Set(f).add(src))} />
      )}
    </div>
  );
}
