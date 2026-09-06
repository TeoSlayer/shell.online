export function Booting({ label }: { label: string }) {
  return (
    <div className="booting">
      <span className="spinner" style={{ color: "var(--muted)" }} aria-hidden="true" />
      <p role="status">{label}</p>
    </div>
  );
}
