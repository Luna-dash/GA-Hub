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
        // Text tones: sanctioned for prose/UI text. Hardcoding hex text-[#...]
        // values is what let three slightly different "muted grays"
        // (#665741/#7B6D5A/#8A7B65) drift across pages.
        ink: {
          DEFAULT: 'var(--c-text)',
          muted: 'var(--c-text-muted)',
          faint: 'var(--c-text-faint)',
        },
        // Semantic status palette: the sanctioned vocabulary for state color
        // (badges, dots, banners, evidence panels). Values are fixed hex on
        // purpose — status meaning must not flip with the theme. One-off
        // neutrals used once or twice (empty-state headings, italic notes,
        // chart series colors) may stay inline literals.
        status: {
          danger: {
            DEFAULT: '#9E3328',
            soft: '#FFF7F5',
            line: '#E8CFC7',
            muted: '#6B3A30',
          },
          info: { DEFAULT: '#285A78', soft: '#EAF2F8', line: '#D7E4EE' },
          success: { DEFAULT: '#2D6A3F', soft: '#E8F4EA', strong: '#3C8A52' },
          warning: {
            DEFAULT: '#7A4F08',
            soft: '#FFF3D8',
            strong: '#9A5315',
            hot: '#C4681C',
          },
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
