import { cn } from "@/lib/utils";
import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef } from "react";

interface CardProps extends HTMLMotionProps<"div"> {
  interactive?: boolean;
  padded?: boolean;
}

export const IqCard = forwardRef<HTMLDivElement, CardProps>(function IqCard(
  { className, interactive, padded = true, children, ...props },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      whileHover={interactive ? { y: -1 } : undefined}
      className={cn(
        "rounded-xl border border-border bg-card text-card-foreground",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset,0_1px_2px_0_rgba(0,0,0,0.35)]",
        interactive && "transition-shadow hover:shadow-lg",
        padded && "p-4 sm:p-5",
        className,
      )}
      {...props}
    >
      {children}
    </motion.div>
  );
});

export function CardEyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("eyebrow", className)}>{children}</div>;
}
