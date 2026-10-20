"use strict";

/**
 * 3D 脑图单元测试
 *
 * 只测纯逻辑：分区规则、剔除规则、资源完整性。
 * 不跑 WebGL、不启浏览器——渲染效果交给截图确认。
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const webDir = path.join(root, "web");
const vendorDir = path.join(webDir, "vendor");

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

console.log("\n3D 脑图 · 资源与分区规则\n");

/* ---------------- 资源完整性 ---------------- */

const assets = [
  ["web/brain.html", path.join(webDir, "brain.html"), 8000],
  ["web/brain3d.js", path.join(webDir, "brain3d.js"), 12000],
  ["vendor/three.module.min.js", path.join(vendorDir, "three.module.min.js"), 400000],
  ["vendor/GLTFLoader.js", path.join(vendorDir, "GLTFLoader.js"), 80000],
  ["vendor/DRACOLoader.js", path.join(vendorDir, "DRACOLoader.js"), 8000],
  ["vendor/BufferGeometryUtils.js", path.join(vendorDir, "BufferGeometryUtils.js"), 20000],
  ["vendor/draco/draco_decoder.js", path.join(vendorDir, "draco", "draco_decoder.js"), 300000],
  ["vendor/draco/draco_decoder.wasm", path.join(vendorDir, "draco", "draco_decoder.wasm"), 100000],
  ["vendor/draco/draco_wasm_wrapper.js", path.join(vendorDir, "draco", "draco_wasm_wrapper.js"), 20000],
  ["vendor/brain.glb", path.join(vendorDir, "brain.glb"), 4000000],
];

for (const [label, p, minBytes] of assets) {
  t(`${label} 存在且大小合理`, () => {
    const st = fs.statSync(p);
    assert.ok(st.isFile(), `${label} 不是文件`);
    assert.ok(st.size >= minBytes, `${label} 只有 ${st.size} 字节，小于预期 ${minBytes}`);
  });
}

/* ---------------- GLB 头部校验 ---------------- */

t("brain.glb 是合法 glTF 2.0 二进制", () => {
  const buf = fs.readFileSync(path.join(vendorDir, "brain.glb"));
  assert.strictEqual(buf.subarray(0, 4).toString("ascii"), "glTF", "magic 不是 glTF");
  const version = buf.readUInt32LE(4);
  assert.strictEqual(version, 2, `版本应为 2，实际 ${version}`);
  const declared = buf.readUInt32LE(8);
  assert.strictEqual(declared, buf.length, `声明长度 ${declared} 与实际 ${buf.length} 不符`);
});

t("brain.glb 声明的 Draco 扩展与解码器匹配", () => {
  const buf = fs.readFileSync(path.join(vendorDir, "brain.glb"));
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
  const required = json.extensionsRequired || [];
  assert.ok(
    required.includes("KHR_draco_mesh_compression"),
    `required 扩展里没有 Draco：${required.join(",")}`,
  );
  // 既然 required 里有 Draco，解码器就必须在本地
  assert.ok(
    fs.existsSync(path.join(vendorDir, "draco", "draco_decoder.wasm")),
    "缺少 draco_decoder.wasm",
  );
});

/* ---------------- vendor 里的 import 路径 ---------------- */

for (const f of ["GLTFLoader.js", "DRACOLoader.js", "BufferGeometryUtils.js"]) {
  t(`${f} 的 three 引用指向本地文件`, () => {
    const s = fs.readFileSync(path.join(vendorDir, f), "utf8");
    assert.ok(
      s.includes("from './three.module.min.js'"),
      `${f} 里没有指向本地 three 的 import`,
    );
    assert.ok(
      !/from ['"]three['"]/.test(s),
      `${f} 里仍存在裸 'three' 引用，浏览器会解析失败`,
    );
  });
}

t("GLTFLoader 引用 BufferGeometryUtils 用同级路径", () => {
  const s = fs.readFileSync(path.join(vendorDir, "GLTFLoader.js"), "utf8");
  assert.ok(
    s.includes("from './BufferGeometryUtils.js'"),
    "GLTFLoader 的 BufferGeometryUtils 路径没改成同级",
  );
});

/* ---------------- 分区规则（从 brain3d.js 静态提取） ---------------- */

const b3 = fs.readFileSync(path.join(webDir, "brain3d.js"), "utf8");

t("定义了五个脑区", () => {
  const ids = [...b3.matchAll(/id:\s*"(association|sensory|motor|memory|limbic)"/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ids).size, 5, `实际找到 ${new Set(ids).size} 个`);
});

t("存在剔除规则 EXCLUDE", () => {
  assert.ok(/const EXCLUDE\s*=/.test(b3), "没有 EXCLUDE 常量");
  // 关键三类都要覆盖
  for (const kw of ["artery", "sinus", "nerve"]) {
    assert.ok(b3.includes(kw), `EXCLUDE 里没覆盖 ${kw}`);
  }
});

t("存在空间兜底函数 regionOfPoint", () => {
  assert.ok(/export function regionOfPoint/.test(b3), "没有 regionOfPoint");
});

t("DRACOLoader 指向本地解码器目录", () => {
  assert.ok(
    b3.includes('setDecoderPath("./vendor/draco/")'),
    "解码器路径不是 ./vendor/draco/",
  );
});

t("没有遗留的旧椭圆布局常量", () => {
  assert.ok(!/REGION_LAYOUT/.test(b3), "brain3d.js 里还残留 REGION_LAYOUT");
  const html = fs.readFileSync(path.join(webDir, "brain.html"), "utf8");
  assert.ok(!/REGION_LAYOUT/.test(html), "brain.html 里还残留 REGION_LAYOUT");
});

/* ---------------- 联动特效要素 ---------------- */

const html = fs.readFileSync(path.join(webDir, "brain.html"), "utf8");

t("存在 2D 叠加画布 fxCanvas", () => {
  assert.ok(html.includes('id="fxCanvas"'), "没有 fxCanvas");
  assert.ok(html.includes("pointer-events: none"), "叠加层没禁用指针事件");
});

t("联动特效含流动光点", () => {
  assert.ok(/DOT_COUNT/.test(html), "没有光点数量常量");
  assert.ok(/quadraticCurveTo/.test(html), "没有贝塞尔曲线绘制");
  assert.ok(/createRadialGradient/.test(html), "光点没有径向渐变光晕");
});

t("联动特效含区脉冲光环", () => {
  assert.ok(/shadowBlur/.test(html), "没有发光阴影");
  assert.ok(/globalCompositeOperation = "lighter"/.test(html), "没有叠加发光混合模式");
});

t("3D 侧有管状光带与光环", () => {
  assert.ok(/TubeGeometry/.test(b3), "没有 TubeGeometry 光带");
  assert.ok(/RingGeometry/.test(b3), "没有 RingGeometry 光环");
});

console.log(`\n${"-".repeat(50)}`);
console.log(`3D 脑图：${pass} 通过 / ${fail} 失败`);

if (fail) {
  for (const f of failures) {
    console.log(`\n  ${f.name}`);
    console.log(`  ${f.e.stack.split("\n").slice(0, 3).join("\n  ")}`);
  }
  process.exit(1);
}
