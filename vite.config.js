import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('maplibre-gl')) return 'maplibre-gl';
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('react') || id.includes('react-dom')) return 'react-vendor';
          return 'vendor';
        },
      },
    },
  },
});
