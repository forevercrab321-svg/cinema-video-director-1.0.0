/**
 * Two languages: English (default) and 简体中文. The game is English-first everywhere; players
 * switch with the 中文 / EN button (room browser, lobby, settings), which is saved. Picked from
 * ?lang=, then the saved setting, else English.
 * Use L('中文', 'English') at every user-facing string; switching language reloads the page.
 */
export type Lang = 'zh' | 'en';

function detect(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'zh' || q === 'en') return q;
  try {
    const saved = localStorage.getItem('grow-lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    /* storage blocked */
  }
  return 'en';
}

export const lang: Lang = detect();

export function L(zh: string, en: string): string {
  return lang === 'zh' ? zh : en;
}

/** Button label that switches to the other language. */
export const otherLangLabel = (): string => (lang === 'zh' ? 'EN' : '中文');

export function toggleLang(): void {
  setLang(lang === 'zh' ? 'en' : 'zh');
}

export function setLang(l: Lang): void {
  try {
    localStorage.setItem('grow-lang', l);
  } catch {
    /* storage blocked */
  }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.href = url.toString();
}
