import { defineConfig } from 'vite';

// GitHub Pages 项目站点部署在 /endfield_AICsimu/ 子路径下，静态资源必须
// 带上这个前缀才能正确加载，见 index.html 的 <link>/<script> 与
// src/interactions.js 里用 import.meta.env.BASE_URL 拼出的物品图标路径。
export default defineConfig({
  base: '/endfield_AICsimu/',
});
