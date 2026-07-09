type WaveformIconProps = {
  class?: string;
  title?: string;
};

export function WaveformIcon(props: WaveformIconProps) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 64 64"
      role={props.title ? "img" : undefined}
      aria-hidden={props.title ? undefined : "true"}
      aria-label={props.title}
    >
      <g fill="currentColor">
        <rect x="2" y="25" width="6" height="14" rx="3" />
        <rect x="11" y="17" width="6" height="30" rx="3" />
        <rect x="20" y="7" width="6" height="50" rx="3" />
        <rect x="29" y="3" width="6" height="58" rx="3" />
        <rect x="38" y="12" width="6" height="40" rx="3" />
        <rect x="47" y="19" width="6" height="26" rx="3" />
        <rect x="56" y="26" width="6" height="12" rx="3" />
      </g>
    </svg>
  );
}
