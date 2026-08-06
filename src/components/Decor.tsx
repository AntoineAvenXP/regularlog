// Éléments décoratifs de marque Regularlog : courbes topographiques, trame de
// points, motif en éventail. SVG inline, sans dépendance ni requête réseau.

export function ContourLines({
  className,
  style,
  color = "#7b8888",
  opacity = 0.35,
}: {
  className?: string;
  style?: React.CSSProperties;
  color?: string;
  opacity?: number;
}) {
  // Lignes de niveau douces (style topographique).
  const paths = [
    "M-20 40 C 60 10, 140 70, 240 30 S 420 70, 520 35",
    "M-20 70 C 60 40, 140 100, 240 60 S 420 100, 520 65",
    "M-20 100 C 60 70, 140 130, 240 90 S 420 130, 520 95",
    "M-20 130 C 60 100, 140 160, 240 120 S 420 160, 520 125",
    "M-20 160 C 60 130, 140 190, 240 150 S 420 190, 520 155",
    "M-20 190 C 60 160, 140 220, 240 180 S 420 220, 520 185",
  ];
  return (
    <svg className={className} style={style} viewBox="0 0 500 230" fill="none" aria-hidden="true">
      <g stroke={color} strokeWidth="1.2" opacity={opacity}>
        {paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
    </svg>
  );
}

export function DotGrid({
  className,
  style,
  color = "#b9c0bf",
  cols = 6,
  rows = 5,
  gap = 16,
  r = 2,
}: {
  className?: string;
  style?: React.CSSProperties;
  color?: string;
  cols?: number;
  rows?: number;
  gap?: number;
  r?: number;
}) {
  const dots = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++)
      dots.push(<circle key={`${x}-${y}`} cx={x * gap + r} cy={y * gap + r} r={r} />);
  return (
    <svg
      className={className}
      style={style}
      width={(cols - 1) * gap + 2 * r}
      height={(rows - 1) * gap + 2 * r}
      fill={color}
      aria-hidden="true"
    >
      {dots}
    </svg>
  );
}

export function Fan({
  className,
  style,
  size = 220,
}: {
  className?: string;
  style?: React.CSSProperties;
  size?: number;
}) {
  // Demi-disque « coquille » : dégradé + fines nervures radiales.
  const lines = Array.from({ length: 46 }, (_, i) => {
    const a = (Math.PI * i) / 45; // 0..π
    return { x2: 100 - 100 * Math.cos(a), y2: 100 - 100 * Math.sin(a) };
  });
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size / 2}
      viewBox="0 0 200 100"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="rl-fan" x1="0" y1="1" x2="0.2" y2="0">
          <stop offset="0" stopColor="#0c2328" />
          <stop offset="1" stopColor="#90c57a" />
        </linearGradient>
      </defs>
      <path d="M0 100 A100 100 0 0 1 200 100 Z" fill="url(#rl-fan)" />
      <g stroke="#fbfbfb" strokeWidth="0.6" opacity="0.35">
        {lines.map((l, i) => (
          <line key={i} x1="100" y1="100" x2={l.x2} y2={l.y2} />
        ))}
      </g>
    </svg>
  );
}
