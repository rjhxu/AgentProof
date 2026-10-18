import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5l3 3 7-7" />
    </Icon>
  );
}

export function CrossIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8h10M9 4l4 4-4 4" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 6.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7M3 13.5h10" />
    </Icon>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
      <path d="M4.5 5.5v5M11.5 7.5c0 2-2.5 2.2-4.5 2.5s-2.5 1-2.5 2" />
    </Icon>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3H3.5a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V9M9.5 3H13v3.5M13 3L7.5 8.5" />
    </Icon>
  );
}

/** Reads the page as text. */
export function TextLinesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5h10M3 8h7M3 11.5h8.5" />
    </Icon>
  );
}

/** Looks at screenshots. */
export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
    </Icon>
  );
}

/** The strongest model. */
export function SparkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.5l1.6 4.4L14 7.5l-4.4 1.6L8 13.5 6.4 9.1 2 7.5l4.4-1.6z" />
    </Icon>
  );
}

/** Reads the catalog feed and the cart API. */
export function BracesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 2.5c-1.5 0-2 .7-2 2v2c0 .8-.5 1.5-1.5 1.5C3.5 8 4 8.7 4 9.5v2c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v2c0 .8.5 1.5 1.5 1.5-1 0-1.5.7-1.5 1.5v2c0 1.3-.5 2-2 2" />
    </Icon>
  );
}

export function SpinnerIcon({ className, ...props }: IconProps) {
  return (
    <Icon {...props} className={['animate-spin', className].filter(Boolean).join(' ')}>
      <path d="M8 2.5a5.5 5.5 0 1 1-5.5 5.5" />
    </Icon>
  );
}
