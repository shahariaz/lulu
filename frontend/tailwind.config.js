/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#ffffff',
        card: '#ffffff',
        border: '#e4e4e7',
        foreground: '#18181b',
        muted: '#f4f4f5',
        'muted-foreground': '#71717a',
        accent: {
          DEFAULT: '#ea3a12',
          hover: '#c82e0a',
          foreground: '#ffffff',
        },
        swiss: {
          red: '#ea3a12',
          redHover: '#c82e0a',
          black: '#18181b',
          white: '#ffffff',
          gray: '#f4f4f5',
          border: '#e4e4e7',
          darkgray: '#27272a',
          muted: '#71717a',
        },
        success: '#059669',
        warning: '#d97706',
        danger: '#ea3a12',
        purple: '#6d28d9',
      },
      borderWidth: {
        DEFAULT: '1px',
        '0': '0px',
        '2': '2px',
        '3': '3px',
        '4': '4px',
        '8': '8px',
      },
      letterSpacing: {
        tightest: '-0.05em',
        tighter: '-0.035em',
        tight: '-0.02em',
        normal: '0',
        wide: '0.04em',
        wider: '0.08em',
        widest: '0.15em',
        ultra: '0.22em',
      },
      fontFamily: {
        sans: ['Inter', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
