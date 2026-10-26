/**
 * 无障碍屏幕助手插件（v1.7.1）：给 AI 提供「读屏 + 操作屏幕 + 屏幕截图理解」能力。
 * 与 App 侧 AccessibilityService 通过本地 HTTP（APP_A11Y_PORT，默认 3181）通信。
 * 用户需在系统设置 → 无障碍开启「DeepSeek Harness 屏幕助手」，未开启时返回引导文案。
 *
 * v1.7.1（2026-10-18，AI 试用反馈）：动作可验证——a11y_status 回结构化状态；tap 回命中节点
 * （matchedText/bounds/nodeIndex/clickableAncestor/pageChanged/newTitle/candidates）；
 * scroll/swipe 回 changed/atEdge（区分「到底了」与「手势没生效」）。做法是动作前后各取一次 /dump 对比。
 *
 * 注意：DSH 工具输出校验为 additionalProperties:false——execute 返回的每个字段
 * 都必须在 output.schema 中显式声明，否则结果会被判定为非法输出（历史踩坑）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { get as httpGet, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";

const name = "tool-accessibility";
const inject = ["tools"];

const a11yPort = () => parseInt(process.env.APP_A11Y_PORT || "3181", 10);

const GUIDE_TEXT =
  "无障碍服务未开启或不可用：请在手机系统设置 → 无障碍 →（已下载的服务/服务）→ 开启「DeepSeek Harness 屏幕助手」，然后打开 App 后重试。";

function a11yRequest(path, params, timeoutMs) {
  return new Promise((resolve) => {
    const qs = params
      ? "?" + Object.entries(params).map(([k, v]) =>
          encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
      : "";
    const req = httpGet({
      host: "127.0.0.1",
      port: a11yPort(),
      path: path + qs,
      timeout: timeoutMs || 8000,
      // v1.18.0：App 侧本地服务要校验调用方（127.0.0.1 对本机所有应用开放，不是访问控制）
      headers: { "X-DSH-Token": process.env.APP_LOCAL_TOKEN || "" }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 262144) req.destroy(); });
      res.on("end", () => resolve(data || "{\"ok\":false,\"error\":\"empty response\"}"));
    });
    req.on("error", () => resolve("{\"ok\":false,\"error\":\"App 本地服务不可用\"}"));
    req.on("timeout", () => { req.destroy(); resolve("{\"ok\":false,\"error\":\"App 本地服务超时\"}"); });
    req.end();
  });
}

/** POST JSON（/gesture 用）。 */
function a11yPost(path, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: "127.0.0.1",
      port: a11yPort(),
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        // v1.18.0：本地服务鉴权令牌（App 启动引擎时经 env 注入）
        "X-DSH-Token": process.env.APP_LOCAL_TOKEN || ""
      },
      timeout: timeoutMs || 8000
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; if (data.length > 262144) req.destroy(); });
      res.on("end", () => resolve(data || "{\"ok\":false,\"error\":\"empty response\"}"));
    });
    req.on("error", () => resolve("{\"ok\":false,\"error\":\"App 本地服务不可用\"}"));
    req.on("timeout", () => { req.destroy(); resolve("{\"ok\":false,\"error\":\"App 本地服务超时\"}"); });
    req.end(payload);
  });
}

function parseResult(raw, hint) {
  try {
    const v = JSON.parse(raw);
    if (!v.ok && v.error && /服务不可用|超时|empty response/.test(v.error)) {
      return { ok: false, error: (hint || GUIDE_TEXT) };
    }
    return v;
  } catch (e) {
    return { ok: false, error: "无障碍服务响应解析失败: " + String(raw).slice(0, 120) };
  }
}

/** DSH 个别路径可能以缺失 value 调用 render（历史回放/旧参数）；兜底避免整次工具调用失败，并把入参暴露出来便于定位。 */
const renderValue = (value, args) => (value && typeof value === "object" ? value : {
  ok: false,
  error: "工具未返回结果（render 收到空值；入参 " + JSON.stringify(args === void 0 ? null : args) + "）"
});

function renderResult(value) {
  value = renderValue(value);
  return [{
    type: "text",
    text: value.ok ? "操作成功。" : "执行失败：" + (value.error || "未知错误")
  }];
}

/**
 * android_touch_status 专用渲染：把 held[] 的坐标与按住时长如实回显。
 * 通用 renderResult 只输出「操作成功。」——execute 返回了这些字段、schema 也声明了，
 * 但 AI 看不到，而 touch_status 的全部意义就是「问一下现在按着什么」。
 */
function renderTouchStatus(value) {
  value = renderValue(value);
  if (!value.ok) return renderResult(value);
  const held = Array.isArray(value.held) ? value.held : [];
  const lines = [];
  if (held.length === 0) {
    lines.push("当前没有按住的虚拟手指。");
  } else {
    lines.push("当前按住 " + held.length + " 根手指：");
    held.forEach((h) => {
      const parts = [];
      if (typeof h.finger === "number") parts.push("手指 " + h.finger);
      if (typeof h.x === "number" && typeof h.y === "number") parts.push("像素(" + h.x + "," + h.y + ")");
      if (typeof h.fx === "number" && typeof h.fy === "number") parts.push("分数(" + h.fx + "," + h.fy + ")");
      if (typeof h.elapsedMs === "number") parts.push("已按住 " + h.elapsedMs + "ms");
      lines.push("  " + (parts.length > 0 ? parts.join(" ") : "（字段缺失）"));
    });
  }
  const meta = [];
  if (typeof value.holdTimeoutMs === "number" && value.holdTimeoutMs > 0) meta.push("按住超时上限 " + value.holdTimeoutMs + "ms");
  if (typeof value.maxFingers === "number" && value.maxFingers > 0) meta.push("最多 " + value.maxFingers + " 指");
  if (typeof value.screenW === "number" && typeof value.screenH === "number" && value.screenW > 0) meta.push("屏幕 " + value.screenW + "x" + value.screenH);
  if (meta.length > 0) lines.push(meta.join("，"));
  return [{ type: "text", text: lines.join("\n") }];
}

/** 屏幕节点树渲染成 AI 可读文本列表（带索引，方便 android_tap 引用坐标）。 */
function renderScreen(_args, value) {
  value = renderValue(value, _args);
  if (!value.ok) return renderResult(value);
  const lines = [];
  lines.push("当前前台应用: " + (value.package || "未知"));
  lines.push("节点数: " + value.count + (value.truncated ? "（已截断，仅显示部分）" : ""));
  if (value.hint) lines.push("提示: " + value.hint);
  lines.push("");
  const nodes = value.nodes || [];
  nodes.forEach((n, i) => {
    const flags = [];
    if (n.clickable) flags.push("可点击");
    if (n.input) flags.push("可输入");
    if (n.checked) flags.push("已选中");
    if (n.scrollable) flags.push("可滚动");
    const label = n.text || n.desc || "(无文字)";
    const short = label.length > 120 ? label.slice(0, 120) + "…" : label;
    lines.push(`[${i}] ${short}  (${n.x},${n.y} ${n.w}x${n.h})${flags.length ? " " + flags.join("/") : ""}`);
  });
  return [{ type: "text", text: lines.join("\n") }];
}

// ===================== v1.7.1：动作可验证（changed / atEdge / 命中信息） =====================
// App 侧无障碍 HTTP 只回「IPC 成功」，不回「屏幕到底有没有变」。这里在插件层于动作前后各取一次
// /dump 做对比，把「真的变了」「已经到头」「点中了哪个节点」如实回给模型，
// 避免把「到底了」误判成「手势注入失败」而反复重试（2026-10-18 AI 试用反馈的三条改进）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取一次 /dump 的结构化快照；失败时 ok:false（调用方自行降级，不影响动作本身）。 */
async function dumpSnapshot(timeoutMs) {
  const raw = await a11yRequest("/dump", undefined, timeoutMs || 6000);
  const v = parseResult(raw);
  if (!v.ok) {
    return { ok: false, error: v.error || GUIDE_TEXT, package: "", count: 0, nodes: [] };
  }
  const nodes = Array.isArray(v.nodes) ? v.nodes : [];
  return {
    ok: true,
    package: typeof v.package === "string" ? v.package : "",
    count: typeof v.count === "number" ? v.count : nodes.length,
    nodes
  };
}

/** 屏幕指纹：包名 + 节点数 + 前 40 个节点的「文字@坐标」。滚动/跳页/弹窗都会改变它。 */
function snapshotKey(snap) {
  if (!snap || !snap.ok) return "";
  const parts = [snap.package || "", String(snap.count || 0)];
  const lim = Math.min(snap.nodes.length, 40);
  for (let i = 0; i < lim; i++) {
    const n = snap.nodes[i] || {};
    parts.push(String(n.text || n.desc || "").slice(0, 60) + "@" + n.x + "," + n.y);
  }
  return parts.join("|");
}

/** 首条有文字的节点（DFS 顺序，通常就是页头/新页面标题）；空页返回 ""。 */
function firstLabel(snap) {
  if (!snap || !snap.ok) return "";
  for (const n of snap.nodes) {
    const t = String(n.text || n.desc || "").trim();
    if (t) return t.length > 100 ? t.slice(0, 100) + "…" : t;
  }
  return "";
}

/** 动作后取快照：先等 waitMs；指纹仍未变则最多补 retries 次（躲开滚动动画/跳转延迟）。 */
async function snapshotAfter(preKey, waitMs, retries) {
  await sleep(waitMs);
  let snap = await dumpSnapshot(6000);
  const extra = typeof retries === "number" ? retries : 1;
  for (let i = 0; i < extra; i++) {
    if (!snap.ok || snapshotKey(snap) !== preKey) break;
    await sleep(waitMs);
    snap = await dumpSnapshot(6000);
  }
  return snap;
}

/** 文本/描述模糊匹配（精确优先 → 可点击优先），返回按「最可能被点到」排序的候选。 */
function matchNodes(snap, needle) {
  if (!snap || !snap.ok) return [];
  const q = String(needle || "").trim().toLowerCase();
  if (!q) return [];
  const exact = [];
  const partial = [];
  snap.nodes.forEach((n, i) => {
    const t = String(n.text || "").trim().toLowerCase();
    const d = String(n.desc || "").trim().toLowerCase();
    const isExact = t === q || d === q;
    const isPartial = !isExact && ((t !== "" && t.indexOf(q) >= 0) || (d !== "" && d.indexOf(q) >= 0));
    if (!isExact && !isPartial) return;
    (isExact ? exact : partial).push({ index: i, node: n, clickable: n.clickable === true });
  });
  const pool = exact.length > 0 ? exact : partial;
  // 稳定排序：可点击的排前面，其余保持读屏顺序（与服务端 findNodeByText 的 rank 同向）
  return pool.slice().sort((a, b) => (a.clickable === b.clickable ? 0 : (b.clickable ? 1 : -1)));
}

/** 包含该坐标的最深节点 / 最深可点击节点（坐标点击时用来回命中信息）。 */
function nodeAtPoint(snap, x, y) {
  if (!snap || !snap.ok || typeof x !== "number" || typeof y !== "number" ||
      !Number.isFinite(x) || !Number.isFinite(y)) return null;
  let deepest = null;
  let clickable = null;
  snap.nodes.forEach((n, i) => {
    const w = typeof n.w === "number" ? n.w : 0;
    const h = typeof n.h === "number" ? n.h : 0;
    if (w <= 0 || h <= 0) return;
    if (x < n.x || x > n.x + w || y < n.y || y > n.y + h) return;
    const depth = typeof n.depth === "number" ? n.depth : 0;
    if (!deepest || depth >= deepest.depth) deepest = { index: i, node: n, depth };
    if (n.clickable === true && (!clickable || depth >= clickable.depth)) clickable = { index: i, node: n, depth };
  });
  return deepest == null ? null : { deepest, clickable };
}

const boundsOf = (n) => ({
  x: typeof n.x === "number" ? n.x : 0,
  y: typeof n.y === "number" ? n.y : 0,
  w: typeof n.w === "number" ? n.w : 0,
  h: typeof n.h === "number" ? n.h : 0
});
const boundsText = (b) => "(" + b.x + "," + b.y + " " + b.w + "x" + b.h + ")";

/** 候选节点 → schema 里 candidates[] 的元素（扁平化，方便模型直接拿来点坐标）。 */
function candidateOut(c) {
  const n = c.node;
  const o = {
    text: String(n.text || n.desc || ""),
    ...boundsOf(n),
    nodeIndex: c.index,
    clickable: c.clickable === true
  };
  if (n.text && n.desc) o.desc = String(n.desc);
  return o;
}

/** 本 App 的包名（正式版/Lite/兼容版都不同，不能硬编码）：App 起引擎时经 SHIZUKU_APP_ID 注入 getPackageName()。 */
function selfPackage() {
  const fromEnv = process.env.SHIZUKU_APP_ID || "";
  if (fromEnv) return fromEnv;
  const m = /\/data\/(?:user\/\d+|data)\/([^/]+)\//.exec(String(process.env.TMPDIR || ""));
  return m ? m[1] : "";
}

/** android_a11y_status 渲染：把「服务是否真的可用」摊开，而不是一句「操作成功。」。 */
function renderA11yStatus(value) {
  value = renderValue(value);
  if (!value.ok) {
    const lines = ["无障碍服务不可用（running=false）。"];
    if (value.error) lines.push(String(value.error));
    return [{ type: "text", text: lines.join("\n") }];
  }
  const lines = [];
  lines.push(value.running ? "无障碍服务：已连接（running=true）" : "无障碍服务：未连接（running=false）");
  if (value.serviceName) lines.push("服务组件：" + value.serviceName);
  lines.push("前台应用：" + (value.foregroundPackage || value.package || "未知"));
  lines.push("可读控件：" + (typeof value.nodeCount === "number" ? value.nodeCount : 0) + " 个");
  lines.push("能力：读屏 " + (value.canReadScreen ? "可用" : "不可用") +
    " / 手势注入 " + (value.canGesture ? "可用" : "不可用") +
    " / 截图 " + (value.canScreenshot ? "可用" : "不可用"));
  if (typeof value.apiLevel === "number" && value.apiLevel > 0) lines.push("Android API：" + value.apiLevel);
  return [{ type: "text", text: lines.join("\n") }];
}

/** android_tap 渲染：回显命中的是哪个节点、页面有没有真的变。 */
function renderTap(value) {
  value = renderValue(value);
  const cands = Array.isArray(value.candidates) ? value.candidates : [];
  if (!value.ok) {
    const lines = ["点击失败：" + (value.error || "未知错误")];
    if (cands.length > 0) {
      lines.push("候选节点（可改用坐标精确点击）：");
      cands.slice(0, 6).forEach((c) =>
        lines.push("  · " + (c.text || "(无文字)") + " " + boundsText(c) + " [节点 " + c.nodeIndex + "]"));
    }
    return [{ type: "text", text: lines.join("\n") }];
  }
  const lines = ["点击成功。"];
  if (value.method) lines.push("方式：" + value.method);
  if (value.matchedText) {
    lines.push("命中：" + value.matchedText + (value.bounds ? " " + boundsText(value.bounds) : ""));
  } else if (value.bounds) {
    lines.push("命中区域：" + boundsText(value.bounds));
  }
  if (typeof value.nodeIndex === "number" && value.nodeIndex >= 0) lines.push("节点索引：" + value.nodeIndex);
  if (value.clickableAncestor === true) lines.push("可点击祖先：是");
  if (value.compared === false) {
    lines.push("页面变化：未知（前后读屏对比失败）");
  } else {
    lines.push("页面变化：" + (value.pageChanged ? "是" : "否（页面未刷新，可能是开关/选中态变化）"));
  }
  if (value.newTitle) lines.push("当前首文本：" + value.newTitle);
  if (cands.length > 1) {
    lines.push("其他候选：");
    cands.slice(1, 6).forEach((c) =>
      lines.push("  · " + (c.text || "(无文字)") + " " + boundsText(c) + " [节点 " + c.nodeIndex + "]"));
  }
  return [{ type: "text", text: lines.join("\n") }];
}

const EDGE_TEXT = { top: "顶部", bottom: "底部", left: "最左", right: "最右" };

/** android_scroll / android_swipe 共用的渲染：区分「真的动了」「到头了」「没比成」。 */
function renderScrollLike(okText) {
  return (_args, value) => {
    value = renderValue(value);
    if (!value.ok) return renderResult(value);
    const lines = [okText];
    if (value.direction) lines.push("方向：" + value.direction);
    if (value.method) lines.push("方式：" + value.method);
    if (value.compared === false) {
      lines.push("内容变化：未知（前后读屏对比失败，只确认动作已下发）");
    } else if (value.changed === true) {
      lines.push("内容变化：是（节点数 " + value.nodeCountBefore + " → " + value.nodeCountAfter + "）");
    } else if (value.changed === false) {
      const edge = EDGE_TEXT[value.atEdge] || "边界";
      lines.push("内容变化：否（未检测到位移，已到" + edge + "——不是注入失败）");
    }
    if (value.firstTextBefore || value.firstTextAfter) {
      lines.push("首文本：" + (value.firstTextBefore || "(空)") + " → " + (value.firstTextAfter || "(空)"));
    }
    if (value.error) lines.push("提示：" + value.error);
    return [{ type: "text", text: lines.join("\n") }];
  };
}

/** swipe 方向：分数坐标与绝对像素都支持；都缺时给 unknown。 */
function swipeDirection(args) {
  let dy = NaN;
  let dx = NaN;
  if (args.fy1 !== undefined && args.fy2 !== undefined) dy = Number(args.fy2) - Number(args.fy1);
  else if (args.y1 !== undefined && args.y2 !== undefined) dy = Number(args.y2) - Number(args.y1);
  if (args.fx1 !== undefined && args.fx2 !== undefined) dx = Number(args.fx2) - Number(args.fx1);
  else if (args.x1 !== undefined && args.x2 !== undefined) dx = Number(args.x2) - Number(args.x1);
  if (Number.isFinite(dy) && Number.isFinite(dx)) {
    if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? "up" : (dy > 0 ? "down" : "unknown");
    return dx < 0 ? "left" : "right";
  }
  if (Number.isFinite(dy)) return dy < 0 ? "up" : "down";
  if (Number.isFinite(dx)) return dx < 0 ? "left" : "right";
  return "unknown";
}

// 手势方向 → 「没位移时内容到了哪一侧」：上滑（看后面的内容）到底 = bottom，下滑到顶 = top；左右同理。
const SCROLL_EDGE = { down: "bottom", up: "top", left: "left", right: "right" };
const SWIPE_EDGE = { up: "bottom", down: "top", left: "right", right: "left" };

function apply(ctx) {
  // 状态查询（始终注册：AI 先查状态，未开启时引导用户去系统设置开启）
  ctx.tools.register(defineTool({
    name: "android_a11y_status",
    description:
      "查询 DeepSeek Harness 无障碍服务（屏幕助手）是否已开启，以及当前屏幕焦点应用。" +
      "无障碍服务开启后，AI 才能读取屏幕内容并替你点击/输入/滚动（android_screen/android_tap 等）。" +
      "返回结构化状态：running / 服务组件 / 前台应用 / 可读控件数 / 能力（读屏、手势注入、截图）/ Android API。" +
      "若未开启（running=false），请引导用户：系统设置 → 无障碍 →（已下载的服务/服务）→ 开启「DeepSeek Harness 屏幕助手」。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          running: { type: "boolean" },
          // package 是历史字段（= 前台应用），foregroundPackage 是语义更清楚的同值字段
          package: { type: "string" },
          foregroundPackage: { type: "string" },
          serviceName: { type: "string" },
          nodeCount: { type: "number" },
          canScreenshot: { type: "boolean" },
          canReadScreen: { type: "boolean" },
          canGesture: { type: "boolean" },
          apiLevel: { type: "number" }
        }
      },
      render: (_a, v) => renderA11yStatus(v)
    },
    async execute(args, exec) {
      const raw = await a11yRequest("/status", undefined, 4000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, running: false, error: v.error || GUIDE_TEXT };
      const pkg = typeof v.package === "string" ? v.package : "";
      const nodeCount = typeof v.nodeCount === "number" ? v.nodeCount : 0;
      const apiLevel = typeof v.apiLevel === "number" ? v.apiLevel : 0;
      const running = v.running === true;
      const selfPkg = selfPackage();
      return {
        ok: true,
        running,
        package: pkg,
        foregroundPackage: pkg,
        serviceName: selfPkg ? selfPkg + "/.AccessibilityService" : "",
        nodeCount,
        canScreenshot: v.canScreenshot === true,
        // 都是真实推断：真的数到节点才算「读屏可用」；手势注入的门槛与 App 侧 gestureTap 一致（API≥24）
        canReadScreen: running && nodeCount > 0,
        canGesture: running && apiLevel >= 24,
        apiLevel
      };
    }
  }));

  // 读屏（控件树）
  ctx.tools.register(defineTool({
    name: "android_screen",
    description:
      "读取当前屏幕的控件树（无障碍）：返回前台应用包名、屏幕可见控件的文字/描述/坐标/可点击性。" +
      "坐标是屏幕绝对像素坐标，可直接用于 android_tap 的 x/y。" +
      "用于回答「屏幕上现在有什么」「帮我找到某某按钮/选项」「当前在哪个界面」。需要已开启无障碍服务。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          package: { type: "string" },
          count: { type: "number" },
          truncated: { type: "boolean" },
          hint: { type: "string" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                desc: { type: "string" },
                cls: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
                clickable: { type: "boolean" },
                input: { type: "boolean" },
                checked: { type: "boolean" },
                selected: { type: "boolean" },
                scrollable: { type: "boolean" },
                depth: { type: "number" }
              }
            }
          }
        }
      },
      render: renderScreen
    },
    async execute(args, exec) {
      const raw = await a11yRequest("/dump", undefined, 8000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      const nodes = Array.isArray(v.nodes) ? v.nodes.map((n) => ({
        text: typeof n.text === "string" ? n.text : "",
        desc: typeof n.desc === "string" ? n.desc : "",
        cls: typeof n.cls === "string" ? n.cls : "",
        x: typeof n.x === "number" ? n.x : 0,
        y: typeof n.y === "number" ? n.y : 0,
        w: typeof n.w === "number" ? n.w : 0,
        h: typeof n.h === "number" ? n.h : 0,
        clickable: n.clickable === true,
        input: n.input === true,
        checked: n.checked === true,
        selected: n.selected === true,
        scrollable: n.scrollable === true,
        depth: typeof n.depth === "number" ? n.depth : 0
      })) : [];
      return {
        ok: true,
        package: v.package || "",
        count: nodes.length,
        truncated: v.truncated === true,
        ...(typeof v.hint === "string" && v.hint ? { hint: v.hint } : {}),
        nodes
      };
    }
  }));

  // 点击
  ctx.tools.register(defineTool({
    name: "android_tap",
    description:
      "点击屏幕上的控件。传 text（控件文字，模糊包含匹配，优先可点击项）、desc（内容描述）、x/y（屏幕绝对像素坐标）或 fx/fy（0~1 分数坐标）。" +
      "优先用 fx/fy 分数坐标（相对屏幕比例）：截图会被模型查看器缩放，用绝对像素容易点偏，分数坐标免疫缩放。" +
      "至少给一个；同时给了 text 与坐标时按 text 查找优先，找不到再按坐标点。需要已开启无障碍服务。" +
      "返回命中信息：matchedText / bounds / nodeIndex（即 android_screen 列表里的下标）/ clickableAncestor，" +
      "以及点击后 pageChanged（页面是否真的变了）和 newTitle（新页面首条文字）；多命中时给 candidates 供改用坐标。",
    parameters: {
      text: { type: "string", description: "控件文字（模糊包含匹配）" },
      desc: { type: "string", description: "控件内容描述（模糊包含匹配）" },
      x: { type: "number", description: "屏幕绝对 x 坐标（像素）" },
      y: { type: "number", description: "屏幕绝对 y 坐标（像素）" },
      fx: { type: "number", description: "分数 x 坐标（0~1，相对屏幕宽度比例；推荐，避免截图缩放误差）" },
      fy: { type: "number", description: "分数 y 坐标（0~1，相对屏幕高度比例；推荐，避免截图缩放误差）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          found: { type: "boolean" },
          method: { type: "string" },
          // 以下为 v1.7.1 命中信息（动作前后各读屏一次推算；都是可选字段，旧调用方不受影响）
          matchedText: { type: "string" },
          matchedDesc: { type: "string" },
          bounds: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" }
            }
          },
          nodeIndex: { type: "number" },
          clickableAncestor: { type: "boolean" },
          compared: { type: "boolean" },
          pageChanged: { type: "boolean" },
          newTitle: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { type: "string" },
                desc: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
                nodeIndex: { type: "number" },
                clickable: { type: "boolean" }
              }
            }
          }
        }
      },
      render: (_a, v) => renderTap(v)
    },
    async execute(args, exec) {
      const params = {};
      if (args.text !== undefined && String(args.text).length > 0) params.text = String(args.text);
      if (args.desc !== undefined && String(args.desc).length > 0) params.desc = String(args.desc);
      if (args.x !== undefined) params.x = String(Number(args.x));
      if (args.y !== undefined) params.y = String(Number(args.y));
      if (args.fx !== undefined) params.fx = String(Number(args.fx));
      if (args.fy !== undefined) params.fy = String(Number(args.fy));
      if (Object.keys(params).length === 0) {
        return { ok: false, error: "android_tap 需要至少一个参数：text / desc / x / y / fx / fy" };
      }
      // 动作前先读一次屏：服务端不回命中信息，这里按同一匹配规则（精确优先 → 可点击优先）推算。
      const pre = await dumpSnapshot(6000);
      const preKey = snapshotKey(pre);
      let match = null;
      let candidates = [];
      if (params.text !== undefined || params.desc !== undefined) {
        candidates = matchNodes(pre, params.text !== undefined ? params.text : params.desc);
        match = candidates.length > 0 ? candidates[0] : null;
      } else if (params.x !== undefined && params.y !== undefined) {
        const hit = nodeAtPoint(pre, Number(params.x), Number(params.y));
        if (hit) match = hit.clickable || hit.deepest;
      }
      const raw = await a11yRequest("/tap", params, 8000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      const found = v.found !== false;
      if (!found) {
        const out = { ok: false, found: false, method: typeof v.method === "string" ? v.method : "" };
        if (v.error) out.error = String(v.error);
        if (candidates.length > 0) out.candidates = candidates.slice(0, 6).map(candidateOut);
        return out;
      }
      // 动作后再读一次：pageChanged/newTitle 用来区分「点中了但没跳转」与「压根没点中」。
      const post = await snapshotAfter(preKey, 450, 2);
      const compared = pre.ok && post.ok;
      const out = {
        ok: true,
        found: true,
        method: typeof v.method === "string" ? v.method : "",
        compared,
        pageChanged: compared ? snapshotKey(post) !== preKey : false,
        newTitle: firstLabel(post)
      };
      if (match) {
        const n = match.node;
        const label = String(n.text || n.desc || "");
        if (label) out.matchedText = label;
        if (n.text && n.desc) out.matchedDesc = String(n.desc);
        out.bounds = boundsOf(n);
        out.nodeIndex = match.index;
        const cx = n.x + Math.floor((typeof n.w === "number" ? n.w : 0) / 2);
        const cy = n.y + Math.floor((typeof n.h === "number" ? n.h : 0) / 2);
        const hit = n.clickable === true ? null : nodeAtPoint(pre, cx, cy);
        out.clickableAncestor = n.clickable === true || (hit != null && hit.clickable != null);
      }
      if (candidates.length > 1) out.candidates = candidates.slice(0, 6).map(candidateOut);
      return out;
    }
  }));

  // 输入文本（无障碍版；与特权版 android_input 区分，避免工具名冲突）
  ctx.tools.register(defineTool({
    name: "android_type",
    description:
      "在当前聚焦的输入框中输入文本（通过无障碍服务）。输入前通常先用 android_tap 点击目标输入框使其聚焦。需要已开启无障碍服务。\n" +
      "限制（真机实测）：网页/WebView、contenteditable（例如 DSH 自己的聊天输入框）对无障碍输入不可靠——setText 只改无障碍节点、不触发前端 input 事件；paste:true 也常只落到输入法候选栏、不提交。这类目标请改用系统级 android_input（先 tap 聚焦再 text 输入，两条路径均已实测可用）。\n" +
      "另一个前提：无障碍点击不保证建立输入焦点（键盘没弹出就是没聚焦）——先用 android_input 的 tap 聚焦并确认键盘弹出，再输入。原生 App 的 EditText 用默认 setText 即可。\n" +
      "注：本工具是无障碍版输入（不需要 root/Shizuku）；android_input 需要已授权 Shizuku/root，两者能力不同。",
    parameters: {
      text: { type: "string", required: true, description: "要输入的文本" },
      paste: { type: "boolean", description: "是否用剪贴板粘贴方式输入（WebView/网页输入框建议 true；默认 false 用 setText）" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          focused: { type: "boolean" },
          method: { type: "string" }
        }
      },
      render: (_a, v) => renderResult(v)
    },
    async execute(args, exec) {
      // 空字符串是合法入参（语义 = 清空输入框），只拦真正缺参；用真值判断会把 "" 误判成没传。
      if (args.text === undefined || args.text === null) {
        return { ok: false, error: "android_type 需要 text 参数" };
      }
      const params = { text: String(args.text) };
      if (args.paste === true) params.mode = "paste";
      const raw = await a11yRequest("/input", params, 8000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      return {
        ok: v.ok !== false,
        ...(v.focused !== undefined ? { focused: v.focused === true } : {}),
        ...(v.method ? { method: String(v.method) } : {}),
        ...(v.error ? { error: v.error } : {})
      };
    }
  }));

  // 返回 / 回桌面
  const globalAction = (toolName, actionPath, description) => {
    ctx.tools.register(defineTool({
      name: toolName,
      description,
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            error: { type: "string" }
          }
        },
        render: (_a, v) => renderResult(v)
      },
      async execute(args, exec) {
        const raw = await a11yRequest(actionPath, undefined, 6000);
        const v = parseResult(raw);
        if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
        return { ok: v.ok !== false, ...(v.error ? { error: v.error } : {}) };
      }
    }));
  };
  globalAction("android_back", "/back", "模拟按下系统返回键（回到上一界面）。需要已开启无障碍服务。");
  globalAction("android_home", "/home", "模拟按下系统 Home 键（回到桌面）。需要已开启无障碍服务。");

  // 滚动
  ctx.tools.register(defineTool({
    name: "android_scroll",
    description:
      "在当前可滚动区域滚动屏幕：direction 为 up（向上滚动看更上面内容）/ down / left / right。" +
      "用于翻页、浏览长列表。需要已开启无障碍服务。" +
      "返回 changed（前后读屏对比是否真的滚动了）和 atEdge（没滚动时是到 top/bottom/left/right 边界，不是注入失败），" +
      "不必再补一次 android_screen 比对。",
    parameters: {
      direction: {
        type: "string", required: true, enum: ["up", "down", "left", "right"],
        description: "滚动方向"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          method: { type: "string" },
          // v1.7.1：动作前后对比（区分「真的滚了」「已经到头」「没比成」）
          direction: { type: "string" },
          changed: { type: "boolean" },
          compared: { type: "boolean" },
          atEdge: { type: "string" },
          nodeCountBefore: { type: "number" },
          nodeCountAfter: { type: "number" },
          firstTextBefore: { type: "string" },
          firstTextAfter: { type: "string" }
        }
      },
      render: renderScrollLike("滚动已执行。")
    },
    async execute(args, exec) {
      const direction = String(args.direction || "down");
      const before = await dumpSnapshot(6000);
      const preKey = snapshotKey(before);
      const raw = await a11yRequest("/scroll", { direction }, 8000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      const after = await snapshotAfter(preKey, 350, 2);
      const compared = before.ok && after.ok;
      const changed = compared && snapshotKey(after) !== preKey;
      const out = { ok: true, direction, ...(v.method ? { method: String(v.method) } : {}), compared, changed };
      if (compared) {
        out.nodeCountBefore = before.count;
        out.nodeCountAfter = after.count;
        out.firstTextBefore = firstLabel(before);
        out.firstTextAfter = firstLabel(after);
        if (!changed) out.atEdge = SCROLL_EDGE[direction] || "unknown";
      }
      if (v.error) out.error = String(v.error);
      return out;
    }
  }));

  // 截图（需要 attachments 服务 + 视觉模型）
  ctx.inject(["attachments"], (imageCtx) => {
    imageCtx.tools.register(defineTool({
      name: "android_see",
      description:
        "截取当前屏幕（无障碍截图，无需 MediaProjection 弹窗）并把截图作为图片发送给模型查看。" +
        "适合需要看图理解布局/图片内容、或控件树（android_screen）信息不足时（尤其 Unity/游戏等无控件界面）。" +
        "**截图会被模型查看器缩放，绝对像素坐标会点偏——请优先用分数坐标（fx/fy，0~1）配合 android_tap/android_swipe/android_hold/android_gesture 操作**。" +
        "换算：截图上量到的像素 (px,py) → 屏幕坐标 = (px×scaleX, py×scaleY)（scaleX=screenW/imageW，截图原生分辨率≈屏幕，通常≈1）。" +
        "游戏/无控件界面建议 grid:true 叠加 4×4 网格，按「第几行第几列」定位更准。" +
        "需要当前模型支持图片输入；模型不支持图片时请改用 android_screen 读控件文字。" +
        "需要已开启无障碍服务且设备 Android 11+（截图能力），低版本可用 android_screen。",
      parameters: {
        grid: { type: "boolean", description: "true 时在截图上叠加 4×4 网格线，方便按行列定位（游戏/无控件界面推荐）" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            error: { type: "string" },
            path: { type: "string" },
            screenW: { type: "number" },
            screenH: { type: "number" },
            imageW: { type: "number" },
            imageH: { type: "number" },
            scaleX: { type: "number" },
            scaleY: { type: "number" },
            grid: { type: "number" },
            hint: { type: "string" },
            image: {
              type: "object",
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: { type: "string", required: true },
                bytes: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                name: { type: "string" }
              }
            }
          }
        },
        render: (_args, value) => {
          value = renderValue(value, _args);
          if (!value.ok) return renderResult(value);
          const meta = [
            `${value.image.mediaType} 屏幕截图, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes`,
            `屏幕尺寸 ${value.screenW}x${value.screenH}, 截图尺寸 ${value.imageW}x${value.imageH}, 换算系数 scaleX=${value.scaleX} scaleY=${value.scaleY}${value.grid ? `, 已叠加 ${value.grid}x${value.grid} 网格` : ""}`,
            "操作优先用分数坐标 fx/fy（0~1）：图中位置 (ix,iy) → fx=ix/imageW, fy=iy/imageH；用绝对像素 = 图中像素 × scaleX/Y"
          ].join("\n");
          return [{
            type: "text",
            text: `<path>${value.path}</path>\n<type>image</type>\n<content>\n${meta}\n</content>`
          }, {
            type: "image",
            attachment: {
              attachmentId: value.image.attachmentId,
              mediaType: value.image.mediaType,
              bytes: value.image.bytes,
              width: value.image.width,
              height: value.image.height,
              ...(value.image.name === void 0 ? {} : { name: value.image.name })
            }
          }];
        }
      },
      async execute(args, exec) {
        const attachments = imageCtx.get("attachments");
        if (attachments === void 0) {
          return { ok: false, error: "cannot screenshot: no attachment service is mounted" };
        }
        const params = args.grid === true ? { grid: "4" } : undefined;
        const raw = await a11yRequest("/screenshot", params, 20000);
        const v = parseResult(raw);
        if (!v.ok || !v.path) {
          return { ok: false, error: v.error || "截图失败（可能设备低于 Android 11，或当前页面禁止截图）" };
        }
        let data;
        try {
          data = await readFile(v.path);
        } catch (e) {
          const code = e && e.code ? String(e.code) : "";
          // EACCES 的成因是「截图落在另一个同源包的私有目录」（/data/user/0/<pkg>/ 按 UID 隔离，
          // 跨包必失败）。服务端已改为写入共享目录；这里保留可操作的提示便于在旧包上定位。
          const hint = code === "EACCES"
            ? "\n该截图位于另一个安装包的私有目录（/data/user/0/<包名>/...），跨包按 UID 隔离无法读取。" +
              "请确认无障碍服务与引擎是同一个包。\n临时替代：android_screenshot(save_path=\"/sdcard/DeepSeekHarness/screenshots/x.png\") + read_image。"
            : "";
          return { ok: false, error: "读取截图失败: " + (code ? code + " " : "") + String(e && e.message || e) + hint };
        }
        try {
          const ref = await attachments.saveImage({
            data,
            mediaType: "image/png",
            name: "screen.png"
          });
          return {
            ok: true,
            path: v.path,
            screenW: typeof v.screenW === "number" ? v.screenW : 0,
            screenH: typeof v.screenH === "number" ? v.screenH : 0,
            imageW: typeof v.imageW === "number" ? v.imageW : 0,
            imageH: typeof v.imageH === "number" ? v.imageH : 0,
            scaleX: typeof v.scaleX === "number" ? v.scaleX : 1,
            scaleY: typeof v.scaleY === "number" ? v.scaleY : 1,
            grid: typeof v.grid === "number" ? v.grid : 0,
            ...(typeof v.hint === "string" && v.hint ? { hint: v.hint } : {}),
            image: {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              name: ref.name
            }
          };
        } catch (e) {
          return { ok: false, error: "截图保存为附件失败: " + String(e && e.message || e) };
        }
      }
    }));
  });

  // ===================== v1.7.3 通用触摸手势工具 =====================
  // 底层：无障碍 dispatchGesture 多笔时间轴（真多指）+ willContinue 按住保持。
  // 一套原语覆盖所有触摸操作（点击/滑动/长按/按住拖动/多指同时），不绑定任何具体 App/游戏。
  // 坐标统一支持 x/y（屏幕绝对像素）或 fx/fy（0~1 分数，推荐——截图会被查看器缩放）。

  // 必须与无障碍服务实际返回的字段一致：additionalProperties:false 下漏声明任何一个字段，
  // 整个调用都会被判为 error（数据其实是对的）。服务端会返回 elapsedMs（已按住时长）。
  const heldSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      finger: { type: "number" },
      x: { type: "number" },
      y: { type: "number" },
      fx: { type: "number" },
      fy: { type: "number" },
      elapsedMs: { type: "number" }
    }
  };
  const touchOutput = {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", required: true },
        error: { type: "string" },
        durationMs: { type: "number" },
        held: { type: "array", items: heldSchema }
      }
    },
    render: (_a, v) => renderResult(v)
  };

  // 滑动专用输出（v1.7.1）：在触摸公版字段上加「前后对比」，用来区分「滑到头了」与「手势没生效」。
  const swipeOutput = {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ok: { type: "boolean", required: true },
        error: { type: "string" },
        durationMs: { type: "number" },
        held: { type: "array", items: heldSchema },
        direction: { type: "string" },
        changed: { type: "boolean" },
        compared: { type: "boolean" },
        atEdge: { type: "string" },
        nodeCountBefore: { type: "number" },
        nodeCountAfter: { type: "number" },
        firstTextBefore: { type: "string" },
        firstTextAfter: { type: "string" }
      }
    },
    render: renderScrollLike("滑动已执行。")
  };

  // 滑动
  ctx.tools.register(defineTool({
    name: "android_swipe",
    description:
      "在屏幕上从起点滑动到终点（按下→移动→抬起，单指）。" +
      "参数可用屏幕绝对像素（x1/y1→x2/y2）或分数坐标（fx1/fy1→fx2/fy2，0~1，推荐）。" +
      "durationMs 控制滑动时长（默认 300ms；慢速拖动可加大到 800~1500ms）。" +
      "适合翻页、划动列表、游戏内转向/拖动。需要已开启无障碍服务。" +
      "返回 changed / atEdge：滑动后页面没变化时会指出已到哪一侧边界（上滑到底=bottom），不用再补读屏确认。",
    parameters: {
      x1: { type: "number", description: "起点 x（像素）" },
      y1: { type: "number", description: "起点 y（像素）" },
      x2: { type: "number", description: "终点 x（像素）" },
      y2: { type: "number", description: "终点 y（像素）" },
      fx1: { type: "number", description: "起点分数 x（0~1，推荐）" },
      fy1: { type: "number", description: "起点分数 y（0~1，推荐）" },
      fx2: { type: "number", description: "终点分数 x（0~1，推荐）" },
      fy2: { type: "number", description: "终点分数 y（0~1，推荐）" },
      durationMs: { type: "number", description: "滑动时长毫秒（默认 300）" },
      finger: { type: "number", description: "可选：指定手指（0~7）；若该手指正按住则从当前位置滑到终点并抬起" }
    },
    output: swipeOutput,
    async execute(args, exec) {
      const params = {};
      for (const k of ["x1", "y1", "x2", "y2", "fx1", "fy1", "fx2", "fy2"]) {
        if (args[k] !== undefined) params[k] = String(Number(args[k]));
      }
      if (args.durationMs !== undefined) params.duration = String(Number(args.durationMs));
      if (args.finger !== undefined) params.finger = String(Number(args.finger));
      if (!(("x1" in params || "fx1" in params) && ("y1" in params || "fy1" in params) &&
            ("x2" in params || "fx2" in params) && ("y2" in params || "fy2" in params))) {
        return { ok: false, error: "android_swipe 需要起点(x1/y1 或 fx1/fy1)和终点(x2/y2 或 fx2/fy2)" };
      }
      const before = await dumpSnapshot(6000);
      const preKey = snapshotKey(before);
      const raw = await a11yRequest("/swipe", params, 12000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      const after = await snapshotAfter(preKey, 350, 2);
      const compared = before.ok && after.ok;
      const changed = compared && snapshotKey(after) !== preKey;
      const direction = swipeDirection(args);
      const out = {
        ok: true,
        direction,
        ...(typeof v.durationMs === "number" ? { durationMs: v.durationMs } : {}),
        ...(Array.isArray(v.held) ? { held: v.held } : {}),
        compared,
        changed
      };
      if (compared) {
        out.nodeCountBefore = before.count;
        out.nodeCountAfter = after.count;
        out.firstTextBefore = firstLabel(before);
        out.firstTextAfter = firstLabel(after);
        if (!changed) out.atEdge = SWIPE_EDGE[direction] || "unknown";
      }
      return out;
    }
  }));

  // 长按 / 按住指定时长后自动抬起
  ctx.tools.register(defineTool({
    name: "android_hold",
    description:
      "在指定位置按住（长按）durationMs 毫秒后自动抬起，也可用 finger 指定手指。" +
      "**需要一直按住不放（延续到后续操作）时，不要用本工具，改用 android_touch action=down**（down 后手指保持按住，可跨调用延续）。" +
      "适合长按图标、游戏蓄力、按住等待等。需要已开启无障碍服务。",
    parameters: {
      x: { type: "number", description: "按住 x（像素）" },
      y: { type: "number", description: "按住 y（像素）" },
      fx: { type: "number", description: "分数 x（0~1，推荐）" },
      fy: { type: "number", description: "分数 y（0~1，推荐）" },
      durationMs: { type: "number", description: "按住时长毫秒（默认 500）" },
      finger: { type: "number", description: "可选：指定手指（0~7）" }
    },
    output: touchOutput,
    async execute(args, exec) {
      const params = {};
      for (const k of ["x", "y", "fx", "fy"]) {
        if (args[k] !== undefined) params[k] = String(Number(args[k]));
      }
      if (args.durationMs !== undefined) params.duration = String(Number(args.durationMs));
      if (args.finger !== undefined) params.finger = String(Number(args.finger));
      if (!(("x" in params || "fx" in params) && ("y" in params || "fy" in params))) {
        return { ok: false, error: "android_hold 需要 x/y 或 fx/fy" };
      }
      const raw = await a11yRequest("/hold", params, 12000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      return { ok: true, ...(Array.isArray(v.held) ? { held: v.held } : {}) };
    }
  }));

  // 状态式虚拟触摸屏（多指核心）
  ctx.tools.register(defineTool({
    name: "android_touch",
    description:
      "虚拟触摸屏状态式控制：action=down（按下并保持）/ move（按住的手指滑到新位置）/ up（抬起）。" +
      "每根手指用 finger 编号（0~7）区分，多根手指可同时按住——多指操作的基础。" +
      "**典型用法：按住摇杆 = down(0) 在摇杆位置，然后 move(0) 拖动控制方向，松开 = up(0)**。" +
      "down 之后手指一直按住，直到你 up / android_touch_status 确认 / 超时（30s）自动抬起。" +
      "跨调用延续：down(0) 后可直接调 android_tap/android_gesture 等，按住的手指不会被松开（自动并入后续手势）。" +
      "坐标支持 x/y 或 fx/fy（0~1，推荐）。需要已开启无障碍服务。",
    parameters: {
      action: { type: "string", required: true, enum: ["down", "move", "up"], description: "down=按下保持 / move=按住移动 / up=抬起" },
      finger: { type: "number", required: true, description: "手指编号 0~7（多指的关键：每根手指一个编号）" },
      x: { type: "number", description: "目标 x（像素）" },
      y: { type: "number", description: "目标 y（像素）" },
      fx: { type: "number", description: "分数 x（0~1，推荐）" },
      fy: { type: "number", description: "分数 y（0~1，推荐）" }
    },
    output: touchOutput,
    async execute(args, exec) {
      if (!args.action) return { ok: false, error: "android_touch 需要 action=down|move|up" };
      if (args.finger === undefined) return { ok: false, error: "android_touch 需要 finger=0~7" };
      const params = { action: String(args.action), finger: String(Number(args.finger)) };
      for (const k of ["x", "y", "fx", "fy"]) {
        if (args[k] !== undefined) params[k] = String(Number(args[k]));
      }
      const raw = await a11yRequest("/touch", params, 12000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      return { ok: true, ...(Array.isArray(v.held) ? { held: v.held } : {}) };
    }
  }));

  // 组合手势（多笔时间轴，一次全部注入）
  ctx.tools.register(defineTool({
    name: "android_gesture",
    description:
      "一次执行一组多指手势（底层多笔时间轴，全部同时注入，真多指）。strokes 数组按顺序在时间轴上执行，支持：\n" +
      "- down: 按下并保持 {kind:'down', finger, x/y 或 fx/fy}\n" +
      "- move: 按住的手指滑到新位置 {kind:'move', finger, x/y 或 fx/fy}\n" +
      "- up: 抬起 {kind:'up', finger}\n" +
      "- tap: 点按 {kind:'tap', x/y 或 fx/fy, [finger], [durationMs]}\n" +
      "- swipe: 滑动 {kind:'swipe', x/y 或 fx/fy → x2/y2 或 fx2/fy2, [durationMs]}\n" +
      "- hold: 按下→保持 durationMs→抬起 {kind:'hold', x/y 或 fx/fy, [durationMs], [finger]}\n" +
      "- wait: 等待 {kind:'wait', ms}\n" +
      "**典型游戏场景：左手按住摇杆同时右手点击 = [down(0, 摇杆), tap(1, 按钮)]**；按住摇杆拖动 = [down(0, 摇杆中心), move(0, 目标方向)]。" +
      "down 的手指在请求结束后继续保持（可跨请求延续），直到 up / 超时自动抬起。" +
      "坐标全部支持 fx/fy（0~1，推荐）。需要已开启无障碍服务。",
    parameters: {
      strokes: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", required: true, enum: ["down", "move", "up", "tap", "swipe", "hold", "wait"], description: "笔类型" },
            finger: { type: "number", description: "手指编号 0~7" },
            x: { type: "number", description: "目标 x（像素）" },
            y: { type: "number", description: "目标 y（像素）" },
            fx: { type: "number", description: "分数 x（0~1，推荐）" },
            fy: { type: "number", description: "分数 y（0~1，推荐）" },
            x2: { type: "number", description: "swipe 终点 x（像素）" },
            y2: { type: "number", description: "swipe 终点 y（像素）" },
            fx2: { type: "number", description: "swipe 终点分数 x（0~1）" },
            fy2: { type: "number", description: "swipe 终点分数 y（0~1）" },
            durationMs: { type: "number", description: "时长（wait=等待毫秒；tap 默认60；swipe 默认300；hold 默认500；move/up 默认100）" },
            ms: { type: "number", description: "wait 的等待毫秒" }
          }
        },
        description: "手势笔列表（按顺序在时间轴上执行）"
      }
    },
    output: touchOutput,
    async execute(args, exec) {
      const strokes = args.strokes;
      if (!Array.isArray(strokes) || strokes.length === 0) {
        return { ok: false, error: "android_gesture 需要 strokes 数组" };
      }
      const ALLOWED = ["kind", "finger", "x", "y", "fx", "fy", "x2", "y2", "fx2", "fy2", "durationMs", "ms"];
      const clean = [];
      let total = 0;
      for (const s of strokes) {
        if (!s || typeof s !== "object") return { ok: false, error: "strokes 元素必须是对象" };
        const kind = s.kind;
        const dur = typeof s.durationMs === "number" ? s.durationMs : 0;
        if (kind === "wait") total += typeof s.ms === "number" && s.ms > 0 ? s.ms : 0;
        else if (kind === "tap") total += dur > 0 ? dur : 60;
        else if (kind === "swipe") total += dur > 0 ? dur : 300;
        else if (kind === "hold") total += dur > 0 ? dur : 500;
        else if (kind === "move") total += dur > 0 ? dur : 100;
        else if (kind === "up") total += dur > 0 ? dur : 100;
        else if (kind !== "down") return { ok: false, error: "未知 kind: " + String(kind) };
        const o = {};
        for (const k of Object.keys(s)) {
          if (ALLOWED.includes(k)) o[k] = s[k];
        }
        clean.push(o);
      }
      const raw = await a11yPost("/gesture", clean, total + 15000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      return {
        ok: true,
        ...(typeof v.durationMs === "number" ? { durationMs: v.durationMs } : {}),
        ...(Array.isArray(v.held) ? { held: v.held } : {})
      };
    }
  }));

  // 触摸状态查询
  ctx.tools.register(defineTool({
    name: "android_touch_status",
    description:
      "查询当前按住的手指（虚拟触摸屏状态）。用于确认之前 down 的手指是否还在按住、坐标在哪、按住多久。" +
      "手指按住超过 30 秒会被自动抬起（安全机制）。需要已开启无障碍服务。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string" },
          screenW: { type: "number" },
          screenH: { type: "number" },
          maxFingers: { type: "number" },
          holdTimeoutMs: { type: "number" },
          held: { type: "array", items: heldSchema }
        }
      },
      render: (_a, v) => renderTouchStatus(v)
    },
    async execute(args, exec) {
      const raw = await a11yRequest("/touch-status", undefined, 6000);
      const v = parseResult(raw);
      if (!v.ok) return { ok: false, error: v.error || GUIDE_TEXT };
      return {
        ok: true,
        screenW: typeof v.screenW === "number" ? v.screenW : 0,
        screenH: typeof v.screenH === "number" ? v.screenH : 0,
        maxFingers: typeof v.maxFingers === "number" ? v.maxFingers : 0,
        holdTimeoutMs: typeof v.holdTimeoutMs === "number" ? v.holdTimeoutMs : 0,
        held: Array.isArray(v.held) ? v.held : []
      };
    }
  }));
}

export { apply, inject, name };
