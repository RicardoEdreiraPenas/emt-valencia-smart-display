import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // El build se copia junto al servidor, que lo sirve en el mismo origen que la API
  build: { outDir: '../server/web', emptyOutDir: true },
  // En desarrollo, las llamadas a /api van al servidor Flask local
  server: { proxy: { '/api': 'http://localhost:5000' } },
});
