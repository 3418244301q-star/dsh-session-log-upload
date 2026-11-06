/**
 * app.asar 读取器（只读、无依赖）。
 *
 * 背景：`app.asar/dsh/...` 这种目录形式是虚拟路径，Node 和 shell 都打不开；
 * 但 asar 本体是「8 字节前缀 + JSON 目录 + 连续文件块」的 pickle，按偏移读完全可行。
 * 这里把这段解析集中一次，避免每个脚本各抄一份、抄出不同解法。
 *
 * 布局（实测 @ 0.2.2-rc.1）：
 *   [0..4) = 4（头部长度的长度）
 *   [4..8) = 头部 JSON 的总长
 *   [8..)  = 头部块；块内前 8 字节又是长度字段，JSON 正文从块内偏移 8 开始
 *   内容基址 = 8 + 头部总长
 *
 * 用法：
 *   const asar = openAsar();
 *   asar.read('dsh/node_modules/@deepseek-ai/dsh/package.json')
 *   asar.version('dsh/node_modules/@deepseek-ai/dsh/package.json')   // → '0.2.2-rc.1'
 *   asar.find('settings.general.item')   // → [{ file, package, count }]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认安装位置；`DSH_ASAR` 可覆盖（安装到别处时用）。 */
export function defaultAsarPath() {
  return process.env.DSH_ASAR ?? path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Programs/DeepSeek Harness/resources/app.asar',
  );
}

/** 从条目路径里取出所属包：`.../node_modules/@deepseek-ai/x/lib/index.js` → `@deepseek-ai/x`。 */
function packageOf(p) {
  const parts = p.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return parts.slice(0, -1).join('/') || '(root)';
  const rest = parts.slice(at + 1);
  return rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/** 一个 buffer 里某串出现的次数。 */
function countAll(buffer, target) {
  let count = 0;
  let at = buffer.indexOf(target);
  while (at >= 0) {
    count += 1;
    at = buffer.indexOf(target, at + 1);
  }
  return count;
}

export function openAsar(file = defaultAsarPath()) {
  if (!fs.existsSync(file)) {
    const error = new Error(`找不到 app.asar：${file}\n用 DSH_ASAR 环境变量指定 DSH 安装目录下的 app.asar。`);
    error.code = 'ASAR-MISSING';
    throw error;
  }

  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  const headerSize = head.readUInt32LE(4);
  const block = Buffer.alloc(headerSize);
  fs.readSync(fd, block, 0, headerSize, 8);
  const root = JSON.parse(block.toString('utf8', 8, 8 + block.readUInt32LE(4)));
  const base = 8 + headerSize;

  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, info] of Object.entries(node.files ?? {})) {
      const p = prefix === '' ? name : `${prefix}/${name}`;
      if (info.files) walk(info, p);
      else if (info.offset !== undefined) {
        entries.push({ path: p, offset: Number(info.offset), size: Number(info.size) });
      }
    }
  };
  walk(root, '');
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  return {
    file,
    base,
    entries: () => entries.slice(),
    has: (p) => byPath.has(p),

    /** 读一个文件的原始字节；不存在返回 null。 */
    bytes(p) {
      const entry = byPath.get(p);
      if (entry === undefined) return null;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, base + entry.offset);
      return buffer;
    },

    /** 读一个文件的文本；不存在返回 null。 */
    read(p) {
      const buffer = this.bytes(p);
      return buffer === null ? null : buffer.toString('utf8');
    },

    /** 读一个 package.json 的 version；读不到返回 null。 */
    version(p) {
      const text = this.read(p);
      if (text === null) return null;
      try {
        return JSON.parse(text).version ?? null;
      } catch {
        return null;
      }
    },

    /**
     * 全包搜索一个字符串，返回按所属包聚合的命中：
     * `[{ package, files: [{ path, count }] }]`，找不到返回 []。
     * 之所以要「全部命中」而不是第一个：客户端契约可能只存在于客户端插件包，
     * 只扫 shell bundle 会得到假阴性。
     */
    /**
     * 扫一个字符串，返回按所属包聚合的命中：`[{ package, files: [{ path, count }] }]`。
     * 之所以「逐文件读」而不是整包 indexOf：整包 213MB 的镜像在某些环境下读到的是空洞，
     * 会安静地搜不到（踩过一次）。逐文件读慢一点，但结果与 `grep -a` 一致。
     * 之所以要「全部命中」而不是第一个：客户端契约只存在于客户端插件包，
     * 只扫 shell bundle 会得到假阴性。
     */
    find(needle) {
      const target = Buffer.from(needle, 'utf8');
      const grouped = new Map();
      for (const entry of entries) {
        if (entry.size === 0 || entry.size > 16 << 20) continue;
        if (!/\.(?:js|cjs|mjs|json|html|css)$/.test(entry.path)) continue;
        const buffer = Buffer.alloc(entry.size);
        fs.readSync(fd, buffer, 0, entry.size, base + entry.offset);
        const count = buffer.indexOf(target) < 0 ? 0 : countAll(buffer, target);
        if (count === 0) continue;
        const pkg = packageOf(entry.path);
        const list = grouped.get(pkg) ?? [];
        list.push({ path: entry.path, count });
        grouped.set(pkg, list);
      }
      return [...grouped.entries()].map(([pkg, files]) => ({
        package: pkg,
        files: files.sort((a, b) => b.count - a.count),
      }));
    },

    close() {
      fs.closeSync(fd);
    },
  };
}
