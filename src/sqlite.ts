// sqlite.ts — SQLite 访问的运行时适配层 (零依赖跨运行时)
// 职责边界: 统一 "打开库文件 → 按列名查行 / 预编译执行" 的最小接口面, 双通道:
//   - 只读通道 openSqlite: 读**用户源库** (opencode 等), 绝不写 — 先 readonly 打开,
//     WAL 库需恢复时 readonly 会失败, 回退常规模式 (本通道只执行 SELECT)。
//   - 写通道 createSqlite: 建/开**本包自有库** (requests 账本), 预编译语句 + 事务
//     控制; 严禁用于用户源库。
// bun 下走 bun:sqlite (CLI 的钦点通道), node ≥22.5 下走 node:sqlite (npx 场景),
// 两者都不可用时抛带指引的错误 (调用方按单源失败处理, 不拖垮其他源)。
// 行形态: 两运行时 prepare().all() 均返回对象数组 (列名 → 值), 本层直传不转换。

export interface SqliteDb {
  /** 执行 SQL (仅 PRAGMA/SELECT), 可带 ? 占位符参数; 返回对象行数组 */
  all(sql: string, ...params: unknown[]): Array<Record<string, unknown>>;
  close(): void;
}

// 写通道的预编译语句句柄 (all 支持多次取行; run 变参绑定, 两运行时同构)
export interface SqliteStmt {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): void;
}

export interface SqliteRwDb {
  /** 预编译单条 SQL (调用方复用句柄循环执行 — 50 万行级批量写入的必要姿态) */
  prepare(sql: string): SqliteStmt;
  /** 多语句原样执行 (DDL / BEGIN / COMMIT 等事务控制) */
  exec(sql: string): void;
  close(): void;
}

interface MinimalStmt {
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface MinimalDb {
  prepare(sql: string): MinimalStmt;
  exec(sql: string): void;
  close(): void;
}

async function openRaw(path: string, readonly: boolean): Promise<MinimalDb> {
  if (typeof process !== "undefined" && process.versions.bun) {
    const {Database} = await import("bun:sqlite");
    return (readonly ? new Database(path, {readonly: true}) : new Database(path)) as unknown as MinimalDb;
  }
  try {
    const {DatabaseSync} = await import("node:sqlite");
    // node:sqlite 命名差异: readOnly (node) vs readonly (bun); 且 node 严禁
    // options 传 undefined (双参形态要求 options 为对象) — 只读/写走各自单形态
    return readonly
      ? (new (DatabaseSync as unknown as new (p: string, o: {readOnly: boolean}) => MinimalDb)(path, {readOnly: true}))
      : (new (DatabaseSync as unknown as new (p: string) => MinimalDb)(path));
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
    // WAL 待恢复等场景的回退 (仍只执行 SELECT)。回退前确认文件存在 — rw 模式打开
    // 不存在的路径会静默创建空库, 违反本通道 "绝不写用户源库" 的契约
    const {stat} = await import("node:fs/promises");
    await stat(path);
    db = await openRaw(path, false);
  }
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
    close: () => db.close(),
  };
}

// 写通道: 打开 (不存在则创建) 本包自有库。目录须已存在 (调用方 mkdir — 路径策略
// 归调用方, 本层只管文件)。
export async function createSqlite(path: string): Promise<SqliteRwDb> {
  const db = await openRaw(path, false);
  return {
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        all: (...p) => stmt.all(...p) as Array<Record<string, unknown>>,
        run: (...p) => {
          stmt.run(...p);
        },
      };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}
