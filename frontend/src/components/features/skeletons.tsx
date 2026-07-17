import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function SkeletonCard({ className, height = 140 }: { className?: string; height?: number }) {
  return (
    <div
      className={cn("rounded-xl border border-border bg-card p-4 sm:p-5", className)}
      style={{ height }}
    >
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-4 h-8 w-32" />
      <Skeleton className="mt-6 h-2 w-full" />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 py-2">
      <Skeleton className="h-8 w-8 rounded-full" />
      <Skeleton className="h-4 flex-1" />
      <Skeleton className="h-4 w-16" />
    </div>
  );
}
