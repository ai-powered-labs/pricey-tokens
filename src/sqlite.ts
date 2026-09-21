// sqlite.ts — SQLite 只读访问的运行时适配层 (零依赖跨运行时)
// 职责边界: 统一 "打开库文件 → 按列名查行" 的最小接口面; bun 下走 bun:sqlite (CLI 的
// 钦点通道), node ≥22.5 下走 node:sqlite (npx 场景), 两者都不可用时抛带指引的错误
// (调用方按单源失败处理, 不拖垮其他源)。
// 只读姿态: 先 readonly 打开 (绝不写用户库); WAL 库需恢复时 readonly 会失败, 回退
// 常规模式 (本包只执行 SELECT, 无写入语句)。
// 行形态: 两运行时 prepare().all() 均返回对象数组 (列名 → 值), 本层直传不转换。

export interface SqliteDb {
  /** 执行 SQL (仅 PRAGMA/SELECT), 返回对象行数组; 无行集语句 (PRAGMA table_info 恒有行) */
  all(sql: string): Array<Record<string, unknown>>;
  close(): void;
}

interface MinimalDb {
  prepare(sql: string): {all(): unknown[]};
  close(): void;
}

async function openRaw(path: string, readonly: boolean): Promise<MinimalDb> {
  if (typeof process !== "undefined" && process.versions.bun) {
    const {Database} = await import("bun:sqlite");
    return new Database(path, readonly ? {readonly: true} : undefined) as unknown as MinimalDb;
  }
  try {
    const {DatabaseSync} = await import("node:sqlite");
    // node:sqlite 命名差异: readOnly (node) vs readonly (bun); 两构造器互不认对方拼写
    return new (DatabaseSync as unknown as new (p: string, o?: {readOnly?: boolean}) => MinimalDb)(path, readonly ? {readOnly: true} : undefined);
  } catch (e) {
    throw new Error(
      `SQLite 不可用: 需要 bun (内置 bun:sqlite) 或 node ≥ 22.5 (内置 node:sqlite) 才能读取 opencode 数据库。当前运行时: ${typeof process !== "undefined" ? process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}` : "unknown"} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

export async function openSqlite(path: string): Promise<SqliteDb> {
  let db: MinimalDb;
  try {
    db = await openRaw(path, true);
  } catch {
    db = await openRaw(path, false); // WAL 待恢复等场景的回退 (仍只执行 SELECT)
  }
  return {
    all: (sql) => db.prepare(sql).all() as Array<Record<string, unknown>>,
    close: () => db.close(),
  };
}
