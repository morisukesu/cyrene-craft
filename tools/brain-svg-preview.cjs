"use strict";

/**
 * 生成脑图静态预览（不依赖服务，直接用浏览器打开看形状）
 *
 *   node tools/brain-svg-preview.cjs
 *   → web/brain-preview.html
 *
 * 为什么单独做一个：面板页要拉数据才能看，调试形状时被数据干扰。
 * 这个文件把五个区块按最终坐标画死，只关心「形状对不对」。
 */

const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "brain.html"), "utf8");

// 抠出 REGION_LAYOUT 与 COLORS，保证预览与真实页面用同一组坐标
const layoutSrc = html.match(/const REGION_LAYOUT = \[([\s\S]*?)\n\];/);
const colorsSrc = html.match(/const COLORS = \{([\s\S]*?)\n\};/);
if (!layoutSrc || !colorsSrc) {
  console.error("找不到 REGION_LAYOUT 或 COLORS");
  process.exit(1);
}

const layout = [...layoutSrc[1].matchAll(/id:\s*"(\w+)",\s*\n\s*name:\s*"([^"]+)",\s*\n\s*hint:\s*"([^"]+)",\s*\n\s*cx:\s*(\d+),\s*cy:\s*(\d+),\s*rx:\s*(\d+),\s*ry:\s*(\d+)/g)].map(
  (x) => ({ id: x[1], name: x[2], hint: x[3], cx: +x[4], cy: +x[5], rx: +x[6], ry: +x[7] }),
);

const colors = {};
for (const m of colorsSrc[1].matchAll(/(\w+):\s*"(#[0-9a-fA-F]{6})"/g)) {
  colors[m[1]] = m[2];
}

// 画线：只连相邻区块，且两端缩到椭圆边缘
function edgePoint(from, to, r) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const t = 1 / Math.hypot(dx / r.rx, dy / r.ry);
  return { x: from.x + dx * t, y: from.y + dy * t };
}

const LINKS = [
  ["sensory", "association"],
  ["sensory", "memory"],
  ["sensory", "motor"],
  ["association", "memory"],
  ["memory", "motor"],
  ["association", "limbic"],
  ["memory", "limbic"],
  ["motor", "limbic"],
];

const wires = LINKS.map(([a, b]) => {
  const ra = layout.find((x) => x.id === a);
  const rb = layout.find((x) => x.id === b);
  const ca = { x: ra.cx, y: ra.cy };
  const cb = { x: rb.cx, y: rb.cy };
  const p1 = edgePoint(ca, cb, ra);
  const p2 = edgePoint(cb, ca, rb);
  return `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}" stroke="#ff5b8a" stroke-opacity=".45" stroke-width="1.6"/>`;
}).join("\n  ");

const zones = layout
  .map((r) => {
    const c = colors[r.id] || "#999";
    return `
  <ellipse cx="${r.cx}" cy="${r.cy}" rx="${r.rx}" ry="${r.ry}"
    fill="${c}" fill-opacity=".18" stroke="${c}" stroke-opacity=".8" stroke-width="2"/>
  <text x="${r.cx}" y="${r.cy - 4}" text-anchor="middle"
    font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" font-weight="600" fill="#3a3040">${r.name}</text>
  <text x="${r.cx}" y="${r.cy + 13}" text-anchor="middle"
    font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10" fill="#8e8391">${r.hint}</text>`;
  })
  .join("");

const out = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>脑图形状预览</title>
<style>
  body { margin: 0; background: #fffafc; display: flex; justify-content: center; padding: 32px; }
  svg { background: #fff; border-radius: 14px; box-shadow: 0 8px 30px -18px rgba(232,96,143,.5); }
  .grid { stroke: #f4e6ee; stroke-width: .5; stroke-dasharray: 3 3; }
</style>
</head>
<body>
<svg width="760" height="560" viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg">
  <g>
    ${Array.from({ length: 20 }, (_, i) => `<line class="grid" x1="${i * 40}" y1="0" x2="${i * 40}" y2="560"/>`).join("\n    ")}
    ${Array.from({ length: 14 }, (_, i) => `<line class="grid" x1="0" y1="${i * 40}" x2="760" y2="${i * 40}"/>`).join("\n    ")}
  </g>
  ${wires}
  ${zones}
</svg>
</body>
</html>
`;

const dest = path.join(__dirname, "..", "web", "brain-preview.html");
fs.writeFileSync(dest, out, "utf8");

console.log(`已生成：${dest}`);
console.log(`区块 ${layout.length} 个，连线 ${LINKS.length} 条，viewBox 760x560`);
for (const r of layout) {
  console.log(
    `  ${r.name.padEnd(5)} x[${String(r.cx - r.rx).padStart(3)}, ${String(r.cx + r.rx).padStart(3)}]  y[${String(r.cy - r.ry).padStart(3)}, ${String(r.cy + r.ry).padStart(3)}]`,
  );
}
