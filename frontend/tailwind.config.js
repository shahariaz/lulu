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
        background: '#f5f5f3',
        card: '#ffffff',
        border: '#dededb',
        foreground: '#20201f',
        muted: '#62625e',
        accent: {
          DEFAULT: '#3157d5',
          hover: '#2849b6',
        },
        success: '#087554',
        warning: '#985000',
        danger: '#dc3545',
        purple: '#7c3aed',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
