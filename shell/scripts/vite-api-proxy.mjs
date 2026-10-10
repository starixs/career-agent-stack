// Vite 开发服务器的 /api 代理规则：/api/ 下的后端接口转发给 localhost:3000，
// 但 src/renderer/api/*.ts 这类源码模块必须由 Vite 自己编译。
//
// 匹配对象是带查询串的 req.url。HMR 之后模块会以 `/api/spaceCloud.ts?t=…`、
// `?import` 的形式被请求，所以扩展名后面必须允许跟查询串——否则这些源码请求会被
// 转发到 3000 端口拿到 500，整个 App 懒加载失败、落进「界面渲染出错」。
export const API_PROXY_PATTERN = '^/api/(?!.*\\.(?:ts|tsx|js|jsx)(?:\\?.*)?$)';
