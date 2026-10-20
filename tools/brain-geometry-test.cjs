"use strict";

/**
 * 脑图几何自检 · 3D 版
 *
 * 上一版验的是冠状位 SVG 的 REGION_SHAPES / BRAIN_OUTLINE 常量。
 * 脑图改成 three.js 之后这两个常量早就不存在了，脚本靠正则抠不到东西，
 * 于是「解析出五个脑区」失败、而后面几条断言在空数组上跑，全部空过——
 * 6 通过 / 4 失败，看起来像小问题，其实验的东西全没了。
 *
 * 这一版改成验真正在跑的东西：
 *   1. 从 brain3d.js 里抠出真实函数（shouldHide / regionOfNodeName /
 *      regionOfPoint / REGION_CENTROIDS）直接调用，不做文本匹配
 *   2. 读 vendor/brain.glb，按 _build() 的同一套规则跑一遍分区
 *   3. 验坐标：归一化基准只算可见网格、五区质心与解剖命名一致、
 *      前后/上下分层方向对得上
 *   4. 验分区：每区都有网格、没有网格被丢掉、坐标兜底真的在区分而不是全塞一区
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const webDir = path.join(root, "web");
const brain3dSrc = fs.readFileSync(path.join(webDir, "brain3d.js"), "utf8");
const glbPath = path.join(webDir, "vendor", "brain.glb");

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, e });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

/* ============================================================
   1. 从 brain3d.js 抠出真实逻辑
   ============================================================ */

/**
 * 取 class 之前的模块级代码（常量 + 纯函数），去掉 import / export 让它能在
 * node 里直接求值。这样验的是线上真跑的那份实现，不是抄一份副本。
 */
function loadBrain3dLogic() {
  const cut = brain3dSrc.indexOf("export class Brain3D");
  assert.ok(cut > 0, "brain3d.js 里找不到 export class Brain3D");

  const head = brain3dSrc
    .slice(0, cut)
    .replace(/^import .*$/gm, "")
    .replace(/^export /gm, "");

  const factory = new Function(
    `${head}
     return { REGIONS, REGION_CENTROIDS, shouldHide, regionOfNodeName, regionOfPoint };`,
  );
  return factory();
}

const logic = loadBrain3dLogic();

/* ============================================================
   2. 读 GLB（和 three 的 GLTFLoader 同源：看 accessors 的 min/max）
   ============================================================ */

/** 单个 mesh 的包围盒（多 primitive 取并集） */
function meshBox(json, meshIndex) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const prim of json.meshes[meshIndex].primitives) {
    const acc = json.accessors[prim.attributes.POSITION];
    if (!acc || !acc.min || !acc.max) continue;
    for (let i = 0; i < 3; i++) {
      mn[i] = Math.min(mn[i], acc.min[i]);
      mx[i] = Math.max(mx[i], acc.max[i]);
    }
  }
  return { mn, mx };
}

const glb = fs.readFileSync(glbPath);
const jsonLen = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLen).toString("utf8"));

/** 模型里所有带几何的节点 */
const nodes = [];
for (const n of gltf.nodes) {
  if (n.mesh === undefined) continue;
  const box = meshBox(gltf, n.mesh);
  if (!Number.isFinite(box.mn[0])) continue;
  nodes.push({ name: n.name || "", mn: box.mn, mx: box.mx });
}

/** 归一化基准：只算可见网格（与 _build() 保持同一套规则） */
function basisOf(list) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const n of list) {
    for (let i = 0; i < 3; i++) {
      mn[i] = Math.min(mn[i], n.mn[i]);
      mx[i] = Math.max(mx[i], n.mx[i]);
    }
  }
  const center = mn.map((v, i) => (v + mx[i]) / 2);
  const size = mx.map((v, i) => v - mn[i]);
  return { mn, mx, center, size, half: Math.max(...size) / 2 };
}

const visibleNodes = nodes.filter((n) => !logic.shouldHide(n.name));
const basis = basisOf(visibleNodes);
const fullBasis = basisOf(nodes);

/** 网格中心 → 归一化坐标（-1..1，max 边的一半为半径） */
function normalize(n) {
  return n.mn.map(
    (v, i) => ((v + n.mx[i]) / 2 - basis.center[i]) / basis.half || 0,
  );
}

/** 按 _build() 的规则给网格分区：先名字、后坐标 */
function classify(n) {
  const named = logic.regionOfNodeName(n.name);
  if (named) return { id: named, via: "name" };
  const [nx, ny, nz] = normalize(n);
  return { id: logic.regionOfPoint(nx, ny, nz), via: "geo" };
}

const assigned = visibleNodes.map((n) => ({ node: n, ...classify(n) }));

/** regionId → 网格列表 */
const byRegion = new Map();
for (const a of assigned) {
  if (!byRegion.has(a.id)) byRegion.set(a.id, []);
  byRegion.get(a.id).push(a);
}

const REGION_IDS = ["association", "sensory", "motor", "memory", "limbic"];

/** 某组网格的归一化质心 */
function centroidOf(list) {
  const sum = [0, 0, 0];
  for (const a of list) {
    const p = normalize(a.node);
    for (let i = 0; i < 3; i++) sum[i] += p[i] / list.length;
  }
  return sum;
}

console.log("\n脑图几何自检 · 3D 坐标与分区\n");

/* ============================================================
   3. 输入本身是否可信
   ============================================================ */

t("GLB 里有 437 个带几何的网格", () => {
  assert.strictEqual(nodes.length, 437, `实际 ${nodes.length} 个`);
});

t("五区定义齐全且 id 唯一", () => {
  const ids = logic.REGIONS.map((r) => r.id);
  assert.deepStrictEqual([...ids].sort(), [...REGION_IDS].sort());
  for (const r of logic.REGIONS) {
    assert.ok(r.name, `${r.id} 缺中文名`);
    assert.ok(r.lobe, `${r.id} 缺脑叶名`);
    assert.ok(typeof r.color === "number", `${r.id} 缺颜色`);
    assert.ok(r.match instanceof RegExp, `${r.id} 缺解剖名匹配正则`);
  }
});

t("轮廓常量已随 SVG 版一起移除（防止自检又去验不存在的常量）", () => {
  assert.ok(!/\bREGION_SHAPES\b/.test(brain3dSrc), "brain3d.js 仍有 REGION_SHAPES");
  assert.ok(!/\bBRAIN_OUTLINE\b/.test(brain3dSrc), "brain3d.js 仍有 BRAIN_OUTLINE");
  const html = fs.readFileSync(path.join(webDir, "brain.html"), "utf8");
  assert.ok(!/\bREGION_SHAPES\b/.test(html), "brain.html 仍有 REGION_SHAPES");
  assert.ok(!/\bBRAIN_OUTLINE\b/.test(html), "brain.html 仍有 BRAIN_OUTLINE");
});

/* ============================================================
   4. 剔除规则
   ============================================================ */

t("剔除规则覆盖血管/静脉窦/颅神经/骨", () => {
  for (const name of [
    "Middle cerebral artery.l",
    "Superior sagittal sinus",
    "Optic nerve",
    "Temporal bone",
    "Cartilage",
  ]) {
    assert.strictEqual(logic.shouldHide(name), true, `${name} 应该被隐藏`);
  }
});

t("脑组织不会被误剔除", () => {
  for (const name of [
    "Superior frontal gyrus.l",
    "Postcentral gyrus.r",
    "Lingual gyrus.l",
    "Hippocampus.r",
    "Cingulate gyrus.l",
  ]) {
    assert.strictEqual(logic.shouldHide(name), false, `${name} 不该被隐藏`);
  }
});

t("可见 319 个网格、隐藏 118 个", () => {
  assert.strictEqual(nodes.length - visibleNodes.length, 118, "隐藏数不对");
  assert.strictEqual(visibleNodes.length, 319, `可见数实际 ${visibleNodes.length}`);
});

/* ============================================================
   5. 坐标：归一化基准与解剖方向
   ============================================================ */

t("归一化基准只框住可见脑组织（不是整模型）", () => {
  // 血管与骨把整模型撑得更大，两个包围盒必须明显不同
  assert.ok(
    basis.half < fullBasis.half,
    `可见基准 half=${basis.half.toFixed(4)} 不小于整模型 half=${fullBasis.half.toFixed(4)}`,
  );
  const shrink = 1 - basis.half / fullBasis.half;
  assert.ok(shrink > 0.3, `可见基准只缩小了 ${(shrink * 100).toFixed(1)}%，说明血管仍被算进去了`);
});

t("_build() 里没有再用 setFromObject 当归一化基准", () => {
  const buildBody = brain3dSrc.slice(
    brain3dSrc.indexOf("_build(gltf)"),
    brain3dSrc.indexOf("_buildPulseRings"),
  );
  assert.ok(/shouldHide\(name\)/.test(buildBody), "基准计算没过滤隐藏网格");
  assert.ok(
    !/new THREE\.Box3\(\)\.setFromObject\(root\)/.test(buildBody),
    "还在用 setFromObject(root) 当基准，会把血管算进包围盒",
  );
});

t("所有网格的归一化坐标落在 -1.05..1.05 内", () => {
  const bad = [];
  for (const n of visibleNodes) {
    const p = normalize(n);
    for (let i = 0; i < 3; i++) {
      if (Math.abs(p[i]) > 1.05) bad.push(`${n.name} 轴${i}=${p[i].toFixed(2)}`);
    }
  }
  assert.strictEqual(bad.length, 0, bad.slice(0, 5).join(" / "));
});

t("解剖方向正确：额叶最前、枕叶最后、颞叶最下", () => {
  const c = {};
  for (const id of REGION_IDS) c[id] = centroidOf(byRegion.get(id) || []);

  // 额叶（association）在 +z，枕叶（motor）在 -z
  assert.ok(c.association[2] > c.sensory[2], `额叶 z=${c.association[2].toFixed(2)} 不靠前于感觉区`);
  assert.ok(c.association[2] > c.memory[2], "额叶不在颞叶前方");
  for (const id of ["sensory", "motor", "memory", "limbic"]) {
    assert.ok(
      c.association[2] > c[id][2],
      `额叶 z=${c.association[2].toFixed(2)} 不比 ${id} z=${c[id][2].toFixed(2)} 更靠前`,
    );
  }
  for (const id of ["association", "sensory", "memory", "limbic"]) {
    assert.ok(
      c.motor[2] < c[id][2],
      `枕叶 z=${c.motor[2].toFixed(2)} 不比 ${id} z=${c[id][2].toFixed(2)} 更靠后`,
    );
  }
  // 颞叶（memory）y 最低，顶叶（sensory）y 最高
  for (const id of REGION_IDS) {
    if (id === "memory") continue;
    assert.ok(
      c.memory[1] < c[id][1],
      `颞叶 y=${c.memory[1].toFixed(2)} 不比 ${id} y=${c[id][1].toFixed(2)} 更低`,
    );
    if (id === "sensory") continue;
    assert.ok(
      c.sensory[1] > c[id][1],
      `顶叶 y=${c.sensory[1].toFixed(2)} 不比 ${id} y=${c[id][1].toFixed(2)} 更高`,
    );
  }
});

t("左右对称：x 取反不改变分区", () => {
  for (let i = 0; i < 200; i++) {
    const x = (i / 200) * 1.8 - 0.9;
    const y = Math.sin(i) * 0.6;
    const z = Math.cos(i * 1.7) * 0.7;
    assert.strictEqual(
      logic.regionOfPoint(x, y, z),
      logic.regionOfPoint(-x, y, z),
      `x=${x.toFixed(2)} 处左右不对称`,
    );
  }
});

/* ============================================================
   6. 分区：真的分开了，不是全塞一区
   ============================================================ */

t("五个区都分到了网格", () => {
  for (const id of REGION_IDS) {
    const list = byRegion.get(id) || [];
    assert.ok(list.length > 0, `${id} 一个网格都没分到`);
    console.log(`      ${id.padEnd(12)} ${String(list.length).padStart(3)} 个网格`);
  }
});

t("没有网格被丢掉或分到未知区", () => {
  let total = 0;
  for (const [id, list] of byRegion) {
    assert.ok(REGION_IDS.includes(id), `出现了未知区 ${id}`);
    total += list.length;
  }
  assert.strictEqual(total, visibleNodes.length, `合计 ${total} ≠ 可见 ${visibleNodes.length}`);
});

t("单区不超过可见网格的 60%（防止又出现「一颗脑一个颜色」）", () => {
  for (const [id, list] of byRegion) {
    const ratio = list.length / visibleNodes.length;
    assert.ok(ratio <= 0.6, `${id} 占了 ${(ratio * 100).toFixed(1)}%，颜色会失衡`);
  }
});

t("坐标兜底真的在区分（未命名网格至少散到 3 个区）", () => {
  const geoOnly = assigned.filter((a) => a.via === "geo");
  assert.ok(geoOnly.length > 0, "没有走坐标兜底的网格，这条断言失去意义");
  const buckets = new Set(geoOnly.map((a) => a.id));
  assert.ok(
    buckets.size >= 3,
    `190 个未命名网格只落到 ${buckets.size} 个区（${[...buckets].join(",")}），坐标兜底在退化`,
  );
});

t("坐标兜底的分区与解剖质心一致（偏差 < 0.35）", () => {
  for (const [id, list] of byRegion) {
    const declared = logic.REGION_CENTROIDS[id];
    assert.ok(declared, `${id} 没有声明解剖质心`);
    const c = centroidOf(list);
    const drift = Math.hypot(c[0] - declared[0], c[1] - declared[1], c[2] - declared[2]);
    assert.ok(drift < 0.35, `${id} 实际质心偏了 ${drift.toFixed(3)}（声明 ${declared.join(",")}）`);
  }
});

t("regionOfPoint 是全函数：任意坐标都返回五个合法 id 之一", () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    for (let k = 0; k < 60; k++) {
      const x = (i / 59) * 2 - 1;
      const y = (k / 59) * 2 - 1;
      const z = Math.sin(i * 0.7) * 0.9;
      const id = logic.regionOfPoint(x, y, z);
      assert.ok(REGION_IDS.includes(id), `坐标 (${x},${y},${z}) 返回了 ${id}`);
      seen.add(id);
    }
  }
  assert.ok(seen.size >= 4, `采样只覆盖了 ${seen.size} 个区`);
});

t("regionOfNodeName 对未知名字返回 null，交给坐标兜底", () => {
  assert.strictEqual(logic.regionOfNodeName("Central sulcus.l"), null);
  assert.strictEqual(logic.regionOfNodeName("Putamen.l"), null);
  assert.strictEqual(logic.regionOfNodeName(""), null);
  assert.strictEqual(logic.regionOfNodeName("Superior temporal gyrus.l"), "memory");
  assert.strictEqual(logic.regionOfNodeName("Cingulate gyrus.l"), "limbic");
});

/* ============================================================
   7. 关键词冲突守卫（补词时最容易踩的坑）
   ============================================================ */

/*
 * 按解剖名归类是「按字母子串匹配」，不是按词边界。
 * 一旦某个区的关键词足够宽泛，就会把别的区抢过来，而且是静默的——
 * 网格数变了一点，肉眼看不出来，颜色悄悄换了位置。
 * 这组断言把已知的几对冲突钉死。
 */

t("sensory 的 paracentral 不会抢走额叶的 precentral", () => {
  // "precentral sulcus" 里含 "central"，宽泛写 /central/ 会整片抢走额叶沟回
  for (const name of [
    "Precentral sulcus (Superior part)*.l",
    "Precentral sulcus (inferior part)*.r",
    "Precentral gyrus.l",
  ]) {
    const id = logic.regionOfNodeName(name);
    assert.strictEqual(id, "association", `${name} 被判成 ${id}，应该留给额叶`);
  }
});

t("sensory 的 paracentral 不会抢走枕叶与颞叶", () => {
  // "parieto-occipital" 含 parieto，宽泛写 /pariet/ 会命中它
  assert.strictEqual(
    logic.regionOfNodeName("Parieto-occipital sulcus.l"),
    "motor",
    "parieto-occipital 沟属于枕叶边界，不该被感觉区抢走",
  );
  // 小脑方叶（quadrangular lobule）与角回字面相近，但不属于顶叶
  for (const name of ["Anterior quadrangular lobule.l", "Posterior quadrangular lobule.r"]) {
    assert.strictEqual(
      logic.regionOfNodeName(name),
      null,
      `${name} 不该被名字规则命中（含 angular 子串，宽泛写会误抢）`,
    );
  }
});

t("sensory 关键词不会抢走额下回三角部", () => {
  // "Triangular part of inferior frontal gyrus" 含 triangular / angular 子串
  assert.strictEqual(
    logic.regionOfNodeName("Triangular part of inferior frontal gyrus.l"),
    "association",
    "三角部属于额叶，宽泛的 angular 匹配会误伤",
  );
});

t("paracentral 确实归到 sensory（补这个词就是为了它）", () => {
  assert.strictEqual(logic.regionOfNodeName("Paracentral sulcus.l"), "sensory");
  assert.strictEqual(logic.regionOfNodeName("Paracentral gyrus and sulcus*.r"), "sensory");
});

/* ============================================================
   8. 页面接线：3D 入口存在
   ============================================================ */

const brainHtml = fs.readFileSync(path.join(webDir, "brain.html"), "utf8");

t("brain.html 用 canvas 渲染 3D 模型", () => {
  assert.ok(brainHtml.includes('id="brainCanvas"'), "缺 brainCanvas");
  assert.ok(brainHtml.includes('id="fxCanvas"'), "缺 2D 叠加层");
  assert.ok(brainHtml.includes('from "./brain3d.js"'), "没有引入 brain3d.js");
  assert.ok(brainHtml.includes("/vendor/brain.glb"), "没有加载 GLB");
});

t("训练面板有能点到的脑图入口", () => {
  const indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  // 之前只有 brain.html 里反向链到面板，面板上没有回去的路，等于找不到脑图
  assert.ok(
    /href="\/brain\.html"/.test(indexHtml),
    "训练面板没有指向 /brain.html 的链接，用户在面板上找不到脑图",
  );
  assert.ok(indexHtml.includes('id="btnBrain"'), "缺「打开 3D 脑图」按钮");
});

t("两个页面互相能跳（脑图页也有返回面板的链接）", () => {
  assert.ok(/href="\/"[^>]*>\s*训练面板/.test(brainHtml), "脑图页没有回训练面板的链接");
});

t("训练面板的脑图摘要走 /api/brain", () => {
  const indexHtml = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  assert.ok(indexHtml.includes("/api/brain"), "面板没有拉 /api/brain，摘要无从显示");
  assert.ok(indexHtml.includes("loadBrainTeaser"), "缺 brain 摘要渲染函数");
});

console.log(`\n${"-".repeat(50)}`);
console.log(`脑图几何：${pass} 通过 / ${fail} 失败`);

if (fail) {
  for (const f of failures) {
    console.log(`\n  ${f.name}`);
    console.log(`  ${String(f.e.stack || f.e).split("\n").slice(0, 3).join("\n  ")}`);
  }
  process.exit(1);
}
