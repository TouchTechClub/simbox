import type { RepoState, RunState } from "@simbox/shared/types";
import type { ReactNode } from "react";

import { Badge, type badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

/** Small colored dot used inside status badges. */
function Dot({ className, pulse = false }: { className?: string; pulse?: boolean }) {
  return (
    <span className={cn("size-1.5 rounded-full bg-current", pulse && "animate-pulse", className)} />
  );
}

function StatusBadge({
  variant,
  pulse,
  children,
}: {
  variant: BadgeVariant;
  pulse?: boolean;
  children: ReactNode;
}) {
  return (
    <Badge variant={variant} className="font-mono lowercase">
      <Dot pulse={pulse} />
      {children}
    </Badge>
  );
}

export function RunStateBadge({ state }: { state: RunState }) {
  switch (state) {
    case "live":
      return <StatusBadge variant="success">live</StatusBadge>;
    case "dispatching":
    case "queued":
    case "booting":
      return (
        <StatusBadge variant="warning" pulse>
          {state}
        </StatusBadge>
      );
    case "closing":
      return <StatusBadge variant="secondary">closing</StatusBadge>;
    case "failed":
      return <StatusBadge variant="destructive">failed</StatusBadge>;
    case "ended":
      return <StatusBadge variant="muted">ended</StatusBadge>;
  }
}

export function RepoStateBadge({ state }: { state: RepoState }) {
  switch (state) {
    case "ok":
      return <StatusBadge variant="success">connected</StatusBadge>;
    case "pending_pr":
      return (
        <StatusBadge variant="warning" pulse>
          pending pr
        </StatusBadge>
      );
    case "needs_repair":
      return <StatusBadge variant="destructive">needs repair</StatusBadge>;
    case "uninstalled":
      return <StatusBadge variant="destructive">uninstalled</StatusBadge>;
  }
}
