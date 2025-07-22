import resolve from 'rollup-plugin-node-resolve';
import commonjs from 'rollup-plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.js',
  output: [
    {
      file: 'dist/index.js',
      format: 'esm',
      name: 'cesium-engine',
    },
    {
      file: 'dist/index.cjs.js',
      format: 'cjs',
      name: 'cesium-engine',
      exports: 'default',
    },
    {
      file: 'dist/index.min.js',
      format: 'esm',
      name: 'cesium-engine',
      plugins: [terser()],
    },
  ],
  plugins: [
    resolve(),
    commonjs(),
  ],
  external: ['cesium', 'mitt'],
}; 