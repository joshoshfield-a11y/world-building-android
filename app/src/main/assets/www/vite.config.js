import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: 'three/webgpu', replacement: fileURLToPath(new URL('./vendor/three.webgpu.min.js', import.meta.url)) },
      { find: 'three/tsl', replacement: fileURLToPath(new URL('./vendor/three.tsl.min.js', import.meta.url)) },
      { find: 'three', replacement: fileURLToPath(new URL('./vendor/three.webgpu.min.js', import.meta.url)) },
      { find: 'lil-gui', replacement: fileURLToPath(new URL('./vendor/lil-gui.esm.min.js', import.meta.url)) },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        world: resolve(root, 'index.html'),
        hub: resolve(root, 'hub.html'),
        ocean: resolve(root, 'ocean/index.html'),
        grass: resolve(root, 'grass/index.html'),
        sky: resolve(root, 'sky/index.html'),
      },
    },
  },
})
