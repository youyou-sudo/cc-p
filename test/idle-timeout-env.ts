// test/idle-timeout-env.ts — Issue #19 env 解析快速验证（无 30s 真等待，总耗时 <15s）。
// 契约：CC_STREAM_IDLE_MS 默认 30000、CC_NONSTREAM_IDLE_MS 默认 90000、
// CC_THINKING_IDLE_MS 默认 120000；unset/空 → 默认；非数字 → 进程 exit(1)；<=0 → 回默认。
// 每个用例独立子进程（env 继承隔离），import src/shared/config.ts 并打印三个常量。
// 现有 test/timeouts.ts 的 30s 断言保持不动，默认行为由它继续覆盖。
// 思考宽限说明：start 后挂起在新契约下期望超时变为 120s（THINKING_IDLE_TIMEOUT_MS），
// timeouts.ts 仍用 28–35s 断言覆盖“非思考期（空 lastCcEvent）仍 30s 快速失败”路径——不要改成真实等待 120s 的用例。

const ROOT = import.meta.dir + "/..";
const PROBE = `import { STREAM_IDLE_TIMEOUT_MS, NONSTREAM_IDLE_TIMEOUT_MS, THINKING_IDLE_TIMEOUT_MS } from "./src/shared/config.ts"; console.log(JSON.stringify({ s: STREAM_IDLE_TIMEOUT_MS, n: NONSTREAM_IDLE_TIMEOUT_MS, t: THINKING_IDLE_TIMEOUT_MS }));`;

const dec = new TextDecoder();

interface ProbeResult {
  code: number;
  out: string;
  err: string;
}

function runProbe(overrides: Record<string, string | undefined>): ProbeResult {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  // 继承隔离：子进程只覆盖传入的 key，未传的 THINKING key 沿用父进程 env——
  // 用例中显式传入 CC_THINKING_IDLE_MS: undefined 删除它，保证默认值断言不受外部 env 污染。
  const res = Bun.spawnSync([process.execPath, "-e", PROBE], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: res.exitCode,
    out: dec.decode((res.stdout ?? new Uint8Array()) as Uint8Array).trim(),
    err: dec.decode((res.stderr ?? new Uint8Array()) as Uint8Array).trim(),
  };
}

function parseOut(out: string): { s: unknown; n: unknown; t: unknown } | null {
  try {
    return JSON.parse(out) as { s: unknown; n: unknown; t: unknown };
  } catch {
    return null;
  }
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

// (a) 无 env → 30000 90000 120000
{
  const r = runProbe({ CC_STREAM_IDLE_MS: undefined, CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: undefined });
  const v = parseOut(r.out);
  check("unset → 30000/90000/120000", r.code === 0 && v?.s === 30000 && v?.n === 90000 && v?.t === 120000, r);
}

// (b) CC_STREAM_IDLE_MS=60000 CC_NONSTREAM_IDLE_MS=120000 → 60000 120000（thinking 保持默认 120000）
{
  const r = runProbe({ CC_STREAM_IDLE_MS: "60000", CC_NONSTREAM_IDLE_MS: "120000", CC_THINKING_IDLE_MS: undefined });
  const v = parseOut(r.out);
  check("custom → 60000/120000", r.code === 0 && v?.s === 60000 && v?.n === 120000 && v?.t === 120000, r);
}

// (b2) CC_THINKING_IDLE_MS=180000 → thinking 180000（stream/non-stream 不受影响）
{
  const r = runProbe({ CC_STREAM_IDLE_MS: undefined, CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: "180000" });
  const v = parseOut(r.out);
  check("thinking custom → 180000", r.code === 0 && v?.t === 180000 && v?.s === 30000 && v?.n === 90000, r);
}

// (c) CC_STREAM_IDLE_MS=0 → 30000（<=0 回默认）
{
  const r = runProbe({ CC_STREAM_IDLE_MS: "0", CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: undefined });
  const v = parseOut(r.out);
  check("0 → default 30000", r.code === 0 && v?.s === 30000, r);
}

// (c2) CC_THINKING_IDLE_MS=0 → 120000（<=0 回默认）
{
  const r = runProbe({ CC_STREAM_IDLE_MS: undefined, CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: "0" });
  const v = parseOut(r.out);
  check("thinking 0 → default 120000", r.code === 0 && v?.t === 120000, r);
}

// (d) CC_STREAM_IDLE_MS=abc → 子进程非零退出
{
  const r = runProbe({ CC_STREAM_IDLE_MS: "abc", CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: undefined });
  check("abc → non-zero exit", r.code !== 0, r);
}

// (d2) CC_THINKING_IDLE_MS=abc → 子进程非零退出
{
  const r = runProbe({ CC_STREAM_IDLE_MS: undefined, CC_NONSTREAM_IDLE_MS: undefined, CC_THINKING_IDLE_MS: "abc" });
  check("thinking abc → non-zero exit", r.code !== 0, r);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

export {};
