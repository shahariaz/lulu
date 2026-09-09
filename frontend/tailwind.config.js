/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#0d1117',
        card: '#161b22',
        border: '#30363d',
        foreground: '#c9d1d9',
        muted: '#8b949e',
        accent: {
          DEFAULT: '#58a6ff',
          hover: '#79c0ff',
        },
        success: '#3fb950',
        warning: '#d29922',
        danger: '#f85149',
        purple: '#bc8cff',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
