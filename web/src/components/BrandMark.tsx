import { useState } from 'react';

/**
 * The HCML logo, on the white plate its own artwork requires.
 *
 * The ink measures #2B5584. That is 7.68:1 on white and 2.02:1 on the sidebar's
 * chrome, so laying the file straight onto the chrome would make it unreadable.
 * The plate is not styling, it is the only thing that makes the logo legible
 * there, and it disappears on a white surface, so one treatment covers every
 * placement. DESIGN.md section 8.
 *
 * Two variants, because the supplied artwork is a stacked lockup and does not
 * survive being shrunk. "Husky-CNOOC" and "Madura Limited" are a third and a
 * sixth the height of "HCML", so in a 40px rail they render at 4px and turn to
 * grey texture. The rail gets the HCML band alone, cropped from the same file.
 *
 * Falls back to the monogram when the image will not load, which is the state
 * of any deploy that drops the asset. A broken-image glyph in the chrome of a
 * wall display is worse than a monogram nobody looks at twice.
 */
export default function BrandMark({
  variant = 'lockup',
  alt = '',
}: {
  /** `lockup` is the full three-line logo; `mark` is the HCML band only. */
  variant?: 'lockup' | 'mark';
  /**
   * Empty wherever the name is already written beside the logo, so a screen
   * reader does not say "HCML" twice. The rail hides that text, so it passes a
   * real name instead.
   */
  alt?: string;
}) {
  const [missing, setMissing] = useState(false);

  return (
    <div className={`brand-mark brand-mark-${variant}`}>
      {missing ? (
        <span className="brand-mark-fallback" aria-hidden={alt ? undefined : true}>
          HC
        </span>
      ) : (
        <img
          src={variant === 'mark' ? '/logo-mark.png' : '/logo.png'}
          alt={alt}
          onError={() => setMissing(true)}
        />
      )}
    </div>
  );
}
