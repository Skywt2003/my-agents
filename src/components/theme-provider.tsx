import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  setTheme(theme: Theme): void;
};

const THEME_STORAGE_KEY = "myagents-theme";
const FONT_STORAGE_KEY = "myagents-font";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function storedTheme(defaultTheme: Theme): Theme {
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system"
    ? value
    : defaultTheme;
}

function applyTheme(theme: Theme) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" || (theme === "system" && prefersDark),
  );
  document.documentElement.style.colorScheme =
    theme === "system" ? "light dark" : theme;
}

export function initializeAppearance() {
  try {
    const font = window.localStorage.getItem("myagents-font");
    if (font === "serif" || font === "sans") {
      document.documentElement.dataset.font = font;
    }
    applyTheme(storedTheme("light"));
  } catch {
    applyTheme("light");
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return storedTheme(defaultTheme);
    } catch {
      return defaultTheme;
    }
  });

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }

    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        try {
          setThemeState(storedTheme(defaultTheme));
        } catch {
          setThemeState(defaultTheme);
        }
      }
      if (event.key === FONT_STORAGE_KEY) {
        document.documentElement.dataset.font = event.newValue === "serif"
          ? "serif"
          : "sans";
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [defaultTheme]);

  const value = useMemo(
    () => ({ theme, setTheme: setThemeState }),
    [theme],
  );

  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider.");
  return value;
}
