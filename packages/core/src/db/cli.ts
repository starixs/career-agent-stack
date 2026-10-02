import { openDb, defaultDbPath } from './db.js'
const cmd = process.argv[2]
if (cmd === 'init') {
  const db = openDb()
  console.log('数据库已初始化:', defaultDbPath())
  db.close()
} else {
  console.error('用法: tsx src/db/cli.ts init')
  process.exit(1)
}
