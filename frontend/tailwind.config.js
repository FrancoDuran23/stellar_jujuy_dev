/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bglight: '#FAF9F7',
        cardbg: '#FFFFFF',
        warmneutral: '#F4F2F1',
        cardborder: '#E8E5E4',
        textprimary: '#19181D',
        textsecondary: '#5F5C68',
        primaryviolet: {
          DEFAULT: '#6941FF',
          hover: '#5A32F4',
          light: '#EEE9FF',
          dim: 'rgba(105, 65, 255, 0.08)',
        },
        stellar: '#FDDA24',
        tealbrand: '#008C99',
        cyanlight: '#E5F7F8',
        online: '#31C48D',
        alerta: '#E85D5D',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif'],
        mono: ['Space Mono', 'monospace'],
      },
      keyframes: {
        floatShip: {
          '0%, 100%': { transform: 'translateY(0px) rotate(0deg)' },
          '50%': { transform: 'translateY(-12px) rotate(1.5deg)' },
        },
        slowDriftA: {
          '0%, 100%': { transform: 'translate(0, 0) rotate(0deg)' },
          '50%': { transform: 'translate(-10px, 12px) rotate(16deg)' },
        },
        slowDriftB: {
          '0%, 100%': { transform: 'translate(0, 0) rotate(0deg)' },
          '50%': { transform: 'translate(10px, -10px) rotate(-14deg)' },
        },
        pulseBeam: {
          '0%': { strokeDashoffset: '400' },
          '100%': { strokeDashoffset: '0' },
        },
        portalSpin: {
          '0%': { transform: 'rotate(0deg) scale(1)' },
          '50%': { transform: 'rotate(180deg) scale(1.04)' },
          '100%': { transform: 'rotate(360deg) scale(1)' },
        },
      },
      animation: {
        'float-ship': 'floatShip 5s ease-in-out infinite',
        'drift-a': 'slowDriftA 16s ease-in-out infinite',
        'drift-b': 'slowDriftB 20s ease-in-out infinite',
        portal: 'portalSpin 24s linear infinite',
        'portal-teal': 'spin 35s linear infinite',
      },
    },
  },
  plugins: [],
}
