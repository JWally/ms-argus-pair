/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Shared Argus design tokens — literal hex kept byte-identical to
        // ms-argus-www (the marketing-page prototype) and to index.css :root.
        // Literal (not var()) so Tailwind opacity modifiers like
        // `bg-bg-secondary/80` still resolve.
        accent: '#8b5cf6',
        'accent-hover': '#a78bfa',
        'accent-light': 'rgba(139, 92, 246, 0.1)',
        'accent-border': 'rgba(139, 92, 246, 0.2)',
        'bg-primary': '#0d0f1a',
        'bg-secondary': '#161829',
        'bg-tertiary': '#1e2035',
        'fg-primary': '#f0edf4',
        'fg-secondary': '#a8a4b4',
        'fg-muted': '#6b6880',
        border: '#2a2c40',
        positive: '#4ade80',
        negative: '#f87171',
        purple: {
          DEFAULT: '#4D1979',
          light: '#6B2FA0',
          dark: '#3A1260',
          50: '#F5F0FA',
          100: '#E8DCEF',
          200: '#D1B9DF',
          900: '#2A0E44',
        },
        // Legacy pair-only tokens still referenced by index.css
        // (qr-frame, step-dot, sso-shell, etc.).
        bg: '#0a0a0a',
        panel: '#141414',
        edge: '#262626',
        muted: '#a8a4b4',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
        crt: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
