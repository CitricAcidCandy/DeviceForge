export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="empty-state my-2 min-w-0 px-0 py-6 text-left wrap-anywhere">
      <h3 className="m-0 mb-2 text-[15px] font-semibold">{title}</h3>
      {description && <p className="m-0 max-w-[490px] text-[14px] text-muted-foreground">{description}</p>}
    </div>
  );
}
