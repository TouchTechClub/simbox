import { useMutation } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { CheckCircle2, CircleAlert, Loader2, ShieldAlert, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { authClient } from "@/lib/auth-client";
import { rootRoute } from "./root";

type DeviceSearch = { user_code?: string };

type Phase = "claiming" | "confirm" | "done" | "denied" | "error";

function DevicePage() {
  const { user_code } = deviceRoute.useSearch();
  const [phase, setPhase] = useState<Phase>(user_code ? "claiming" : "error");
  const [error, setError] = useState<string | null>(null);
  const claimed = useRef(false);

  // Step 1: GET /device claims the pending code for this session — only this
  // session can then approve or deny it.
  const claim = useMutation({
    mutationFn: (code: string) => authClient.device({ query: { user_code: code } }),
    onSuccess: (res) => {
      if (res.error) {
        setError(res.error.error_description ?? res.error.error);
        setPhase("error");
      } else {
        setPhase("confirm");
      }
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Invalid or expired code");
      setPhase("error");
    },
  });

  const decide = useMutation({
    mutationFn: ({ code, approve }: { code: string; approve: boolean }) =>
      approve
        ? authClient.device.approve({ userCode: code })
        : authClient.device.deny({ userCode: code }),
    onSuccess: (res, v) => {
      if (res.error) {
        setError(res.error.error_description ?? res.error.error);
        setPhase("error");
      } else {
        setPhase(v.approve ? "done" : "denied");
      }
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : "Request failed");
      setPhase("error");
    },
  });

  // Auto-claim on mount when a code arrived via ?user_code= (StrictMode-safe).
  useEffect(() => {
    if (user_code && !claimed.current) {
      claimed.current = true;
      claim.mutate(user_code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user_code]);

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden p-6">
      <div className="bg-dot-grid pointer-events-none absolute inset-0 text-foreground/[0.06]" />
      <Card className="relative w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2 font-mono text-sm font-semibold">
            <TerminalSquare className="size-4 text-primary" />
            simbox
          </div>
          <CardTitle>Authorize CLI</CardTitle>
          <CardDescription>A device is asking to sign in to your Simbox account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!user_code ? (
            <Notice variant="destructive">
              <CircleAlert />
              <span>
                Missing device code. Run <code className="font-mono">simbox login</code> again and
                open the link it prints.
              </span>
            </Notice>
          ) : phase === "claiming" ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              verifying code <span className="font-mono">{user_code}</span>…
            </p>
          ) : phase === "confirm" ? (
            <>
              <div className="rounded-md border border-border bg-muted/40 py-4 text-center font-mono text-2xl font-semibold tracking-[0.2em]">
                {user_code}
              </div>
              <Notice variant="warning">
                <ShieldAlert />
                <span>
                  Only approve if <strong>you</strong> just ran{" "}
                  <code className="font-mono">simbox login</code> and this code matches your
                  terminal. Never approve a code someone else gave you.
                </span>
              </Notice>
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ code: user_code, approve: true })}
                >
                  {decide.isPending ? <Loader2 className="animate-spin" /> : null}
                  Approve
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ code: user_code, approve: false })}
                >
                  Deny
                </Button>
              </div>
            </>
          ) : phase === "done" ? (
            <Notice variant="info">
              <CheckCircle2 className="text-primary" />
              <span>CLI authorized — return to your terminal. You can close this tab.</span>
            </Notice>
          ) : phase === "denied" ? (
            <Notice>
              <CircleAlert />
              <span>Request denied. You can close this tab.</span>
            </Notice>
          ) : (
            <Notice variant="destructive">
              <CircleAlert />
              <span>
                {error ?? "Something went wrong."} The code may have expired — run{" "}
                <code className="font-mono">simbox login</code> again.
              </span>
            </Notice>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/device",
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    user_code:
      // better-auth's verification_uri_complete uses ?user_code=; accept ?code= too
      // for hand-typed links.
      typeof search.user_code === "string" && search.user_code
        ? search.user_code
        : typeof search.code === "string" && search.code
          ? search.code
          : undefined,
  }),
  component: DevicePage,
});
