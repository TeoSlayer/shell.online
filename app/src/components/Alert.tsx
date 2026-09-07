import { WarningCircle, CheckCircle } from "@phosphor-icons/react";

export function Alert({
  tone,
  children,
}: {
  tone: "error" | "success";
  children: React.ReactNode;
}) {
  const Icon = tone === "error" ? WarningCircle : CheckCircle;
  return (
    <div
      className={`alert alert-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon size={16} weight="bold" />
      <span>{children}</span>
    </div>
  );
}
