import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "simbox-theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Dark-first theme toggle; persists to localStorage and mirrors onto <html>. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  return { theme, setTheme };
}
