import { useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Coins, Gem } from "lucide-react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/queries";
import { putCapSegment } from "@/hooks/usePreferencesSync";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences";

type Option = {
  segment: "bigcap" | "smallcap";
  label: string;
  hint: string;
  detail: string;
  icon: typeof Coins;
};

const OPTIONS: Option[] = [
  {
    segment: "bigcap",
    label: "Big caps",
    hint: "BTC / ETH / majors",
    detail: "Steadier moves — allows larger size, higher leverage.",
    icon: Coins,
  },
  {
    segment: "smallcap",
    label: "Small caps",
    hint: "Higher volatility",
    detail: "The app enforces tighter risk defaults and lower leverage.",
    icon: Gem,
  },
];

/**
 * First-run prompt: pick a trading focus once so risk defaults (max risk %,
 * minimum reward/risk, leverage) start sane for the assets the user actually
 * trades. Not dismissible except via "decide later", which re-prompts next
 * session (it stores nothing — local state only, reset on reload). Mounted
 * once in the root layout; renders nothing until a signed-in user with no
 * cap-segment choice is confirmed, and never on /login.
 */
export function CapSegmentModal() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { data: user } = useCurrentUser();
  const capSegment = usePreferencesStore((s) => s.capSegment);
  const setCapSegment = usePreferencesStore((s) => s.setCapSegment);
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  const open =
    Boolean(user) && pathname !== "/login" && capSegment === null && !dismissedThisSession;

  const choose = (segment: "bigcap" | "smallcap") => {
    setCapSegment(segment);
    putCapSegment(segment);
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="[&>button]:hidden sm:max-w-md"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>What do you mainly trade?</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 text-sm text-muted-foreground">
          This sets sane starting risk defaults — you can hand-tune them anytime in Settings.
        </p>

        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {OPTIONS.map((option) => (
            <button
              key={option.segment}
              onClick={() => choose(option.segment)}
              className={cn(
                "flex flex-col items-start gap-2 rounded-xl border border-border bg-surface p-4 text-left transition-colors",
                "hover:border-info hover:bg-info-soft",
              )}
            >
              <option.icon className="h-5 w-5 text-info" />
              <div>
                <div className="text-sm font-semibold text-foreground">{option.label}</div>
                <div className="text-xs text-muted-foreground">{option.hint}</div>
              </div>
              <p className="text-xs leading-snug text-muted-foreground">{option.detail}</p>
            </button>
          ))}
        </div>

        <button
          onClick={() => setDismissedThisSession(true)}
          className="mt-1 self-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Decide later
        </button>
      </DialogContent>
    </Dialog>
  );
}
