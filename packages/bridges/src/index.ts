/**
 * @career/bridges：把 Python 模块与外部数据源接成 TypeScript 可调用的服务。
 * - trident：岗位采集/评分（HTTP + 子进程）
 * - docparse：文档 → Markdown/JSON（CLI）；extractPdfLinks 作 PDF 超链接兜底
 * - repoMiner：纯 TS 的代码证据挖掘（git + LLM + 真实性规则）
 * - intelCompass：公司背调九段报告（HTTP + 子进程）
 * - webSearch：博查 / Tavily / Serper
 * - campusRadar：校招静态数据
 */
export * from './common.js'
export * from './trident.js'
export * from './docparse.js'
export * from './repoMiner.js'
export * from './intelCompass.js'
export * from './webSearch.js'
export * from './campusRadar.js'
