import type { LucideIcon } from "lucide-react";

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="page-header">
      <h1 className="page">{title}</h1>
      {subtitle && <p className="sub">{subtitle}</p>}
    </div>
  );
}

export function SectionHeader({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="section-head">
      <span className="chip">
        <Icon />
      </span>
      <h2>{title}</h2>
    </div>
  );
}
