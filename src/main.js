// ---- 应用入口：初始化画布、绑定交互、启动渲染 ----
import { canvas, ctx } from './state.js';
import { initView } from './coords.js';
import { draw } from './render.js';
import { initInteractions, updateHintText } from './interactions.js';

function resize() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
window.addEventListener('resize', resize);

initInteractions();

// 初始化
initView();
resize();
updateHintText();
