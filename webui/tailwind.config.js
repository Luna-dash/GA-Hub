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
      },
      fontFamily: {
        sans: ['"Inter"', '"PingFang SC"', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SFMono-Regular"', 'monospace'],
      },
    },
  },
  plugins: [],
}
