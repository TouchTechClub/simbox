import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BookOpen,
  ChevronRight,
  LayoutGrid,
  LogOut,
  Moon,
  Sun,
  TerminalSquare,
} from "lucide-react";
import type { ReactNode } from "react";

import { GitHubIcon } from "@/components/icons";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GITHUB_APP_INSTALL_URL } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const DOCS_URL = "https://github.com/TouchTechClub/simbox#readme";
const REPO_URL = "https://github.com/TouchTechClub/simbox";

function Logo({ className }: { className?: string }) {
  return (
    <Link to="/dashboard" className={cn("flex items-center gap-2 font-semibold", className)}>
      <span className="flex size-6 items-center justify-center rounded-md border border-border bg-muted">
        <TerminalSquare className="size-3.5 text-primary" />
      </span>
      <span className="font-mono text-sm tracking-tight">simbox</span>
    </Link>
  );
}

function signOut() {
  void authClient.signOut().finally(() => {
    window.location.href = "/";
  });
}

function UserMenu() {
  const me = useMe();
  const user = me.data;

  if (!user) {
    return <div className="h-9 animate-pulse rounded-md bg-muted" />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-sidebar-ring">
        <img
          src={user.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="size-6 rounded-full border border-border"
        />
        <span className="min-w-0 flex-1 truncate text-sm">{user.login}</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-52">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">{user.login}</span>
            <span className="font-mono text-xs text-muted-foreground">
              github · {user.githubUserId}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={signOut} className="text-destructive focus:text-destructive">
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </TooltipTrigger>
      <TooltipContent>Toggle theme</TooltipContent>
    </Tooltip>
  );
}

function Nav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>Workspace</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === "/dashboard"}>
              <Link to="/dashboard">
                <LayoutGrid />
                Overview
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton disabled aria-disabled="true" title="Coming soon">
              <Activity />
              <span className="text-muted-foreground">Runs</span>
              <SidebarMenuBadge>soon</SidebarMenuBadge>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>Resources</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                <BookOpen />
                Docs
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                <GitHubIcon />
                GitHub
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noreferrer">
                <TerminalSquare />
                Install app
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}

/** Full-viewport app shell: icon+label sidebar, top bar, bordered content frame. */
export function AppShell({ crumb, children }: { crumb: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar className="hidden lg:flex">
        <SidebarHeader>
          <Logo />
        </SidebarHeader>
        <SidebarContent>
          <Nav />
        </SidebarContent>
        <SidebarFooter>
          <UserMenu />
        </SidebarFooter>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
          <div className="lg:hidden">
            <Logo />
          </div>
          <nav
            aria-label="breadcrumb"
            className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"
          >
            <span className="hidden lg:inline">simbox</span>
            <ChevronRight className="hidden size-3 lg:inline" />
            <span className="text-foreground">{crumb}</span>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <div
              aria-hidden="true"
              className="hidden items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 sm:flex"
            >
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </div>
            <ThemeToggle />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto min-h-full w-full max-w-5xl border-x border-border bg-background px-4 py-6 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
