// 客户端半边的冒烟测试（不启动 DSH）：
// 用假的 window.__ModuleLoader__ 和假 React 把 client.js 跑一遍，
// 验证 1) 工厂返回了带 apply 的插件 2) apply 真的把两个座位注册上了。
import { readFileSync } from 'node:fs'

const 源 = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

let 抓到 = null
const 假window = { __ModuleLoader__: { load: (x) => { 抓到 = x } } }

const 假React = {
  createElement: (类型, 属性, ...子) => ({ 类型, 属性, 子 }),
  useState: (初) => [初, () => {}],
  useEffect: () => {},
  useRef: (初) => ({ current: 初 }),
  useCallback: (f) => f,
}

new Function('window', 'require', 源)(假window, (名) => {
  if (名 === 'react') return 假React
  throw new Error('不需要的模块：' + 名)
})

const 问题 = []
if (!抓到) 问题.push('没有调用 window.__ModuleLoader__.load')
else {
  if (抓到.id !== 'dsh-weather-care') 问题.push(`id 不对：${抓到.id}`)
  const 插件 = 抓到.factory((名) => (名 === 'react' ? 假React : {}))
  if (!插件) 问题.push('工厂没有返回插件')
  else {
    if (typeof 插件.apply !== 'function') 问题.push('插件上没有 apply 函数')
    if (!Array.isArray(插件.inject) || !插件.inject.includes('slots')) 问题.push('inject 里没有 slots')
    if (typeof 插件.apply === 'function') {
      const 座位 = []
      const 注册 = []
      const 假ctx = {
        get: () => undefined,
        slots: {
          inject: (名, 回调) => { 座位.push(名); return 回调() },
          register: (规格, 组件) => {
            注册.push({ 座位: 规格.name, id: 规格.id, key: 规格.key, 有组件: typeof 组件 === 'function' })
            return () => {}
          },
        },
      }
      try {
        插件.apply(假ctx)
      } catch (e) {
        问题.push('apply 跑起来报错：' + e.message)
      }
      const 左栏 = 座位.includes('sidebar.panellist')
      const 主面板 = 座位.includes('main')
      if (!左栏) 问题.push('没有往 sidebar.panellist 登记')
      if (!主面板) 问题.push('没有往 main 登记')
      const 条 = 注册.find((r) => r.座位 === 'sidebar.panellist')
      const 页 = 注册.find((r) => r.座位 === 'main')
      if (!条 || 条.id !== 'weather') 问题.push('左栏条目的 id 不是 weather')
      if (!页 || 页.key !== 'weather') 问题.push('主面板的 key 不是 weather')
      if (!条 || !条.有组件) 问题.push('左栏没有组件')
      if (!页 || !页.有组件) 问题.push('主面板没有组件')
      console.log('座位：' + 座位.join(', '))
      console.log('注册：' + JSON.stringify(注册))
    }
  }
}

if (问题.length) {
  console.log('✗ 有问题：')
  for (const p of 问题) console.log('  - ' + p)
  process.exit(1)
}
console.log('✓ 客户端半边通过冒烟测试')
