/** @type {import('tailwindcss').Config} */
// Custom palette references CSS variables in styles/index.css. The app is a
// single forced paper-yellow theme — no dark-mode machinery anywhere.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '!./src/**/*.test.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--c-bg-rgb) / <alpha-value>)',
          soft: 'rgb(var(--c-bg-soft-rgb) / <alpha-value>)',
          card: 'rgb(var(--c-bg-card-rgb) / <alpha-value>)',
        },
        line: { DEFAULT: 'rgb(var(--c-line-rgb) / <alpha-value>)' },
        accent: {
          DEFAULT: 'rgb(var(--c-accent-rgb) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft-rgb) / <alpha-value>)',
        },
        // Text tones: sanctioned for prose/UI text. Hardcoding hex text-[#...]
        // values is what let three slightly different "muted grays"
        // (#665741/#7B6D5A/#8A7B65) drift across pages.
        ink: {
          DEFAULT: 'rgb(var(--c-text-rgb) / <alpha-value>)',
          muted: 'rgb(var(--c-text-muted-rgb) / <alpha-value>)',
          faint: 'rgb(var(--c-text-faint-rgb) / <alpha-value>)',
        },
        // Semantic status palette: the sanctioned vocabulary for state color
        // (badges, dots, banners, evidence panels). Values are fixed hex on
        // purpose — status meaning must not flip with the theme. One-off
        // neutrals used once or twice (empty-state headings, italic notes,
        // chart series colors) may stay inline literals.
        status: {
          danger: {
            DEFAULT: 'rgb(var(--c-status-danger-rgb) / <alpha-value>)',
            soft: 'rgb(var(--c-status-danger-soft-rgb) / <alpha-value>)',
            line: 'rgb(var(--c-status-danger-line-rgb) / <alpha-value>)',
            muted: 'rgb(var(--c-status-danger-muted-rgb) / <alpha-value>)',
            strong: 'rgb(var(--c-status-danger-strong-rgb) / <alpha-value>)',
          },
          info: {
            DEFAULT: 'rgb(var(--c-status-info-rgb) / <alpha-value>)',
            soft: 'rgb(var(--c-status-info-soft-rgb) / <alpha-value>)',
            line: 'rgb(var(--c-status-info-line-rgb) / <alpha-value>)',
            strong: 'rgb(var(--c-status-info-strong-rgb) / <alpha-value>)',
          },
          success: {
            DEFAULT: 'rgb(var(--c-status-success-rgb) / <alpha-value>)',
            soft: 'rgb(var(--c-status-success-soft-rgb) / <alpha-value>)',
            line: 'rgb(var(--c-status-success-line-rgb) / <alpha-value>)',
            strong: 'rgb(var(--c-status-success-strong-rgb) / <alpha-value>)',
          },
          warning: {
            DEFAULT: 'rgb(var(--c-status-warning-rgb) / <alpha-value>)',
            soft: 'rgb(var(--c-status-warning-soft-rgb) / <alpha-value>)',
            line: 'rgb(var(--c-status-warning-line-rgb) / <alpha-value>)',
            muted: 'rgb(var(--c-status-warning-muted-rgb) / <alpha-value>)',
            strong: 'rgb(var(--c-status-warning-strong-rgb) / <alpha-value>)',
            hot: 'rgb(var(--c-status-warning-hot-rgb) / <alpha-value>)',
          },
        },
      },
      fontFamily: {
        sans: ['var(--ga-font-sans, "PingFang SC")', '"Segoe UI"', '"Microsoft YaHei UI"', 'system-ui', 'sans-serif'],
        mono: ['var(--ga-font-mono, "Cascadia Mono")', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
