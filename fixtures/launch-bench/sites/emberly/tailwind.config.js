// Emberly (invented): a Tailwind-style config, read as text only.
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#e4572e",
          600: "#c2410c",
        },
        ink: "#1d1a17",
        paper: "#fff8f0",
        moss: "#4c6b3c",
      },
      fontFamily: {
        display: ["Fraunces", "Georgia", "serif"],
        sans: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
