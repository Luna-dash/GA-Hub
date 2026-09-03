/** @type {import('tailwindcss').Config} */
// Custom palette references CSS variables so we can swap dark/light at
// runtime by toggling a class on <html>. See styles/index.css.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'var(--c-bg)',
          soft: 'var(--c-bg-soft)',
          card: 'var(--c-bg-card)',
        },
        line: { DEFAULT: 'var(--c-line)' },
        accent: {
          DEFAULT: 'var(--c-accent)',
          soft: 'var(--c-accent-soft)',
        },
        // Text tones: the ONLY sanctioned text colors. Hardcoding hex
        // text-[#...] values is what let three slightly different "muted
        // grays" (#665741/#7B6D5A/#8A7B65) drift across pages.
        ink: {
          DEFAULT: 'var(--c-text)',
          muted: 'var(--c-text-muted)',
          faint: 'var(--c-text-faint)',
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SFMono-Regular"', 'monospace'],
      },
    },
  },
  plugins: [],
}
