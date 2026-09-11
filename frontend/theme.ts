import { ThemeMode } from './api';

export function resolveThemeMode(theme: ThemeMode): 'dark' | 'light' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }
  return theme;
}

export function applyTheme(theme: ThemeMode) {
  const resolved = resolveThemeMode(theme);
  
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.resolvedTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  
  if (document.body) {
    document.body.setAttribute('theme-mode', resolved);
    if (resolved === 'dark') {
      document.body.classList.add('semi-always-dark');
      document.body.classList.remove('semi-always-light');
    } else {
      document.body.classList.add('semi-always-light');
      document.body.classList.remove('semi-always-dark');
    }
  }
}

// Listen to OS color scheme changes when system theme is selected
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const currentTheme = (document.documentElement.dataset.theme as ThemeMode) || 'system';
    if (currentTheme === 'system') {
      applyTheme('system');
    }
  });
}
