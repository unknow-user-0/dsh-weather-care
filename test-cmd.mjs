// 指令解析的本地自测：不联网、不碰 DSH，只验证 */xxx 的识别
import { pathToFileURL } from 'node:url'
const { __test } = await import(new URL('./lib/index.js', import.meta.url).href)

const { 解析指令: 析, 说开 } = __test
let 过 = 0
let 败 = 0
const 验 = (名, 得, 要) => {
  const ok = JSON.stringify(得) === JSON.stringify(要)
  if (ok) 过++
  else { 败++; console.log('✗', 名, '得', JSON.stringify(得), '要', JSON.stringify(要)) }
}

验('位置', 析('*/位置 杭州'), { 令: '位置', 参: '杭州' })
验('带空格', 析('* / 早报  07:30 '), { 令: '早报', 参: '07:30' })
验('星号包起来', 析('*晚报 21:00*'), { 令: '晚报', 参: '21:00' })
验('中文括号', 析('【突变 开】'), { 令: '突变', 参: '开' })
验('无参', 析('*/状态'), { 令: '状态', 参: '' })
验('多词参数', 析('*/位置 浙江 杭州'), { 令: '位置', 参: '浙江 杭州' })
验('普通聊天', 析('今天好热啊'), null)
验('空', 析('   '), null)
验('只有斜杠', 析('*/'), null)
验('说开 开', 说开('开', false), true)
验('说开 关', 说开('关', true), false)
验('说开 空值取反', 说开('', true), false)

console.log(败 ? `✗ ${败} 个没过 / ${过} 个过` : `✓ 全部 ${过} 个通过`)
process.exit(败 ? 1 : 0)
