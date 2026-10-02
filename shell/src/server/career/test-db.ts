/**
 * 测试辅助：内存 SQLite + @career/core Repos。只给 *.unit.test.ts 使用。
 */
import { Db, Repos } from '@career/core';

export function createMemoryRepos(): Repos {
  const db = new Db(':memory:');
  db.migrate();
  return new Repos(db);
}
