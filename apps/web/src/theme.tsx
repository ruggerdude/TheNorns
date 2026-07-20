import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "norns_theme";

function themeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function preferredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = themeStorage()?.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: "dark", setTheme: applyTheme });

export function ThemeProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = preferredTheme();
    applyTheme(initial);
    return initial;
  });

  useEffect(() => {
    applyTheme(theme);
    themeStorage()?.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  return useContext(ThemeContext);
}

export function ThemeToggle(): React.ReactElement {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="btn btn-default btn-small theme-toggle"
      onClick={() => setTheme(nextTheme)}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}
