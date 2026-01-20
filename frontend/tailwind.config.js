/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Graphik Web',
          '-apple-system',
          'BlinkMacSystemFont',
          'Inter',
          'system-ui',
          'sans-serif'
        ]
      },
      colors: {
        content: {
          primary: '#f8f8f8',
          secondary: '#d1d1d1',
          tertiary: '#afafaf'
        },
        border: {
          subtle: '#282828',
          medium: '#3e3e3e',
          strong: '#4f4f4f'
        },
        fill: {
          input: '#1c1c1c',
          button: '#f8f8f8'
        },
        overlay: {
          subtle: 'rgba(255, 255, 255, 0.03)',
          medium: 'rgba(255, 255, 255, 0.07)'
        },
        background: {
          page: '#000000',
          card: 'rgba(37, 37, 37, 0.7)'
        }
      },
      fontSize: {
        'heading-xs': [
          '20px',
          { lineHeight: '1', letterSpacing: '-0.2px', fontWeight: '600' }
        ],
        'paragraph-sm': ['14px', { lineHeight: '1.5', fontWeight: '500' }],
        'paragraph-xs': ['12px', { lineHeight: '1.5', fontWeight: '400' }],
        'paragraph-xxs': ['10px', { lineHeight: '1.5', fontWeight: '400' }]
      },
      borderRadius: {
        card: '8px',
        element: '6px',
        input: '4px'
      },
      backdropBlur: {
        header: '17.5px'
      },
      boxShadow: {
        card: '0px 0px 40px 15px rgba(0, 0, 0, 0.35)'
      },
      spacing: {
        card: '20px',
        section: '40px'
      },
      maxWidth: {
        'main-card': '600px',
        container: '960px'
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        'backdrop-fade-in': {
          '0%': { backgroundColor: 'transparent', backdropFilter: 'blur(0px)' },
          '100%': {
            backgroundColor: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(6px)'
          }
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' }
        }
      },
      animation: {
        'fade-in': 'fade-in 0.3s cubic-bezier(0.25, 1, 0.5, 1)',
        'backdrop-fade-in':
          'backdrop-fade-in 1s cubic-bezier(0.25, 1, 0.5, 1) forwards',
        'slide-up': 'slide-up 0.8s cubic-bezier(0.25, 1, 0.5, 1)',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite'
      }
    }
  },
  plugins: []
};
