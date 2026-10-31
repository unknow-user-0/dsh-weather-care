// 私聊目标 / 消息段解析的离线自测：不联网、不往真 QQ 发消息
import { __test } from './lib/index.js'

const ok = (名, 条件, 附 = '') => {
  console.log(`${条件 ? '✓' : '✗'} ${名}${附 ? '：' + 附 : ''}`)
  if (!条件) process.exitCode = 1
}

// 1) 号单：数组/字符串/脏数据都能收成干净号码
ok('号单 数组', JSON.stringify(__test.号单(['123456789', '987654321'])) === '["123456789","987654321"]')
ok('号单 字符串', JSON.stringify(__test.号单('123456789，987654321、9999')) === '["123456789","987654321","9999"]')
ok('号单 去脏', JSON.stringify(__test.号单(['abc', '', null, '123'])) === '[]')
ok('号单 去重', JSON.stringify(__test.号单(['123456789', '123456789'])) === '["123456789"]')

// 2) 解析QQ目标s：只认私聊；地址去掉尾斜杠
const 甲 = __test.解析QQ目标s({
  qqNapcat: 'http://127.0.0.1:3000/',
  qqToken: 't',
  qqUsers: ['123456789', '123456789'],
})
ok('目标 地址去尾斜杠', 甲.base === 'http://127.0.0.1:3000', 甲.base)
ok('目标 令牌', 甲.token === 't')
ok('目标 数量 1（去重）', 甲.号们.length === 1, JSON.stringify(甲.号们))

// 3) 消息段拼接：文本留下，表情/图片这类丢掉
ok('段文本 拼接', __test.段文本([{ type: 'text', data: { text: '你好' } }, { type: 'face', data: { id: 1 } }]) === '你好')

// 4) 指令解析
const 析 = __test.解析指令
ok('指令 */位置 杭州', JSON.stringify(析('*/位置 杭州')) === JSON.stringify({ 令: '位置', 参: '杭州' }))
ok('指令 *早报 07:30*', JSON.stringify(析('*早报 07:30*')) === JSON.stringify({ 令: '早报', 参: '07:30' }))
ok('指令 不是指令', 析('今天天气不错') === null)

console.log(process.exitCode ? '✗ 有问题' : '✓ 全部通过')
