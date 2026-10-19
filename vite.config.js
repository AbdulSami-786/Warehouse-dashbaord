import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build opens from a web host and from the
// packaged Electron app (file://), where absolute /assets paths break.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1600 },
});
