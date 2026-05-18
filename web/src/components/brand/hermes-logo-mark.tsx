import { useId } from "react";

interface HermesLogoMarkProps {
  size?: number;
  className?: string;
  title?: string;
}

export function HermesLogoMark({ size = 22, className, title }: HermesLogoMarkProps) {
  const clipId = `hermes-logo-${useId().replace(/:/g, "")}`;

  return (
    <svg
      viewBox="0 0 80 80"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect width="80" height="80" rx="18" />
        </clipPath>
      </defs>
      <rect width="80" height="80" rx="18" fill="#f6f1e3" />
      <g clipPath={`url(#${clipId})`}>
        <g transform="translate(-2,2)">
          <polygon points="58,22 58,58 62,54 62,18" fill="#3a3633" />
          <polygon points="50,22 58,22 62,18 54,18" fill="#2a2620" />
          <polygon points="30,36 50,36 54,32 34,32" fill="#c95722" />
          <polygon points="30,22 30,36 34,32 34,18" fill="#3a3633" />
          <polygon points="30,44 30,58 34,54 34,40" fill="#3a3633" />
          <polygon points="22,22 30,22 34,18 26,18" fill="#2a2620" />
          <path d="M22,22 H30 V36 H50 V22 H58 V58 H50 V44 H30 V58 H22 Z" fill="#0a0908" />
          <rect x="30" y="36" width="20" height="8" fill="#ff7a3d" />
        </g>
      </g>
    </svg>
  );
}
