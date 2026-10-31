/**
 * dsh-weather —— 让 DSH 自己感知天气
 * ============================================================================
 * 三件事：
 *   ① 每轮上下文里带一行「现在 / 今天 / 未来几小时」的实时天气（不用调工具就知道）；
 *   ② 一个 `weather` 工具，想看更细的（逐小时、好几天的）随时能查；
 *   ③ 早上到点播一句、天气突变时说一声 —— 这两件是它自己醒过来讲的，
 *      不靠用户问。
 *
 * 数据源：Open-Meteo（免密钥、HTTPS、WMO 天气代码）+ ipwho.is 定位（IP 自动）。
 * 边界：网络失败一律降级成「这一轮没有天气」，绝不影响对话。
 * ============================================================================
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

export const name = 'weather'
// 硬依赖：缺一个就整条不激活（也就不会假装能用）。
// webServer 必须写在这里 —— 新版本 DSH 只有声明进 inject 的服务才会挂到 ctx 上，
// 光用 ctx.get('webServer') 会拿到 null，控制台路由就静默不注册（其余功能照常，很难发现）。
export const inject = ['agents', 'tools', 'systemPrompt', 'webServer']

// ── 时间常量 ────────────────────────────────────────────────────────────────
const TTL_MS = 15 * 60 * 1000        // 天气快照多久算旧
const PLACE_TTL_MS = 12 * 60 * 60 * 1000 // 定位结果多久算旧
const MOUNT_MS = 3000                // 挂 agent / 工具的心跳
const LOOP_MS = 60 * 1000            // 检查「该不该说句话」的心跳
const FETCH_TIMEOUT_MS = 9000

// ── 默认配置（可以用 ~/.dsh/weather-plugin.json 覆盖）────────────────────────
const DEFAULTS = {
  briefEnabled: true,        // 早报开不开
  briefTime: '07:30',        // 早报时间（本地时间，HH:MM）
  briefWindowMin: 120,       // 过了早报时间多久之内还补发（开机晚了也能收到；超时就不补了）
  catchUpMin: 240,           // 晚开机补发：起床晚了 / 程序开得晚，最晚到这个钟点还能补一条
  alertsEnabled: true,       // 突变预警开不开
  quietFrom: '23:00',        // 这段时间里不主动说话
  quietTo: '07:00',
  minAlertGapMin: 45,        // 任意两次预警之间至少隔多久
  sameKindGapMin: 180,       // 同一类预警之间至少隔多久
  maxAlertsPerDay: 4,        // 一天最多主动说几次
  eveningOn: false,          // 前一天晚上提前说说明天
  eveningTime: '21:00',      // 晚间预告时间
  eveningWindowMin: 120,     // 错过这个点多久之内还补发
  sunOn: true,               // 播报里带不带日出日落
  place: '',                 // 留空 = 自动定位；填城市名 = 固定这个城市
  // ── 天气数据源 ─────────────────────────────────────────────────────
  source: 'caiyun',          // caiyun = 彩云天气（主用）；open-meteo = 旧渠道（兜底）
  caiyunToken: '',           // 彩云天气 token；填了就优先用彩云
  // ── 主动消息往哪儿送：借 dsh-qq-bridge 已经配好的 NapCat 通道 ──────────
  qqOn: true,                // 开：早报/晚报/预警直接私聊推到 QQ
  qqUsers: [],               // 服务哪些 QQ 号（只做私聊；对方发消息来的也会自动加进来）
  qqKind: 'private',         // 旧字段：只在 qqUsers 空时用来迁移旧配置
  qqTarget: '',              // 旧字段：同上
  qqNapcat: '',              // 留空 = 从 qq-bridge 配置里读（一般不用填）
  qqToken: '',               // 同上
  qqConfigFile: '',          // 可填一份自家桥的 config.json（补 NapCat 地址/令牌/默认收件人）
  greetNewFriends: true,     // 新加好友时自动发一次指令说明
  qqAlsoFollowup: false,     // QQ 发出去了，还要不要在本机也醒一次
}

// ── 指令：QQ 私聊里发 */位置 杭州、*/早报 07:30 这类，对方自己改自己的设置 ──────
const 指令说明 = [
  '【天气台指令】直接回消息就能改你自己的设置：',
  '*/位置 杭州 —— 设定你在的城市（*/位置 不带城市就看现在设在哪）',
  '*/早报 07:30 —— 早上几点收到天气（*/早报 关 关掉，*/早报 开 打开）',
  '*/晚报 21:00 —— 晚上几点收到明天的天气（*/晚报 开|关）',
  '*/突变 开|关 —— 天气突然变坏时要不要提醒',
  '*/状态 —— 看看现在都设成了什么',
  '*/帮助 —— 再看一遍这段',
].join('\n')

// ── WMO 天气代码 → 中文 ─────────────────────────────────────────────────────
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨', 56: '冻毛毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨夹冰雹', 99: '强雷暴夹冰雹',
}
const 是雨 = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95
const 是雪 = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86
const 是坏天 = (c) => 是雨(c) || 是雪(c)
const 说天气 = (c) => WMO[c] || '说不清'

// ── 小工具 ──────────────────────────────────────────────────────────────────
function 两(n) { return String(n).padStart(2, '0') }
function 时刻(iso) {
  // "2026-10-28T19:00" → "19:00"
  const s = String(iso || '')
  const m = s.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : s
}
function 点钟(分钟) { return `${两(Math.floor(分钟 / 60))}:${两(分钟 % 60)}` }
function 解析时刻(s, 缺省) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return 缺省
  const v = Number(m[1]) * 60 + Number(m[2])
  return Number.isFinite(v) ? v : 缺省
}
function 本地分钟(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}
function 本地日期(date = new Date()) {
  return `${date.getFullYear()}-${两(date.getMonth() + 1)}-${两(date.getDate())}`
}
function 在区间内(now, from, to) {
  if (from === to) return false
  return from < to ? (now >= from && now < to) : (now >= from || now < to)
}
function 取整(x, n = 0) {
  const v = Number(x)
  if (!Number.isFinite(v)) return null
  const p = 10 ** n
  return Math.round(v * p) / p
}
function 说话(几) {
  if (几 === null || 几 === undefined) return '?'
  return String(Math.round(几))
}

async function 取JSON(url, ms = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'dsh-weather/1.0 (DeepSeek Harness plugin)', accept: 'application/json' },
    signal: AbortSignal.timeout(ms),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return await res.json()
}

async function 取文本(url, ms = 7000) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'dsh-weather/1.0 (DeepSeek Harness plugin)', accept: 'text/plain,*/*' },
    signal: AbortSignal.timeout(ms),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return (await res.text()).trim()
}

// ── 定位 ────────────────────────────────────────────────────────────────────
// 单靠一家 IP 库经常偏（运营商出口 / VPN / CGNAT），所以问三家再投票：
//   ipip.net   —— 国内 IP 最准的一家，纯文本，给「中国 省 市」
//   ipwho.is   —— JSON，海外还行
//   ipapi.co   —— JSON，兜底
// 拿到的市名再交给 Open-Meteo 地理编码换精确经纬度 + 中文名。

/** ipip.net 给的是「中国 山东 北京  移动」—— 末尾那截常常是运营商，得挑掉 */
const 运营商 = /移动|联通|电信|铁通|广电|教育网|长城宽带|鹏博士|世纪互联|网宿|阿里云|腾讯云|华为云|百度云|金山云|科技网|研究院|数据中心|IDC|骨干网/i

/** ipip.net：当前 IP：1.2.3.4  来自于：中国 山东 北京  移动 */
async function 源_ipip() {
  const t = await 取文本('https://myip.ipip.net', 6000)
  const m = t.match(/来自于[：:]\s*(\S+)\s+(.+)$/m)
  if (!m) throw new Error('ipip 返回值认不出来')
  const 国 = m[1].trim()
  const 段 = m[2].trim().split(/\s+/).filter((x) => x && !运营商.test(x))
  if (!段.length) throw new Error('ipip 只给了运营商，没给城市')
  const 市 = 段[段.length - 1]
  const 省 = 段.length > 1 ? 段[0] : ''
  return { 国, 省, 候选: [市, 省 && 省 !== 市 ? `${省}${市}` : ''].filter(Boolean) }
}

async function 源_ipwho() {
  const j = await 取JSON('https://ipwho.is/?fields=success,city,region,country,latitude,longitude', 6000)
  if (!j || j.success === false || !j.city) throw new Error('ipwho.is 没给城市')
  return {
    国: j.country || '',
    省: j.region || '',
    候选: [String(j.city).trim()].filter(Boolean),
    纬: Number(j.latitude),
    经: Number(j.longitude),
  }
}

async function 源_ipapi() {
  const j = await 取JSON('https://ipapi.co/json/', 6000)
  if (!j || !j.city) throw new Error('ipapi.co 没给城市')
  return {
    国: j.country_name || j.country || '',
    省: j.region || '',
    候选: [String(j.city).trim()].filter(Boolean),
    纬: Number(j.latitude),
    经: Number(j.longitude),
  }
}

/**
 * 三家都问，把城市名攒成候选表（ipip 排最前，国内最准），
 * 真正用哪个由 要地点 拿去地理编码，编不出来就试下一个。
 */
async function 定位() {
  const 结果 = await Promise.allSettled([源_ipip(), 源_ipwho(), 源_ipapi()])
  const 好 = 结果.filter((r) => r.status === 'fulfilled' && r.value && r.value.候选 && r.value.候选.length).map((r) => r.value)
  if (!好.length) return null
  const 候选 = []
  for (const x of 好) for (const 名 of x.候选) {
    const k = String(名).trim()
    if (k && !候选.includes(k)) 候选.push(k)
  }
  if (!候选.length) return null
  return {
    候选,
    家数: 好.length,
    国: 好[0].国 || '',
    纬: Number.isFinite(好[0].纬) ? 好[0].纬 : undefined,
    经: Number.isFinite(好[0].经) ? 好[0].经 : undefined,
  }
}

async function 查地名(名) {
  const 原文 = String(名 || '').trim()
  // 直接给坐标：「50.4166,124.1166」或「加格达奇 50.4166,124.1166」
  const 坐标 = /(-?\d{1,2}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(原文)
  if (坐标) {
    const 纬 = Number(坐标[1])
    const 经 = Number(坐标[2])
    if (Number.isFinite(纬) && Number.isFinite(经) && Math.abs(纬) <= 90 && Math.abs(经) <= 180) {
      const 短 = 原文.replace(坐标[0], '').replace(/[,，]+/g, ' ').trim() || `${纬.toFixed(2)},${经.toFixed(2)}`
      return { 名: 短, 全名: 短, 短名: 短, 区: '', 国: 'CN', 纬, 经, 时区: 'auto' }
    }
  }
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(名)}&count=1&language=zh&format=json`
  const j = await 取JSON(u, 7000)
  const r = j && Array.isArray(j.results) ? j.results[0] : null
  if (!r) return null
  const 短 = String(r.name || '').trim()
  const 区 = String(r.admin1 || '').trim()
  const 全 = 区 && 区 !== 短 ? `${短} ${区}` : 短
  return {
    名: 短,          // 播报里只用市名，念着顺
    全名: 全,        // 需要区分同名城市时用这个
    短名: 短,
    区,
    国: r.country || '',
    纬: Number(r.latitude),
    经: Number(r.longitude),
    时区: r.timezone || 'auto',
  }
}

/** IP 定位给的是英文地名（北京 → "Beijing Beijing"）—— 借地理编码换回中文，换不到就原样留着 */
async function 换中文名(地) {
  try {
    const 第一 = String(地.名 || '').split(/\s+/)[0]
    if (!第一) return 地
    const r = await 查地名(第一)
    if (r && r.短名) return { ...地, 名: r.短名, 短名: r.短名 }
  } catch (e) { /* 换不了就算了 */ }
  return 地
}

// ── 取天气 ──────────────────────────────────────────────────────────────────
async function 取天气开放气象(纬度, 经度) {
  const q = [
    `latitude=${纬度}`,
    `longitude=${经度}`,
    'current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_gusts_10m',
    'hourly=temperature_2m,precipitation_probability,weather_code',
    'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset',
    'timezone=auto',
    'forecast_days=7',
    'wind_speed_unit=ms',
  ].join('&')
  const j = await 取JSON(`https://api.open-meteo.com/v1/forecast?${q}`, FETCH_TIMEOUT_MS)
  const cur = j && j.current
  if (!cur) throw new Error('open-meteo 没给 current')

  const 小时 = []
  const h = j.hourly || {}
  if (Array.isArray(h.time)) {
    for (let i = 0; i < h.time.length; i++) {
      小时.push({
        时: h.time[i],
        温: 取整(h.temperature_2m?.[i], 1),
        降水概率: 取整(h.precipitation_probability?.[i]),
        代码: 取整(h.weather_code?.[i]),
      })
    }
  }
  const 天 = []
  const d = j.daily || {}
  if (Array.isArray(d.time)) {
    for (let i = 0; i < d.time.length; i++) {
      天.push({
        日: d.time[i],
        代码: 取整(d.weather_code?.[i]),
        高: 取整(d.temperature_2m_max?.[i], 1),
        低: 取整(d.temperature_2m_min?.[i], 1),
        降水概率: 取整(d.precipitation_probability_max?.[i]),
        降水量: 取整(d.precipitation_sum?.[i], 1),
        日出: 时刻(d.sunrise?.[i]),
        日落: 时刻(d.sunset?.[i]),
      })
    }
  }
  return {
    采集时间: Date.now(),
    时区: j.timezone || 'auto',
    现: {
      温: 取整(cur.temperature_2m, 1),
      体感: 取整(cur.apparent_temperature, 1),
      湿度: 取整(cur.relative_humidity_2m),
      代码: 取整(cur.weather_code),
      风: 取整(cur.wind_speed_10m, 1),
      阵风: 取整(cur.wind_gusts_10m, 1),
      降水: 取整(cur.precipitation, 1),
      白天: cur.is_day !== 0,
    },
    小时,
    天,
  }
}

// ── 彩云天气（主用；Open-Meteo 只留作兜底）──────────────────────────────────
let 天气源 = 'caiyun'      // 'caiyun' | 'open-meteo'
let 彩云令牌 = ''          // 彩云天气的 token，启动时从配置读

/** 报错/日志里出现彩云 token 一律打码：token 就写在请求路径里，出错信息很容易把它整条带出来 */
function 抹令牌(s) {
  const 文 = String(s == null ? '' : s)
  const t = 彩云令牌
  return t && 文.includes(t) ? 文.split(t).join('***') : 文
}

// 彩云对频率很敏感（一秒内连发就 429），所有请求排一条队、每次至少隔 1.1 秒
let 彩云队 = Promise.resolve()
let 彩云上次 = 0
async function 彩云请(路径) {
  const 跑 = async () => {
    const 等 = 2600 - (Date.now() - 彩云上次)
    if (等 > 0) await new Promise((r) => setTimeout(r, 等))
    彩云上次 = Date.now()
    try {
      const j = await 取JSON(路径, FETCH_TIMEOUT_MS)
      if (j && j.status !== 'ok') throw new Error(j.error || '彩云返回失败')
      return j
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000))
      彩云上次 = Date.now()
      try {
        const j = await 取JSON(路径, FETCH_TIMEOUT_MS)
        return j && j.status === 'ok' ? j : null
      } catch (e2) { return null }
    }
  }
  const 果 = 彩云队.then(跑, 跑)
  彩云队 = 果.then(() => {}, () => {})
  return 果
}

/** 彩云 skycon → WMO 代码（沿用上面的中文表） */
function 彩云码(s) {
  const k = String(s || '').toUpperCase()
  if (k === 'CLEAR_DAY' || k === 'CLEAR_NIGHT') return 0
  if (k.startsWith('PARTLY_CLOUDY')) return 2
  if (k === 'CLOUDY') return 3
  if (k === 'LIGHT_HAZE' || k === 'MODERATE_HAZE' || k === 'HEAVY_HAZE') return 45
  if (k === 'FOG' || k === 'LIGHT_FOG' || k === 'HEAVY_FOG') return 45
  if (k === 'LIGHT_RAIN') return 61
  if (k === 'MODERATE_RAIN') return 63
  if (k === 'HEAVY_RAIN') return 65
  if (k === 'STORM_RAIN') return 82
  if (k === 'LIGHT_SNOW') return 71
  if (k === 'MODERATE_SNOW') return 73
  if (k === 'HEAVY_SNOW' || k === 'STORM_SNOW') return 75
  if (k === 'SLEET') return 66
  if (k === 'WIND' || k === 'SAND' || k === 'DUST') return 3
  return 3
}

/** 彩云概率有的是 0~1，有的是 0~100，统一成百分数 */
function 彩云概率(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n > 0 && n < 1) return Math.round(n * 100)
  if (n === 1) return 100
  return Math.round(n)
}

/** 彩云的日期时间 '2026-10-31T00:00+08:00' → '2026-10-31' / '06:32' */
const 彩云日 = (s) => String(s || '').slice(0, 10)
const 彩云时 = (s) => {
  const m = /\d{2}:\d{2}/.exec(String(s || ''))
  return m ? m[0] : ''
}

async function 取天气彩云(纬度, 经度) {
  const 位 = `${经度},${纬度}`
  const 基 = `https://api.caiyunapp.com/v2.6/${彩云令牌}/${位}`
  const 实 = await 彩云请(`${基}/realtime.json`)
  const 现 = 实 && 实.result && 实.result.realtime
  if (!现) throw new Error('彩云天气没返回实况')
  const 日 = await 彩云请(`${基}/daily.json`)
  const 时 = await 彩云请(`${基}/hourly.json`)

  const 小时 = []
  const h = (时 && 时.result && 时.result.hourly) || {}
  const 时列 = [h.temperature, h.skycon, h.precipitation, h.wind]
  if (Array.isArray(h.temperature) && h.temperature.length) {
    for (let i = 0; i < h.temperature.length; i++) {
      小时.push({
        时: String((h.temperature[i] && h.temperature[i].datetime) || '').slice(0, 16),
        温: 取整(h.temperature[i] && h.temperature[i].value, 1),
        降水概率: 彩云概率(h.precipitation && h.precipitation[i] && h.precipitation[i].probability),
        代码: 彩云码(h.skycon && h.skycon[i] && h.skycon[i].value),
      })
    }
  }
  void 时列

  const 天 = []
  const d = (日 && 日.result && 日.result.daily) || {}
  const 温表 = d.temperature_08h_20h || []
  const 天表 = d.skycon_08h_20h || []
  const 水表 = d.precipitation_08h_20h || []
  const 星表 = d.astro || []
  for (let i = 0; i < 温表.length; i++) {
    const 日字 = 彩云日(温表[i] && 温表[i].date)
    天.push({
      日: 日字,
      代码: 彩云码(天表[i] && 天表[i].value),
      高: 取整(温表[i] && 温表[i].max, 1),
      低: 取整(温表[i] && 温表[i].min, 1),
      降水概率: 彩云概率(水表[i] && 水表[i].probability),
      降水量: 取整(水表[i] && 水表[i].max, 1),
      日出: 彩云时(星表[i] && 星表[i].sunrise && 星表[i].sunrise.time),
      日落: 彩云时(星表[i] && 星表[i].sunset && 星表[i].sunset.time),
    })
  }

  return {
    采集时间: Date.now(),
    时区: 'auto',
    现: {
      温: 取整(现.temperature, 1),
      体感: 取整(现.apparent_temperature, 1),
      湿度: 取整(现.humidity !== null && 现.humidity !== undefined ? 现.humidity * 100 : null),
      代码: 彩云码(现.skycon),
      风: 取整((现.wind && 现.wind.speed) / 3.6, 1),
      阵风: null,
      降水: 取整(现.precipitation && 现.precipitation.local && 现.precipitation.local.intensity, 1),
      白天: String(现.skycon || '').endsWith('_DAY'),
    },
    小时,
    天,
  }
}

/** 统一入口：彩云优先，拿不到再退回 Open-Meteo；同一个坐标 10 分钟内只取一次 */
const 天气缓存 = new Map()
async function 取天气(纬度, 经度) {
  const 键 = `${Number(纬度).toFixed(3)},${Number(经度).toFixed(3)}`
  const 存 = 天气缓存.get(键)
  if (存 && Date.now() - 存.时 < 10 * 60 * 1000) return 存.快
  let 快 = null
  if (彩云令牌 && 天气源 !== 'open-meteo') {
    try { 快 = await 取天气彩云(纬度, 经度) } catch (e) { 快 = null }
  }
  if (!快) 快 = await 取天气开放气象(纬度, 经度)
  if (快) {
    天气缓存.set(键, { 时: Date.now(), 快 })
    if (天气缓存.size > 60) 天气缓存.delete(天气缓存.keys().next().value)
  }
  return 快
}

// ── 把快照写成话 ─────────────────────────────────────────────────────────────
function 当前一句话(地, 快) {
  const c = 快.现
  const 部分 = []
  if (c.温 !== null) 部分.push(`${说话(c.温)}°C`)
  if (c.代码 !== null) 部分.push(说天气(c.代码))
  if (c.体感 !== null && c.温 !== null && Math.abs(c.体感 - c.温) >= 2) 部分.push(`体感${说话(c.体感)}°C`)
  if (c.湿度 !== null) 部分.push(`湿度${说话(c.湿度)}%`)
  if (c.风 !== null) 部分.push(c.风 >= 10 ? `风大 ${说话(c.风)}m/s` : `风${说话(c.风)}m/s`)
  const 头 = 地 ? `${地} ` : ''
  return `${头}现在 ${部分.join('，')}`
}

function 今天一句话(快) {
  const t = 快.天[0]
  if (!t) return ''
  const 段 = [`今天 ${说话(t.低)}~${说话(t.高)}°C`, 说天气(t.代码)]
  if (t.降水概率 !== null && t.降水概率 >= 20) 段.push(`降水概率${说话(t.降水概率)}%`)
  return 段.join('，')
}

/** 从现在这一小时起往后 n 小时 */
function 未来小时(快, n) {
  const now = Date.now() - 60 * 60 * 1000 // 往前留一小时，防止整点刚过时漏掉当前小时
  const out = []
  for (const x of 快.小时) {
    const t = Date.parse(`${x.时}:00`)
    if (!Number.isFinite(t) || t < now) continue
    out.push(x)
    if (out.length >= n) break
  }
  return out
}

function 未来几小时一句话(快, n = 6) {
  const xs = 未来小时(快, n)
  if (!xs.length) return ''
  const 温 = xs.map((x) => x.温).filter((v) => v !== null)
  const 概率 = xs.map((x) => x.降水概率).filter((v) => v !== null)
  const 坏 = xs.filter((x) => 是坏天(x.代码)).length
  const 段 = []
  if (温.length) {
    const lo = Math.min(...温)
    const hi = Math.max(...温)
    const 尾 = xs[xs.length - 1]
    段.push(`未来${xs.length}小时 ${说话(lo)}~${说话(hi)}°C，${时刻(尾.时)} 前后约${说话(尾.温)}°C`)
  }
  const 最高概率 = 概率.length ? Math.max(...概率) : 0
  if (最高概率 >= 20) 段.push(`最高降水概率${说话(最高概率)}%`)
  if (坏) 段.push(`其中${坏}小时有降水`)
  return 段.join('，')
}

function 建议(快) {
  const t = 快.天[0]
  const c = 快.现
  const out = []
  const 概率 = t ? t.降水概率 : null
  const 低 = t ? t.低 : null
  const 高 = t ? t.高 : null
  if (是雨(c.代码) || 是雪(c.代码)) out.push('外头正在下，出门带伞')
  else if (概率 !== null && 概率 >= 55) out.push('今天很可能下雨，带把伞')
  else if (概率 !== null && 概率 >= 25) out.push('可能有零星降水，伞可以备着')
  if (低 !== null && 低 <= 5) out.push('早上偏冷，穿厚一点')
  else if (高 !== null && 高 >= 33) out.push('白天很热，注意防晒补水')
  if (c.风 !== null && c.风 >= 10.8) out.push('风比较大，注意别被吹着')
  return out.join('；')
}

function 详细文本(地, 快, { days = 3, hours = 12 } = {}) {
  const 行 = []
  行.push(`【${地 || '当前位置'}】${当前一句话('', 快)}`)
  const 今 = 今天一句话(快)
  if (今) 行.push(今)
  const 建 = 建议(快)
  if (建) 行.push(`建议：${建}`)
  if (hours > 0) {
    const xs = 未来小时(快, hours)
    if (xs.length) {
      行.push('')
      行.push(`未来 ${xs.length} 小时：`)
      for (const x of xs) {
        行.push(`  ${时刻(x.时)}  ${说话(x.温)}°C  ${说天气(x.代码)}${x.降水概率 !== null ? `  降水${说话(x.降水概率)}%` : ''}`)
      }
    }
  }
  const n = Math.max(1, Math.min(7, Number(days) || 3))
  if (快.天.length) {
    行.push('')
    行.push(`未来 ${Math.min(n, 快.天.length)} 天：`)
    for (const t of 快.天.slice(0, n)) {
      行.push(`  ${t.日}  ${说天气(t.代码)}  ${说话(t.低)}~${说话(t.高)}°C${t.降水概率 !== null ? `  降水${说话(t.降水概率)}%` : ''}${t.日出 ? `  日出${t.日出} 日落${t.日落}` : ''}`)
    }
  }
  return 行.join('\n')
}

// ── 突变判定 ────────────────────────────────────────────────────────────────
/** 返回这次快照里值得说一句的事（可能为空）*/
function 找突变(快) {
  const out = []
  const c = 快.现
  const xs = 未来小时(快, 6)

  if (!是坏天(c.代码) && xs.length) {
    const 第一个坏的 = xs.find((x) => 是坏天(x.代码))
    if (第一个坏的) {
      const 名 = 是雪(第一个坏的.代码) ? '雪' : '雨'
      out.push({ 类: '降水将至', 说: `大约 ${时刻(第一个坏的.时)} 开始下${名}（${说天气(第一个坏的.代码)}）`, 重: 3 })
    } else {
      const 最高 = Math.max(...xs.map((x) => (x.降水概率 === null ? 0 : x.降水概率)))
      if (最高 >= 60) out.push({ 类: '降水概率升高', 说: `接下来几小时降水概率最高到 ${说话(最高)}%`, 重: 2 })
    }
  }

  if (xs.length && c.温 !== null) {
    const 温 = xs.map((x) => x.温).filter((v) => v !== null)
    if (温.length) {
      const 降 = c.温 - Math.min(...温)
      const 升 = Math.max(...温) - c.温
      if (降 >= 7) out.push({ 类: '降温', 说: `接下来几小时要降 ${说话(降)}°C 左右（最低 ${说话(Math.min(...温))}°C）`, 重: 3 })
      else if (升 >= 8) out.push({ 类: '升温', 说: `接下来几小时要升 ${说话(升)}°C 左右（最高 ${说话(Math.max(...温))}°C）`, 重: 2 })
    }
  }

  if (c.风 !== null && c.风 >= 10.8) out.push({ 类: '大风', 说: `风已经到 ${说话(c.风)}m/s（阵风 ${说话(c.阵风)}m/s）`, 重: 3 })
  if (c.温 !== null && c.温 >= 35) out.push({ 类: '高温', 说: `现在 ${说话(c.温)}°C，很热`, 重: 2 })
  if (c.温 !== null && c.温 <= -5) out.push({ 类: '严寒', 说: `现在 ${说话(c.温)}°C，非常冷`, 重: 2 })
  if (是雪(c.代码)) out.push({ 类: '下雪', 说: `正在下${说天气(c.代码)}`, 重: 2 })

  return out
}

// ══════════════════════════════════════════════════════════════════════════
// QQ 推送：借 dsh-qq-bridge 已经配好的 NapCat 通道（不重复造轮子，也不碰它的配置）
// ══════════════════════════════════════════════════════════════════════════
const qq配置文件 = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-config.json')

function 读JSON文件(文件) {
  try {
    if (!文件 || !existsSync(文件)) return null
    const j = JSON.parse(readFileSync(文件, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch (e) { return null }
}

/** 读 qq-bridge 插件的配置（NapCat 地址、令牌、绑定表）；读不到就 null，绝不抛 */
function 桥配置() {
  return 读JSON文件(qq配置文件())
}

/**
 * 可选：指向「自己那一份桥」的配置文件（比如 SnowLuma 桥的 config.json）。
 * 只用来补三项：OneBot HTTP 地址、access_token、默认收件人（ownerQQ）。
 * 认两种写法：{snowluma:{httpUrl,accessToken}, ownerQQ} 或 qq-bridge 的 {NapCat, 令牌}。
 */
function 自家配置(配置 = {}) {
  const 文件 = String(配置.qqConfigFile || '').trim()
  if (!文件) return null
  const j = 读JSON文件(文件)
  if (!j) return null
  const s = j.snowluma && typeof j.snowluma === 'object' ? j.snowluma : null
  return {
    base: String((s && (s.httpUrl || s.httpURL)) || j.NapCat || '').trim(),
    token: String((s && s.accessToken) || j.令牌 || '').trim(),
    号: String(j.ownerQQ || j.owner || '').trim(),
  }
}

/** 把配置里的名单规整成 [ '123', '456' ]：支持数组、逗号/空格/顿号分隔的字符串 */
function 号单(v) {
  const 原 = Array.isArray(v) ? v : String(v || '').split(/[,，\s、;；]+/)
  const 出 = []
  for (const x of 原) {
    const s = String(x == null ? '' : x).trim()
    if (/^\d{4,12}$/.test(s) && !出.includes(s)) 出.push(s)
  }
  return 出
}

/**
 * 决定发去哪：**只做私聊**。名单 = 配置里的 qqUsers（外加调用方传进来的对端）。
 * 缺的地址/令牌依次从 qq-bridge 插件、自家桥配置里补。
 * 返回 { base, token, 号们: [{ 号, 名 }] } —— base 为空表示没配 OneBot。
 */
function 解析QQ目标s(配置 = {}) {
  const 桥 = 桥配置() || {}
  const 自家 = 自家配置(配置) || {}
  const base = String(配置.qqNapcat || 桥.NapCat || 自家.base || '').trim().replace(/\/+$/, '')
  const token = String(配置.qqToken || 桥.令牌 || 自家.token || '').trim()
  const 号们 = []
  const 加 = (号, 名 = '') => {
    const s = String(号 == null ? '' : 号).trim()
    if (!/^\d{4,12}$/.test(s)) return
    const 旧 = 号们.find((x) => x.号 === s)
    if (旧) { if (!旧.名 && 名) 旧.名 = String(名); return }
    号们.push({ 号: s, 名: String(名 || '') })
  }
  for (const 号 of 号单(配置.qqUsers)) 加(号)
  if (!号们.length) {
    // 旧配置迁移：只认私聊
    const 旧号 = 号单(配置.qqTarget)[0]
    if (旧号 && String(配置.qqKind || 'private') !== 'group') 加(旧号)
    else {
      const 绑 = Array.isArray(桥.绑定) ? 桥.绑定 : []
      const 私 = 绑.find((b) => b && b.类型 === '私聊')
      if (私 && 私.号码) 加(私.号码)
      else if (自家.号) 加(自家.号) // ownerQQ → 私聊发给主人
    }
  }
  return { base, token, 号们 }
}

/** 真发一条私聊。返回 { ok, 说 }，任何异常都变成 ok:false，不往外抛 */
async function 发QQ(目标, 文本) {
  const { base, token, 号 } = 目标 || {}
  if (!base) return { ok: false, 说: '没找到 OneBot 地址（qq-bridge 那边还没配？）' }
  if (!号) return { ok: false, 说: '没配 QQ 号（qq-bridge 里也没有绑定）' }
  const 号数 = Number(号)
  if (!Number.isFinite(号数)) return { ok: false, 说: `「${号}」不是数字` }
  const 头 = { 'content-type': 'application/json', 'user-agent': 'dsh-weather' }
  if (token) 头.authorization = 'Bearer ' + token
  try {
    const r = await fetch(`${base}/send_private_msg`, {
      method: 'POST',
      headers: 头,
      body: JSON.stringify({ user_id: 号数, message: 文本 }),
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => null)
    if (j && j.status === 'ok' && j.retcode === 0) return { ok: true, 说: `已发到 QQ ${号}`, 回执: j }
    return { ok: false, 说: `QQ 端没接受（HTTP ${r.status}，retcode ${j && j.retcode} ${(j && j.wording) || ''}）` }
  } catch (e) {
    return { ok: false, 说: `连不上 OneBot（${base}）：${(e && e.message) || e}` }
  }
}

/**
 * 一条消息私聊发给名单里的所有人（缺省名单 + 调用方补的对端）。全部成功才 ok:true。
 * 文本 可以是字符串，也可以是 (目标) => 字符串 的函数；函数返回 null 表示这个人不发。
 */
async function 发QQs(配置, 文本, 补号 = []) {
  const { base, token, 号们: 基 } = 解析QQ目标s(配置)
  const 号们 = [...基]
  for (const x of Array.isArray(补号) ? 补号 : []) {
    const 号 = String((x && x.号) ?? x ?? '').trim()
    if (!/^\d{4,12}$/.test(号) || 号们.some((y) => y.号 === 号)) continue
    号们.push({ 号, 名: String((x && x.名) || '') })
  }
  if (!base) return { ok: false, 说: '没找到 OneBot 地址（qq-bridge 或配置文件里还没配）', 明细: [] }
  if (!号们.length) return { ok: false, 说: '还没有服务对象（控制台里选一个 QQ 号，或让对方私聊你一句）', 明细: [] }
  const 明细 = []
  for (const t of 号们) {
    const 本 = typeof 文本 === 'function' ? await 文本(t) : 文本
    if (本 == null) continue
    明细.push({ ...t, ...(await 发QQ({ base, token, 号: t.号 }, 本)) })
  }
  if (!明细.length) return { ok: false, 说: '没有可发的对象', 明细: [] }
  const 成功 = 明细.filter((x) => x.ok)
  const 说 = 成功.length === 明细.length
    ? `已发到 QQ ${明细.map((x) => x.号).join('、')}`
    : `发出去 ${成功.length}/${明细.length}：` + 明细.filter((x) => !x.ok).map((x) => `${x.号} ${x.说}`).join('；')
  return { ok: 成功.length > 0, 说, 明细 }
}

/** OneBot 通配动作（GET）。返回 {$: 解析后的 JSON} 或 {$: null, 错: '...'} */
async function 取OneBot(base, token, action) {
  if (!base) return { $: null, 错: '没找到 OneBot 地址' }
  const 头 = { 'user-agent': 'dsh-weather' }
  if (token) 头.authorization = 'Bearer ' + token
  try {
    const r = await fetch(`${base}/${action}`, { headers: 头, signal: AbortSignal.timeout(8000) })
    const j = await r.json().catch(() => null)
    if (!j) return { $: null, 错: `HTTP ${r.status}，返回不是 JSON` }
    if (j.status && j.status !== 'ok') return { $: null, 错: `retcode ${j.retcode} ${j.wording || ''}` }
    return { $: j }
  } catch (e) {
    return { $: null, 错: `连不上 ${base}（${(e && e.message) || e}）` }
  }
}

/** 号都按字符串存，发请求前转成数字 */
function 数号(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

/** OneBot POST 动作（拉历史消息必须 POST + body）。返回解析后的 JSON，失败返回 null */
async function 取OneBotPost(base, token, action, 体) {
  if (!base) return null
  const 头 = { 'content-type': 'application/json', 'user-agent': 'dsh-weather' }
  if (token) 头.authorization = 'Bearer ' + token
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: 头,
    body: JSON.stringify(体 || {}),
    signal: AbortSignal.timeout(8000),
  })
  return r.json().catch(() => null)
}

/** DSH 的数据根目录（配置、会话投影缓存都在这里） */
function 取根() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 「已经接进 DSH 会话」的 QQ 对象，且会话没有被归档。
 * 来源：每个会话的投影缓存把标题存成 `QQ好友 · 123456789` / `QQ好友 · 杏一枚`
 * （有的标题写号码、有的写昵称，两种都认），归档名单在
 * storages/workspace.json 的 global.archivedSessionIds 里。
 * 返回 { 号码:Set, 昵称:Set, 群号:Set, 群名:Set, 有标题目录:boolean }
 */
const 接通缓存 = { 时: 0, 值: null }
function 读已接通(强刷 = false) {
  const now = Date.now()
  if (!强刷 && 接通缓存.值 && now - 接通缓存.时 < 30000) return 接通缓存.值
  const 号码 = new Set()
  const 昵称 = new Set()
  const 群号 = new Set()
  const 群名 = new Set()
  let 有标题 = false
  const 根 = 取根()
  const 归档 = new Set()
  try {
    const w = JSON.parse(readFileSync(join(根, 'storages', 'workspace.json'), 'utf8'))
    for (const id of (w && w.global && w.global.archivedSessionIds) || []) 归档.add(String(id))
  } catch (e) { /* 没有这个文件就当什么都没归档 */ }
  const 目 = join(根, 'storages', 'session_projcache', 'sessions')
  let 文件们 = []
  try { 文件们 = readdirSync(目) } catch (e) { 文件们 = [] }
  for (const f of 文件们) {
    if (!/\.json$/.test(f)) continue
    const sid = f.replace(/\.json$/, '')
    if (归档.has(sid)) continue
    let 题 = ''
    try {
      const j = JSON.parse(readFileSync(join(目, f), 'utf8'))
      const r = j && (j.record || j)
      题 = String((r && r.rows && r.rows.title && r.rows.title.val) || '')
    } catch (e) { continue }
    const m = /^QQ\s*(好友|群)\s*·\s*(.+)$/.exec(题.trim())
    if (!m) continue
    有标题 = true
    const 尾 = m[2].trim()
    const 是群 = m[1] === '群'
    if (/^\d{4,12}$/.test(尾)) (是群 ? 群号 : 号码).add(尾)
    else if (尾) (是群 ? 群名 : 昵称).add(尾)
  }
  const 值 = { 号码, 昵称, 群号, 群名, 有标题目录: 有标题, 归档数: 归档.size }
  接通缓存.时 = now
  接通缓存.值 = 值
  return 值
}

/** 拉「已经接进 DSH 且未归档」的好友和群：给控制台的抽屉列表用。带 60 秒缓存 */
const 名单缓存 = { 时: 0, 值: null }
async function 拉名单(配置, 强刷 = false) {
  const now = Date.now()
  if (!强刷 && 名单缓存.值 && now - 名单缓存.时 < 60000) return 名单缓存.值
  const { base, token } = 解析QQ目标s(配置)
  if (!base) return { ok: false, 说: '没找到 OneBot 地址（qq-bridge 或 qqConfigFile 里还没配）', 好友: [], 群: [], base: '' }
  const [友回, 群回] = await Promise.all([取OneBot(base, token, 'get_friend_list'), 取OneBot(base, token, 'get_group_list')])
  const 规整 = (j, 名键, 偏备注) => (Array.isArray(j) ? j : []).map((x) => {
    const 号 = String((x && (x.user_id ?? x.group_id)) ?? '')
    const 偏好 = 偏备注 ? String((x && (x.remark || x.card)) || '') : ''
    const 名 = String((x && (名键 && x[名键])) || '') || String((x && x.nickname) || '')
    const 名最终 = 偏好 || 名
    const 别名 = [偏好, 名, String((x && x.card) || '')]
      .filter((v) => v && v !== 名最终)
      .filter((v, i, a) => a.indexOf(v) === i)
    return { 号, 名: 名最终, 别名 }
  }).filter((x) => /^\d{4,12}$/.test(x.号))
  const 友全 = 规整(友回.$ && (友回.$.data ?? 友回.$), 'nickname', true)
  const 群全 = 规整(群回.$ && (群回.$.data ?? 群回.$), 'group_name', false)
  // 只留「已经有 DSH 会话、且那个会话没被归档」的对象
  const 通 = 读已接通(强刷)
  const 对上 = (x, 号集, 名集) => 号集.has(x.号) || [x.名, ...(x.别名 || [])].some((n) => n && 名集.has(n))
  const 好友 = 友全.filter((x) => 对上(x, 通.号码, 通.昵称))
  const 群 = 群全.filter((x) => 对上(x, 通.群号, 通.群名))
  const 说 = [
    友回.错 && `好友接口：${友回.错}`,
    群回.错 && `群接口：${群回.错}`,
    !通.有标题目录 && 友全.length ? '没找到任何「QQ 好友/群」会话（先让 qq-bridge 把会话接进来）' : '',
  ].filter(Boolean).join('；')
  const 值 = {
    ok: !!(友回.$ || 群回.$),
    base,
    好友,
    群,
    说,
    计数: { 好友: 好友.length, 群: 群.length, 好友共: 友全.length, 群共: 群全.length, 归档: 通.归档数 },
  }
  名单缓存.时 = now
  名单缓存.值 = 值
  return 值
}

// ── 私聊指令：*/位置 杭州、*/早报 07:30、*/晚报 21:00、*/突变 开、*/状态、*/帮助 ──
// 把一句话解析成 { 令, 参 }；不是指令返回 null。
// 认三种写法：`*/位置 杭州`、`*位置 杭州*`、`【位置 杭州】`（消息里带 * 容易被 QQ 吃掉一个）
function 解析指令(文本) {
  let s = String(文本 || '').trim()
  if (!s) return null
  // 图片/表情等媒体段会被序列化成 CQ 码（常带方括号），括号形态会让它误判成「有壳指令」，
  // 进而把整串机器码当指令名回显给对方。凡是机器码/媒体直链，一律不当指令。
  if (/CQ:/i.test(s) || /multimedia\.nt\.qq\.com/i.test(s) || /\brkey=/i.test(s)) return null
  const 有壳 = /^[*【\[（(]/.test(s)
  s = s.replace(/^[*【\[（(]+\s*/, '').replace(/\s*[*】\]）)]+$/, '').trim()
  if (!s) return null
  if (s.startsWith('/')) s = s.replace(/^\/+/, '').trim()
  else if (!有壳) return null
  const m = /^([^\s]+)\s*([\s\S]*)$/.exec(s)
  if (!m || !m[1]) return null
  // 指令名只可能是短词（位置/早报/help/?…）。带逗号、斜杠、冒号的都是机器码被拆出来的残渣。
  if (/[,:/\\]/.test(m[1])) return null
  return { 令: m[1], 参: m[2].trim() }
}

/** OneBot 的 message 段数组 → 纯文字（有些端 raw_message 是空的） */
function 段文本(段们) {
  if (!Array.isArray(段们)) return ''
  return 段们.map((x) => (x && x.type === 'text' ? String((x.data && x.data.text) || '') : '')).join('').trim()
}

/** 在一坨 JSON 里翻经纬度和地名（QQ 位置卡片的字段名各家不一样） */
function 扒位置(o, 深 = 0) {
  if (!o || typeof o !== 'object' || 深 > 6) return null
  const 纬 = Number(o.lat !== undefined ? o.lat : (o.latitude !== undefined ? o.latitude : o.纬度))
  const 经 = Number(o.lon !== undefined ? o.lon : (o.lng !== undefined ? o.lng : (o.longitude !== undefined ? o.longitude : o.经度)))
  if (Number.isFinite(纬) && Number.isFinite(经) && Math.abs(纬) <= 90 && Math.abs(经) <= 180 && !(纬 === 0 && 经 === 0)) {
    const 名 = String(o.title || o.name || o.address || o.content || o.desc || '').trim()
    return { 纬, 经, 名 }
  }
  for (const v of Object.values(o)) {
    const r = 扒位置(v, 深 + 1)
    if (r) return r
  }
  return null
}

/** 从 QQ 消息段里找「位置」：location 段，或位置卡片那种 json 段 */
function 段位置(段们) {
  if (!Array.isArray(段们)) return null
  for (const s of 段们) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'location') {
      const d = s.data || {}
      const 纬 = Number(d.lat)
      const 经 = Number(d.lon)
      if (Number.isFinite(纬) && Number.isFinite(经)) {
        return { 纬, 经, 名: String(d.title || d.content || d.name || '').trim() }
      }
    }
    if (s.type === 'json') {
      const raw = String((s.data && (s.data.data || s.data.content || s.data.raw)) || '')
      try {
        const r = 扒位置(JSON.parse(raw))
        if (r) return r
      } catch (e) { /* 不是位置卡片 */ }
    }
  }
  return null
}

const 说开 = (v, 缺) => {
  const t = String(v || '').trim()
  if (!t) return !缺
  if (/^(开|打开|要|是|on|true|1|开吧|开着)$/i.test(t)) return true
  if (/^(关|关掉|不要|否|off|false|0|别发|关了)$/i.test(t)) return false
  return !缺
}

// ══════════════════════════════════════════════════════════════════════════
// 本机自测用（Loader 只认 name / inject / apply / Config，多余导出会被忽略）
export const __test = {
  定位, 查地名, 换中文名, 取天气, 详细文本, 找突变, 未来小时, 建议,
  当前一句话, 今天一句话, 未来几小时一句话,
  桥配置, 号单, 解析QQ目标s, 发QQ, 发QQs, 拉名单, 读已接通, 解析指令, 段文本, 说开,
}

export function apply(ctx, config) {
  const 日志 = (m, 等 = 'info') => {
    const 行 = 抹令牌(m)
    try {
      const lg = ctx.logger || (ctx.get && ctx.get('logger'))
      if (lg && typeof lg[等] === 'function') lg[等](`[weather] ${行}`)
      else if (等 === 'warn' || 等 === 'error') console.warn(`[weather] ${行}`)
    } catch (e) { /* 日志失败不影响任何事 */ }
  }

  // ── 配置 ────────────────────────────────────────────────────────────────
  const 配置 = { ...DEFAULTS }
  const 配置目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
  const 配置文件 = join(配置目录, 'weather-plugin.json')
  try {
    if (existsSync(配置文件)) Object.assign(配置, JSON.parse(readFileSync(配置文件, 'utf8')) || {})
  } catch (e) { 日志(`配置文件读不了（用默认值）：${e && e.message}`, 'warn') }
  // patch 里写的 config 优先级最高
  if (config && typeof config === 'object') {
    for (const [k, v] of Object.entries(config)) if (v !== undefined && v !== null) 配置[k] = v
  }

  // 天气源：只按「有没有令牌」决定 —— 填了彩云 token 就用彩云，没填就用 Open-Meteo
  彩云令牌 = String(配置.caiyunToken || '').trim()
  天气源 = 彩云令牌 ? 'caiyun' : 'open-meteo'

  /** 控制台存配置：只认白名单键，令牌留空表示「不改」，落盘到 ~/.dsh/weather-plugin.json */
  function 存配置(补丁) {
    const 型 = {
      place: 'str', briefEnabled: 'bool', briefTime: 'str', briefWindowMin: 'num', catchUpMin: 'num',
      eveningOn: 'bool', eveningTime: 'str', eveningWindowMin: 'num',
      alertsEnabled: 'bool', minAlertGapMin: 'num', sameKindGapMin: 'num', maxAlertsPerDay: 'num',
      quietFrom: 'str', quietTo: 'str', sunOn: 'bool',
      source: 'str', caiyunToken: 'str',
      qqOn: 'bool', qqUsers: 'arr', qqNapcat: 'str', qqToken: 'str',
      qqConfigFile: 'str', qqAlsoFollowup: 'bool', greetNewFriends: 'bool',
    }
    const 改 = {}
    for (const [k, v] of Object.entries(补丁 || {})) {
      const t = 型[k]
      if (!t) continue
      if (t === 'num') { const n = Number(v); if (Number.isFinite(n)) 改[k] = n }
      else if (t === 'bool') 改[k] = v === true || v === 'true' || v === 1 || v === '1'
      else if (t === 'arr') 改[k] = 号单(v)
      else if (t === 'str') 改[k] = v === null || v === undefined ? '' : String(v)
    }
    if (改.qqToken === '') delete 改.qqToken // 留空 = 保持原令牌
    Object.assign(配置, 改)
    // 彩云令牌现改现生效：清空就退回 Open-Meteo，不用重载插件
    if (typeof 改.caiyunToken === 'string') {
      彩云令牌 = 改.caiyunToken.trim()
      天气源 = 彩云令牌 ? 'caiyun' : 'open-meteo'
    }
    // 新加进来的号：补一份对端记录，名字从好友列表里找（会话兜底按名字找会话要用）
    if (Array.isArray(改.qqUsers)) {
      const 缺 = 改.qqUsers.filter((号) => !S.对端[号] || !(S.对端[号].名 || '').trim())
      if (缺.length) {
        void (async () => {
          try {
            const 名表 = await 拉名单(配置, true)
            for (const 号 of 缺) {
              const f = (名表.好友 || []).find((x) => String(x.号) === 号)
              保对端(号, f ? f.名 : '')
            }
          } catch (e) { 日志(`补对端名字失败：${e && e.message}`, 'warn') }
        })()
      }
    }
    // 只存跟默认值不一样的项，文件小、以后改默认值也能吃到
    const 落 = {}
    for (const k of Object.keys(型)) {
      const a = 配置[k]
      const b = DEFAULTS[k]
      const 同 = Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((x, i) => x === b[i])
        : a === b
      if (!同) 落[k] = a
    }
    try { writeFileSync(配置文件, JSON.stringify(落, null, 2), 'utf8') } catch (e) { 日志(`配置存不下：${e && e.message}`, 'warn') }
    return 改
  }

  // 这些取值每轮都从 配置 现算：控制台改完立刻生效，不用重载插件
  const 现刻 = () => ({
    静默起: 解析时刻(配置.quietFrom, 23 * 60),
    静默止: 解析时刻(配置.quietTo, 7 * 60),
    早报: 解析时刻(配置.briefTime, 7 * 60 + 30),
    晚间: 解析时刻(配置.eveningTime, 21 * 60),
    最小间隔: Math.max(5, Number(配置.minAlertGapMin) || 45) * 60000,
    同类间隔: Math.max(10, Number(配置.sameKindGapMin) || 180) * 60000,
    每天上限: Math.max(1, Number(配置.maxAlertsPerDay) || 4),
    早报窗口: Math.max(15, Number(配置.catchUpMin) || 240),
    晚间窗口: Math.max(15, Number(配置.catchUpMin) || 240),
    补发窗口: Math.max(15, Number(配置.catchUpMin) || 240),
  })

  // ── 状态（插件重载就重置）────────────────────────────────────────────────
  const S = {
    地: null, 地时间: 0,
    快: null, 快时间: 0,
    取中: null,
    上次预警: 0, 上次各类: {}, 今日预警数: 0, 预警日: '',
    早报日: '',        // 'YYYY-MM-DD' —— 今天播过就不再播
    晚间日: '',        // 'YYYY-MM-DD' —— 今晚的「明天预告」播过没有
    挂载: new Map(),   // sid -> { agent, off }
    心跳: 0, 心跳时: 0, 错: '',   // 只给自检看：心跳到底在不在跑
    启: Date.now(),    // 插件这次是什么时候起来的：用来判断「这个窗口是不是启动前就开了」
    地缓存: false,     // 这个定位是从上次存下来的，不是刚查的
    地位源: '',        // '手动' | '自动'
    定位说明: '',      // 自动定位时记一句「3 家 IP 库一致：北京」，给控制台看
  }

  // ── 定位结果落盘：IP 定位会飘（VPN / 多出口），重载一次就换个城市太糟 ──────
  const 状态文件 = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'weather-plugin-state.json')
  try {
    if (existsSync(状态文件)) {
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      const t = Number(j && j.时间) || 0
      if (j && j.地 && j.地.名 && Date.now() - t < PLACE_TTL_MS) {
        S.地 = j.地
        S.地时间 = t
        S.地缓存 = true
        S.地位源 = j.源 === '手动' ? '手动' : '自动'
        S.定位说明 = typeof j.说明 === 'string' ? j.说明 : ''
      }
    }
  } catch (e) { 日志(`上次的定位读不出来：${e && e.message}`, 'warn') }

  function 记下地点(地, 源) {
    S.地位源 = 源
    try {
      writeFileSync(状态文件, JSON.stringify({ 地, 源, 说明: S.定位说明 || '', 时间: Date.now() }), 'utf8')
    } catch (e) { /* 存不下就下次再定位 */ }
  }

  // ── 对端：每个私聊过我们（或被选进服务名单）的人，自己一份设置 ──────────────
  // 存 ~/.dsh/weather-plugin-peers.json —— 只有私聊，没有群。
  S.对端 = {}        // '123456789' -> { 名, 城:{名,纬,经}, 早:{开,时}, 晚:{开,时}, 突变, 首, 阅 }
  S.已发 = {}        // 号 -> { 早: 'YYYY-MM-DD', 晚: 'YYYY-MM-DD' }
  S.警 = {}          // 号 -> { 日, 数, 上次, 上次各类: {} }
  S.城快照 = {}      // 城市名 -> { 地, 快, 时 }
  S.好友 = []        // 已经招呼过的 QQ 好友号（用来发现新加的好友）
  S.好友初 = false   // 第一次拿到好友名单时只记录、不群发，免得一装就把所有人骚扰一遍
  const 对端文件 = join(取根(), 'weather-plugin-peers.json')
  try {
    if (existsSync(对端文件)) {
      const j = JSON.parse(readFileSync(对端文件, 'utf8'))
      if (j && j.对端 && typeof j.对端 === 'object') S.对端 = j.对端
      // 今天已经给谁发过什么，必须一起存：不然每次重启插件都把当天的早报/晚间再发一遍
      if (j && j.已发 && typeof j.已发 === 'object') S.已发 = j.已发
      if (j && j.警 && typeof j.警 === 'object') S.警 = j.警
      if (j && typeof j.早报日 === 'string') S.早报日 = j.早报日
      if (j && typeof j.晚间日 === 'string') S.晚间日 = j.晚间日
      if (j && Array.isArray(j.好友)) S.好友 = j.好友
      if (j && typeof j.好友初 === 'boolean') S.好友初 = j.好友初
    }
  } catch (e) { 日志(`对端设置读不出来：${e && e.message}`, 'warn') }

  function 存对端() {
    try {
      writeFileSync(对端文件, JSON.stringify({
        对端: S.对端,
        已发: S.已发,
        警: S.警,
        早报日: S.早报日 || '',
        晚间日: S.晚间日 || '',
        好友: S.好友,
        好友初: S.好友初,
      }, null, 2), 'utf8')
    } catch (e) { 日志(`对端设置存不下：${e && e.message}`, 'warn') }
  }

  /** 收主动播报的人：只认控制台里勾选的那些号（私聊过的人不会因为聊过一次就自动收） */
  function 服务对象() {
    return 解析QQ目标s(配置).号们.slice()
  }

  /** 要对指令回话的人：勾选的 ∪ 私聊过的（没勾选的人也能自己设位置/时间，只是不收播报） */
  function 指令对象() {
    const 出 = 服务对象()
    for (const 号 of Object.keys(S.对端)) {
      if (!出.some((x) => String(x.号) === String(号))) 出.push({ 号, 名: (S.对端[号] && S.对端[号].名) || '' })
    }
    return 出
  }

  /** 这个人的有效设置：他自己没单独设的项，跟控制台的全局默认走 */
  function 有效设置(号, 名 = '') {
    const k = String(号)
    const 个 = S.对端[k] || {}
    const c = 现刻()
    return {
      号: k,
      名: 个.名 || 名 || '',
      城: 个.城 && 个.城.名 ? 个.城 : null,
      早开: 个.早 && 个.早.开 !== undefined ? !!个.早.开 : !!配置.briefEnabled,
      早时: 个.早 && Number.isFinite(Number(个.早.时)) ? Number(个.早.时) : c.早报,
      晚开: 个.晚 && 个.晚.开 !== undefined ? !!个.晚.开 : !!配置.eveningOn,
      晚时: 个.晚 && Number.isFinite(Number(个.晚.时)) ? Number(个.晚.时) : c.晚间,
      突变: 个.突变 === undefined ? !!配置.alertsEnabled : !!个.突变,
    }
  }

  /** 这个钟点是不是在本次启动之前就过掉了（过了 10 分钟以上就不补发，免得每次启动都重发一遍）*/
  function 启动前就过点了(分钟) {
    const now = new Date()
    const 点 = new Date(now)
    点.setHours(Math.floor(分钟 / 60), 分钟 % 60, 0, 0)
    return 点.getTime() + 10 * 60 * 1000 < S.启
  }

  /** 建一条对端记录（第一次私聊来的 / 控制台加的）；返回 true 表示是新建的 */
  function 保对端(号, 名 = '') {
    const k = String(号)
    if (!/^\d{4,12}$/.test(k)) return false
    if (S.对端[k]) {
      if (名 && !S.对端[k].名) { S.对端[k].名 = String(名); 存对端() }
      return false
    }
    S.对端[k] = { 名: String(名 || ''), 首: Date.now(), 阅: Date.now() }
    存对端()
    return true
  }

  /** 改某个人自己的设置（深层合并两层），顺手落盘 */
  function 写对端(号, 补) {
    const k = String(号)
    const 旧 = S.对端[k] || { 名: '', 首: Date.now(), 阅: Date.now() }
    const 新 = { ...旧 }
    for (const [键, 值] of Object.entries(补 || {})) {
      if (值 && typeof 值 === 'object' && !Array.isArray(值) && 旧[键] && typeof 旧[键] === 'object') 新[键] = { ...旧[键], ...值 }
      else 新[键] = 值
    }
    S.对端[k] = 新
    存对端()
    return 新
  }

  /** 这个人所在城市的天气；没单独设城市就返回本机那一份。带 city 缓存。 */
  async function 对象快照(号) {
    const 设 = 有效设置(号)
    if (设.城) {
      const 缓 = S.城快照[设.城.名]
      if (缓 && Date.now() - 缓.时 < TTL_MS) return { 地: 缓.地, 快: 缓.快, 时: 缓.时 }
      let 地 = null
      if (Number.isFinite(设.城.纬) && Number.isFinite(设.城.经)) 地 = { 名: 设.城.名, 纬: 设.城.纬, 经: 设.城.经 }
      else 地 = await 查地名(设.城.名)
      if (!地) return null
      const 快 = await 取天气(地.纬, 地.经)
      if (!快) return null
      S.城快照[设.城.名] = { 地, 快, 时: Date.now() }
      return { 地, 快, 时: Date.now() }
    }
    if (!S.地 || !S.快) return null
    return { 地: S.地, 快: S.快, 时: S.快时间 }
  }

  /** 执行一条指令，返回要回给对方的话（空串 = 不回） */
  async function 应指令(号, 令, 参) {
    const 设 = 有效设置(号)
    const c = 现刻()
    const 令名 = String(令 || '').replace(/^\/+/, '')
    switch (令名) {
      case '帮助': case '指令': case 'help': case '?': case '菜单':
        return 指令说明
      case '位置': case '城市': case '地点': {
        if (!参) return 设.城 ? `你现在设在：${设.城.名}。要改就发 */位置 杭州` : '你还没设位置。可以直接把 QQ 里的「位置」发给我，或者发 */位置 杭州（查不到的小地方可以发 */位置 加格达奇 50.4166,124.1166）'
        // 支持「城市名 纬,经」「纬,经」两种写法
        const 坐标 = /(-?\d{1,2}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(参)
        if (坐标) {
          const 纬 = Number(坐标[1])
          const 经 = Number(坐标[2])
          if (Number.isFinite(纬) && Number.isFinite(经) && Math.abs(纬) <= 90 && Math.abs(经) <= 180) {
            const 名 = String(参.replace(坐标[0], '').trim()) || `${纬.toFixed(2)},${经.toFixed(2)}`
            写对端(号, { 城: { 名, 纬, 经, 来源: '手动坐标' } })
            for (const k of Object.keys(S.城快照)) delete S.城快照[k]
            return `记下了：${名}（${纬},${经}）。以后的天气按这个坐标说。`
          }
        }
        const 地 = await 查地名(参)
        if (!地) return `没查到「${参}」这个地方。可以直接发 QQ 位置给我，或者发 */位置 地名 纬度,经度（例如 */位置 加格达奇 50.4166,124.1166）`
        写对端(号, { 城: { 名: 地.名, 纬: 地.纬, 经: 地.经 } })
        delete S.城快照[地.名]
        return `记下了：${地.名}。以后的天气按你那儿说。`
      }
      case '早报': {
        const t = 参 ? 解析时刻(参, null) : null
        if (t !== null) { 写对端(号, { 早: { 开: true, 时: t } }); return `早报改到 ${点钟(t)} 了，每天这个点给你发早上那一条` }
        if (参) { const 要 = 说开(参, 设.早开); 写对端(号, { 早: { 开: 要, 时: 设.早时 } }); return `早报${要 ? `开了，每天 ${点钟(设.早时)}` : '关了'}` }
        return `早报现在${设.早开 ? `开，每天 ${点钟(设.早时)}` : '关'}。要改时间就发 */早报 07:30`
      }
      case '晚报': case '晚间': case '明天': {
        const t = 参 ? 解析时刻(参, null) : null
        if (t !== null) { 写对端(号, { 晚: { 开: true, 时: t } }); return `晚报改到 ${点钟(t)} 了，晚上这个点给你说明天的天气` }
        if (参) { const 要 = 说开(参, 设.晚开); 写对端(号, { 晚: { 开: 要, 时: 设.晚时 } }); return `晚间预告${要 ? `开了，每天 ${点钟(设.晚时)}` : '关了'}` }
        return `晚间预告现在${设.晚开 ? `开，每天 ${点钟(设.晚时)}` : '关'}。要改时间就发 */晚报 21:00`
      }
      case '突变': case '预警': case '提醒': {
        const 要 = 参 ? 说开(参, 设.突变) : !设.突变
        写对端(号, { 突变: 要 })
        return 要 ? '突变提醒开了：天气要明显变坏（降温、下雨、起风）的时候我会提一句' : '突变提醒关了'
      }
      case '状态': case '设置': case '我的': {
        const 城 = 设.城 ? 设.城.名 : `还没设（先按服务器所在地 ${S.地 ? S.地.名 : '未知'} 报）`
        const 状 = S.警[设.号] || {}
        const 今日 = 状.日 === 本地日期(new Date()) ? Number(状.数) || 0 : 0
        return [
          `【天气台】${设.名 ? `${设.名} · ` : ''}${设.号}`,
          `位置：${城}`,
          `早报：${设.早开 ? `每天 ${点钟(设.早时)}` : '关'}`,
          `晚报：${设.晚开 ? `每天 ${点钟(设.晚时)}` : '关'}`,
          `突变提醒：${设.突变 ? '开' : '关'}`,
          `今天已提醒：${今日} 次（全局上限 ${c.每天上限} 次，静默 ${点钟(c.静默起)}~${点钟(c.静默止)}）`,
        ].join('\n')
      }
      default:
        // 兜底：万一是机器码/链接混进来的，宁可沉默也不原样回显给对方
        if (/CQ:|,|\/\/|multimedia|rkey=/i.test(令名)) return ''
        return `不认识的指令「${令名}」。发 */帮助 看看都能设什么`
    }
  }

  /** 记下这个人的消息读到哪儿了 */
  function 记阅(号, 条) {
    const t = Number(条 && 条.time) || Math.floor(Date.now() / 1000)
    const k = String(号)
    const 旧 = S.对端[k] || { 名: '', 首: Date.now() }
    S.对端[k] = { ...旧, 阅: t * 1000 + 1000 }
    存对端()
  }

  /**
   * 每轮看一眼：谁私聊发了指令 / 谁第一次私聊过来。
   * 第一次私聊过来的人，主动发一次指令详情（只发一次）。
   */
  async function 处理指令() {
    const { base, token } = 解析QQ目标s(配置)
    if (!base) return 0
    let 自己 = 0
    try {
      const j = await 取OneBotPost(base, token, 'get_login_info', {})
      自己 = Number(j && j.data && j.data.user_id) || 0
    } catch (e) { 自己 = 0 }
    let 动 = 0
    for (const t of 指令对象()) {
      const 号 = 数号(t.号)
      const 阅 = Number((S.对端[t.号] && S.对端[t.号].阅) || 0) || 0
      let 们 = []
      try {
        const j = await 取OneBotPost(base, token, 'get_friend_msg_history', { user_id: 号, count: 8 })
        们 = j && j.data && Array.isArray(j.data.messages) ? j.data.messages : []
      } catch (e) { continue }
      const 来 = 们.filter((m) => m && Number(m.user_id) === 号 && Number(m.time) * 1000 > 阅)
      if (!来.length) continue
      const 末 = 来[来.length - 1]
      const 新的 = 保对端(t.号, t.名 || (末.sender && 末.sender.nickname) || '')
      // 第一次接入（或者从来还没读过消息）：主动把指令详情发一次，只发这一次
      if (新的 || !阅) {
        const 回 = await 发QQ({ base, token, 号: t.号 }, 指令说明)
        if (回.ok) { 记阅(t.号, 末); 日志(`QQ ${t.号} 第一次私聊，已发指令详情`); 动++ }
        continue
      }
      for (const m of 来) {
        const 位 = 段位置(m.message)
        if (位) {
          写对端(t.号, { 城: { 名: 位.名 || '发来的位置', 纬: 位.纬, 经: 位.经, 来源: 'QQ 位置' } })
          for (const k of Object.keys(S.城快照)) delete S.城快照[k]
          const 地字 = 位.名 || `${位.纬.toFixed(2)},${位.经.toFixed(2)}`
          const 回 = await 发QQ({ base, token, 号: t.号 }, `收到位置：${地字}。以后天气就按这儿说。`)
          if (回.ok) 动++
          continue
        }
        const 令 = 解析指令(m.raw_message || 段文本(m.message))
        if (!令) continue
        let 答 = ''
        try { 答 = await 应指令(t.号, 令.令, 令.参) } catch (e) { 答 = `这条没处理成：${(e && e.message) || e}` }
        if (!答) continue
        const 回 = await 发QQ({ base, token, 号: t.号 }, 答)
        if (回.ok) 动++
        else 日志(`回 QQ ${t.号} 失败：${回.说}`, 'warn')
      }
      记阅(t.号, 末)
    }
    return 动
  }

  // ── 定位 / 快照 ─────────────────────────────────────────────────────────
  async function 要地点(强制 = false) {
    const 指定 = String(配置.place || '').trim()
    // 配了城市就以它为准，别被上次自动定位的缓存盖住
    if (指定 && (!S.地 || !String(S.地.名 || '').includes(指定.replace(/市$/, '')))) 强制 = true
    if (!强制 && S.地 && Date.now() - S.地时间 < PLACE_TTL_MS) return S.地
    if (指定) {
      const r = await 查地名(指定)
      if (r) { S.地 = r; S.地时间 = Date.now(); S.地缓存 = false; S.定位说明 = `控制台/配置里指定：${指定}`; 记下地点(r, '手动'); return r }
      日志(`地名「${指定}」没查到，退回自动定位`, 'warn')
    }
    const auto = await 定位()
    if (auto) {
      // IP 只给到市（还常是英文/带运营商），拿候选名逐个地理编码：坐标更准、名字是中文
      let 地 = null
      for (const 名 of auto.候选) {
        try { 地 = await 查地名(名) } catch (e) { 地 = null }
        if (地) { S.定位说明 = `${auto.家数} 家 IP 库响应，取「${名}」`; break }
      }
      if (!地 && Number.isFinite(auto.纬) && Number.isFinite(auto.经)) {
        地 = await 换中文名({ 名: auto.候选[0], 国: auto.国, 纬: auto.纬, 经: auto.经 })
        S.定位说明 = `地理编码没结果，直接用 IP 坐标（${auto.候选[0]}）`
      }
      if (地) {
        S.地 = 地
        S.地时间 = Date.now()
        S.地缓存 = false
        记下地点(地, '自动')
        return S.地
      }
    }
    return S.地
  }

  async function 刷新(强制 = false) {
    if (S.取中) return S.取中
    if (!强制 && S.快 && Date.now() - S.快时间 < TTL_MS) return S.快
    S.取中 = (async () => {
      try {
        const 地 = await 要地点()
        if (!地) { 日志('定位失败，这一轮没有天气', 'warn'); return null }
        const 快 = await 取天气(地.纬, 地.经)
        S.快 = 快
        S.快时间 = Date.now()
        return 快
      } catch (e) {
        日志(`取天气失败：${e && e.message}`, 'warn')
        return null
      } finally {
        S.取中 = null
      }
    })()
    return S.取中
  }

  /** 给上下文用的那一行（同步、绝不抛）*/
  function 一行() {
    try {
      if (!S.快 || !S.地) return ''
      const 快 = S.快
      const 段 = [当前一句话(S.地.名, 快)]
      const 今 = 今天一句话(快)
      if (今) 段.push(今)
      const 后 = 未来几小时一句话(快, 6)
      if (后) 段.push(后)
      const 建 = 建议(快)
      if (建) 段.push(`（${建}）`)
      const 更新 = new Date(S.快时间)
      return `【天气】${段.join('；')}。数据 ${两(更新.getHours())}:${两(更新.getMinutes())} 更新；要更细的逐小时/多日预报就调 weather 工具。`
    } catch (e) {
      return ''
    }
  }

  // ── 主动说话 ────────────────────────────────────────────────────────────
  async function 说一句(agent, 文本) {
    try {
      if (!agent || typeof agent.followup !== 'function') return false
      // ⚠️ 必须 await 并兜住：followup 返回 Promise，漏接管 rejection 会把宿主带走
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 文本 }],
        source: { kind: 'weather' },
      })
      return true
    } catch (e) {
      日志(`叫醒 ${String(agent && agent.id)} 失败：${e && e.message}`, 'warn')
      return false
    }
  }

  function 根会话() {
    try {
      const rs = typeof ctx.agents.roots === 'function' ? ctx.agents.roots() : ctx.agents.list()
      return Array.isArray(rs) ? rs : []
    } catch (e) { return [] }
  }

  /** 会话 id → 标题（"QQ好友 · 123456789" 这种），用来找出跟某个 QQ 号对应的那个会话 */
  function 会话标题表() {
    const 表 = new Map()
    try {
      const 目录 = join(取根(), 'storages', 'session_projcache', 'sessions')
      for (const f of readdirSync(目录)) {
        if (!f.endsWith('.json')) continue
        try {
          const j = JSON.parse(readFileSync(join(目录, f), 'utf8'))
          const t = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val
          if (t) 表.set(f.replace(/\.json$/, ''), String(t))
        } catch (e) { /* 单个会话文件坏了不影响别的 */ }
      }
    } catch (e) { /* 读不到就当成没有 */ }
    return 表
  }

  /** 本机兜底：只叫醒跟这个 QQ 号（或这个昵称）对得上号的那个会话，绝不广播 */
  async function 叫对应会话(号, 名, 提示) {
    const 表 = 会话标题表()
    const 号字 = String(号 || '')
    const 名子 = String(名 || '').trim()
    let 本机 = 0
    let 命中 = 0
    for (const a of 根会话()) {
      const t = 表.get(String(a && a.id)) || ''
      const 是 = (号字 && t.includes(号字)) || (名子 && t.includes(名子))
      if (!是) continue
      命中++
      if (await 说一句(a, 提示)) 本机++
    }
    if (!命中) 日志(`QQ ${号} 发送失败，但没找到对应会话，本次不叫本机`, 'warn')
    return 本机
  }

  /**
   * 推给一个人。QQ 开着且发成功就到此为止；QQ 没开 / 没配好 / 发失败 → 退回本机 followup，
   * 让模型用自己的口吻再说一遍（消息不丢）。
   */
  async function 送(号, 文本, 提示) {
    if (配置.qqOn) {
      const { base, token } = 解析QQ目标s(配置)
      if (base) {
        const 回 = await 发QQ({ base, token, 号 }, 文本)
        if (回.ok) {
          日志(`${回.说}`)
          if (!配置.qqAlsoFollowup) return { qq: true, 本机: 0 }
        } else 日志(`QQ 没发出去（${回.说}），退回本机叫醒`, 'warn')
      } else 日志('没找到 OneBot 地址，退回本机叫醒', 'warn')
    }
    let 本机 = 0
    const 名 = (S.对端[号] && S.对端[号].名) || ''
    本机 = await 叫对应会话(号, 名, 提示 || 文本)
    return { qq: false, 本机 }
  }

  /** 只在本机叫醒（没有服务对象时用） */
  async function 叫人(提示) {
    let 本机 = 0
    for (const a of 根会话()) if (await 说一句(a, 提示)) 本机++
    return 本机
  }

  /** 某一天的日出日落；配置里关掉就返回空串 */
  function 日照(t) {
    if (!配置.sunOn || !t || !t.日出 || !t.日落) return ''
    return `日出 ${t.日出}、日落 ${t.日落}`
  }

  // ── 把天气说成聊天话 ─────────────────────────────────────────────────
  /** 宿主默认模型；拿不到就 null（用模板兜底） */
  function 宿主模型() {
    try {
      const s = ctx.get && ctx.get('agentDefaultModel')
      const 选 = s && typeof s.currentSelection === 'function' ? s.currentSelection() : null
      if (选 && 选.provider && 选.model) return 选
    } catch (e) {}
    return null
  }

  /** 让宿主模型写一句；失败返回空串，绝不抛出 */
  async function 问模型(系统, 提示, 最多 = 200) {
    const 选 = 宿主模型()
    const 服务 = (ctx.get && ctx.get('llm')) || ctx.llm || null
    if (!选 || !服务 || typeof 服务.stream !== 'function') return ''
    let 出 = ''
    try {
      const 信 = 服务.stream({
        provider: 选.provider,
        model: 选.model,
        system: 系统,
        messages: [{ role: 'user', content: [{ type: 'text', text: 提示 }] }],
        maxTokens: 最多,
        temperature: 0.95,
        signal: AbortSignal.timeout(20000),
      })
      for await (const 块 of 信) if (块 && 块.type === 'text-delta' && typeof 块.text === 'string') 出 += 块.text
    } catch (e) {
      S.错 = `换口吻失败：${(e && e.message) || e}`
      return ''
    }
    return String(出 || '').replace(/\s+/g, ' ').trim().replace(/^["“「'‘`]+|["”」'’`]+$/g, '').trim()
  }

  /** 事实底稿：给模型和模板共用 */
  function 事实底稿(场景, 地, 快) {
    const 名 = 地 ? 地.名 : '这边'
    const 今 = 快.天 && 快.天[0]
    const 明 = 快.天 && 快.天[1]
    if (场景 === '晚') {
      if (!明) return ''
      const 行 = [`${名}，明天${说天气(明.代码)} ${说话(明.低)}~${说话(明.高)}°C`]
      if (明.降水概率 !== null && 明.降水概率 >= 20) 行.push(`降水概率${说话(明.降水概率)}%`)
      if (今 && Number.isFinite(今.高) && Number.isFinite(明.高)) {
        const 差 = 明.高 - 今.高
        if (Math.abs(差) >= 3) 行.push(`最高温比今天${差 > 0 ? '高' : '低'}${说话(Math.abs(差))}°C`)
      }
      const 日 = 日照(明)
      if (日) 行.push(日)
      return 行.join('；')
    }
    const 行 = [`${名}，${当前一句话('', 快)}`]
    if (今) 行.push(`今天${说天气(今.代码)} ${说话(今.低)}~${说话(今.高)}°C`)
    const 近 = 未来几小时一句话(快, 6)
    if (近) 行.push(近)
    const 建 = 建议(快)
    if (建) 行.push(`要留意：${建}`)
    const 日 = 日照(今)
    if (日) 行.push(日)
    return 行.join('；')
  }

  const 随机 = (a) => a[Math.floor(Math.random() * a.length)]

  /** 模板兜底：随机句式 + 随机细节，尽量不像通报 */
  function 模板话(场景, 地, 快, 补充 = '') {
    const 名 = 地 ? 地.名 : '这边'
    const 今 = 快.天 && 快.天[0]
    const 明 = 快.天 && 快.天[1]
    if (场景 === '变') {
      const 话 = 补充 ? 补充.replace(/[；。]/g, '，') : '天气有点变化'
      return `${随机(['对了，', '提一句，', '刚看了一眼，'])}${名}${随机(['这边', '', ''])}${话}，${随机(['注意着点', '你留意下', '别大意', '顺手提醒你'])}`
    }
    if (场景 === '晚') {
      if (!明) return ''
      const 差 = 今 && Number.isFinite(今.高) && Number.isFinite(明.高) ? 明.高 - 今.高 : null
      const 叮嘱 = 明.降水概率 !== null && 明.降水概率 >= 50 ? '估计得带伞'
        : 差 !== null && 差 <= -4 ? '比今天冷不少，记得添件'
          : 差 !== null && 差 >= 4 ? '比今天暖一点'
            : ''
      const 句 = 随机([
        `${随机(['对了，', '说一声，', '提前说下，'])}${名}明天${说天气(明.代码)}，${说话(明.低)}~${说话(明.高)}°C${叮嘱 ? `，${叮嘱}` : ''}`,
        `明天${说话(明.低)}~${说话(明.高)}°C，${说天气(明.代码)}${叮嘱 ? `，${叮嘱}` : ''}，${名}这边`,
        `${名}明天${说天气(明.代码)}${叮嘱 ? `，${叮嘱}` : ''}，${说话(明.低)}到${说话(明.高)}°C`,
      ])
      return `${句}${随机(['。', '，早点睡。', '，晚安。'])}`
    }
    const 建 = 建议(快)
    const 今句 = 今 ? `今天${说天气(今.代码)}，${说话(今.低)}~${说话(今.高)}°C` : ''
    const 句 = 随机([
      `${随机(['早，', '早呀，', '起来了没，'])}${名}${今句}${建 ? `，${建}` : ''}`,
      `${今句}${建 ? `，${建}` : ''}，${名}${随机(['这边', ''])}`,
      `${随机(['早上好，', ''])}${名}${随机(['外头', '今天'])}${说天气(今 ? 今.代码 : null)}${建 ? `，${建}` : ''}，温度大概${说话(今.低)}~${说话(今.高)}°C`,
    ])
    return 句 + 随机(['', '。', '，出门顺心。'])
  }

  /** 主入口：优先让模型写，失败退回模板；返回 {文, 来源} */
  async function 聊天气(场景, 地, 快, 补充 = '') {
    const 底 = 事实底稿(场景, 地, 快)
    if (!底) return { 文: '', 来源: '无' }
    const 系统 = '你是「鱼鱼」，在 QQ 上跟熟人随口聊天，不是播报员。用中文口语，1~3 句、60 字以内。把下面给的事实自然说出来：可以换说法、可以只挑最要紧的说，但不要编造事实里没有的天气、温度、降水，也不要编造持续时长、时段或别的地方的情况；别加标题、别用列表、别堆一堆数字；别用「为您播报」「温馨提示」「请注意查收」这种腔调；不要每句都用一样的开头。该提醒（带伞、添衣、防晒、风大、冷）就顺口带一句，不用硬凑。'
    const 角度 = 随机(['先说今天天气，再说要不要添衣', '先说温度感受，再说天气', '先说出门建议，再补一句天气', '只说最要紧的一句话，别面面俱到', '先关心对方一句，再说天气', '先说这会儿的感觉，再说明天/今天的变化', '直接说天气，别问候'])
    const 提示 = [
      场景 === '晚' ? '现在是晚上，跟对方说明天出门要注意什么。' : 场景 === '变' ? '天气有变化，随口提醒对方一句。' : '现在是早上，跟对方说今天天气。',
      底,
      补充 ? `另外：${补充}` : '',
      `这句话的切入点：${角度}。换一种句式，别每次都一个套路。`,
      '只输出要说的话本身，不要引号，不要解释。',
    ].filter(Boolean).join('\n')
    const 文 = await 问模型(系统, 提示)
    if (文) return { 文, 来源: '模型' }
    return { 文: 模板话(场景, 地, 快, 补充), 来源: '模板' }
  }

  async function 播早报() {
    const c = 现刻()
    const now = new Date()
    const 分 = 本地分钟(now)
    if (在区间内(分, c.静默起, c.静默止)) return
    const 今天 = 本地日期(now)
    const 们 = 服务对象()
    if (!们.length) {
      // 没有任何服务对象：至少在自己这边说一句
      const 快 = S.快
      if (!快 || Date.now() - S.快时间 > 30 * 60 * 1000 || S.早报日 === 今天) return
      if (分 < c.早报 || 分 > c.早报 + Math.max(c.早报窗口, c.补发窗口)) return
      const 全 = (await 聊天气('早', S.地, 快)).文
      const 本机 = await 叫人([全, `现在 ${两(now.getHours())}:${两(now.getMinutes())}。用你自己的口吻跟用户说一句早安和今天的天气要点，1~2 句就够，别罗列数据、别用列表。`].join('\n'))
      if (本机) { S.早报日 = 今天; 存对端(); 日志(`早报已叫醒 ${本机} 个会话`) }
      return
    }
    for (const t of 们) {
      const 设 = 有效设置(t.号, t.名)
      if (!设.早开) continue
      if (分 < 设.早时 || 分 > 设.早时 + Math.max(c.早报窗口, c.补发窗口)) continue
      if (S.已发[t.号] && S.已发[t.号].早 === 今天) continue
      const x = await 对象快照(t.号).catch(() => null)
      if (!x || Date.now() - x.时 > 30 * 60 * 1000) continue // 数据太旧就等下一次
      const 全 = (await 聊天气('早', x.地, x.快)).文
      const 提示 = [全, `现在 ${两(now.getHours())}:${两(now.getMinutes())}。用你自己的口吻跟用户说一句早安和今天的天气要点，1~2 句就够，别罗列数据、别用列表。`].join('\n')
      const 出 = await 送(t.号, 全, 提示)
      if (出.qq || 出.本机) {
        S.已发[t.号] = { ...(S.已发[t.号] || {}), 早: 今天 }
        存对端()
        日志(`早报已送 QQ ${t.号}${出.qq ? '' : '（退回本机）'}`)
      }
    }
  }

  async function 播晚间() {
    const c = 现刻()
    const now = new Date()
    const 分 = 本地分钟(now)
    if (在区间内(分, c.静默起, c.静默止)) return
    const 今天 = 本地日期(now)
    const 们 = 服务对象()
    if (!们.length) {
      const 快 = S.快
      if (!快 || Date.now() - S.快时间 > 60 * 60 * 1000 || S.晚间日 === 今天) return
      if (分 < c.晚间 || 分 > c.晚间 + Math.max(c.晚间窗口, c.补发窗口)) return
      const 全 = (await 聊天气('晚', S.地, 快)).文
      if (!全) return
      const 本机 = await 叫人([全, `现在 ${两(now.getHours())}:${两(now.getMinutes())}。用你自己的口吻提醒用户明天出门要留意什么，1~2 句，别罗列数据、别用列表。`].join('\n'))
      if (本机) { S.晚间日 = 今天; 存对端(); 日志(`晚间预告已叫醒 ${本机} 个会话`) }
      return
    }
    for (const t of 们) {
      const 设 = 有效设置(t.号, t.名)
      if (!设.晚开) continue
      if (分 < 设.晚时 || 分 > 设.晚时 + Math.max(c.晚间窗口, c.补发窗口)) continue
      if (S.已发[t.号] && S.已发[t.号].晚 === 今天) continue
      const x = await 对象快照(t.号).catch(() => null)
      if (!x || Date.now() - x.时 > 60 * 60 * 1000) continue
      const 全 = (await 聊天气('晚', x.地, x.快)).文
      if (!全) continue
      const 提示 = [全, `现在 ${两(now.getHours())}:${两(now.getMinutes())}。用你自己的口吻提醒用户明天出门要留意什么，1~2 句，别罗列数据、别用列表。`].join('\n')
      const 出 = await 送(t.号, 全, 提示)
      if (出.qq || 出.本机) {
        S.已发[t.号] = { ...(S.已发[t.号] || {}), 晚: 今天 }
        存对端()
        日志(`晚间预告已送 QQ ${t.号}${出.qq ? '' : '（退回本机）'}`)
      }
    }
  }

  async function 查预警() {
    const c = 现刻()
    const now = new Date()
    const 分 = 本地分钟(now)
    if (在区间内(分, c.静默起, c.静默止)) return
    const 今天 = 本地日期(now)
    for (const t of 服务对象()) {
      const 设 = 有效设置(t.号, t.名)
      if (!设.突变) continue
      const 状 = S.警[t.号] || (S.警[t.号] = { 日: '', 数: 0, 上次: 0, 上次各类: {} })
      if (状.日 !== 今天) { 状.日 = 今天; 状.数 = 0; 状.上次各类 = {} }
      if (状.数 >= c.每天上限) continue
      if (Date.now() - 状.上次 < c.最小间隔) continue
      const x = await 对象快照(t.号).catch(() => null)
      if (!x) continue
      const 候选 = 找突变(x.快)
        .filter((y) => Date.now() - (状.上次各类[y.类] || 0) > c.同类间隔)
        .sort((a, b) => b.重 - a.重)
      if (!候选.length) continue
      const 主 = 候选[0]
      const 其余 = 候选.slice(1, 3).map((y) => y.说)
      const 变句 = `${主.说}${其余.length ? `；另外${其余.join('；')}` : ''}`
      const 全 = (await 聊天气('变', x.地, x.快, 变句)).文
      const 提示 = [全, `现在 ${两(now.getHours())}:${两(now.getMinutes())}。如果这会儿合适，就自然地跟用户提一句，短一点、像随口说的；不用念数据。`].join('\n')
      const 出 = await 送(t.号, 全, 提示)
      if (出.qq || 出.本机) {
        状.上次 = Date.now()
        状.上次各类[主.类] = Date.now()
        状.数++
        存对端()
        日志(`预警「${主.类}」已送 QQ ${t.号}${出.qq ? '' : '（退回本机）'}`)
      }
    }
  }

  /** 自检：现在到底配成了什么样（不打印令牌，只说有没有）*/
  function 自检() {
    const c = 现刻()
    const 行 = []
    const 地 = S.地 ? `${S.地.名}（${S.地位源 || '未知来路'}${S.地缓存 ? '·沿用上次' : ''}）` : '还没定位到'
    const 快 = S.快 ? `${两(new Date(S.快时间).getHours())}:${两(new Date(S.快时间).getMinutes())} 更新` : '还没有数据'
    行.push(`定位：${地}　天气快照：${快}`)
    if (S.定位说明) 行.push(`定位依据：${S.定位说明}`)
    const 今天 = 本地日期(new Date())
    行.push(`全局默认：早报 ${配置.briefEnabled ? 点钟(c.早报) : '关'}，晚报 ${配置.eveningOn ? 点钟(c.晚间) : '关'}，静默 ${点钟(c.静默起)}~${点钟(c.静默止)}，一天最多 ${c.每天上限} 次突变提醒`)
    const 目 = 解析QQ目标s(配置)
    const 们 = 指令对象()
    const 收播报的号 = new Set(服务对象().map((x) => String(x.号)))
    if (!配置.qqOn) 行.push('QQ：关（主动消息只在本机叫醒）')
    else if (!目.base) 行.push('QQ：开，但没找到 OneBot 地址（qqNapcat / 桥配置 / qqConfigFile 都没给）')
    else 行.push(`QQ：开 @ ${目.base}（令牌${目.token ? '已配' : '未配'}）`)
    if (!们.length) 行.push('服务对象：还没有（控制台里选一个 QQ 号，或让对方私聊一句来设位置）')
    for (const t of 们) {
      const 设 = 有效设置(t.号, t.名)
      const 状 = S.警[t.号] || {}
      const 今日 = 状.日 === 今天 ? Number(状.数) || 0 : 0
      const 名 = 设.名 ? `（${设.名}）` : ''
      const 收 = 收播报的号.has(String(设.号)) ? '收播报' : '只设不收'
      行.push(`  · ${设.号}${名} [${收}] 位置 ${设.城 ? 设.城.名 : '未设·按本机'}，早报 ${设.早开 ? 点钟(设.早时) : '关'}，晚报 ${设.晚开 ? 点钟(设.晚时) : '关'}，突变 ${设.突变 ? `开（今天 ${今日}/${c.每天上限}）` : '关'}`)
    }
    const 自家 = String(配置.qqConfigFile || '').trim()
    行.push(`桥配置文件：${自家 ? `${自家}${自家配置(配置) ? '（已读到）' : '（读不到）'}` : '未填'}`)
    const 跳 = S.心跳时 ? `${两(new Date(S.心跳时).getHours())}:${两(new Date(S.心跳时).getMinutes())} 最后一次` : '还没跳过'
    行.push(`心跳（每 ${Math.round(LOOP_MS / 1000)} 秒一次）：${S.心跳} 次，${跳}`)
    if (S.错) 行.push(`最近一次报错：${S.错}`)
    return 行.join('\n')
  }

  // ── 控制台：本机 HTTP 页面（浏览器打开 http://127.0.0.1:4187/dsh-weather/）──
  function 取状态() {
    const c = 现刻()
    const 目 = 解析QQ目标s(配置)
    const 今天 = 本地日期(new Date())
    const 快 = S.快
    const 现 = 快 && 快.现
    return {
      配置: {
        ...配置,
        qqToken: '',                 // 令牌不回传给浏览器
        qqToken已配: !!(目 && 目.token),
        caiyunToken: '',             // 同样不回传；只看有没有配
        caiyunToken已配: !!彩云令牌,
        数据源: 彩云令牌 ? 'caiyun' : 'open-meteo',
      },
      默认: DEFAULTS,
      状态: {
        城市: S.地 ? S.地.名 : '',
        定位来源: S.地位源,
        定位说明: S.定位说明 || '',
        快照时间: S.快时间 ? `${两(new Date(S.快时间).getHours())}:${两(new Date(S.快时间).getMinutes())}` : '',
        概览: 一行(),
        现在: 现 ? {
          温: 现.温, 天气: 说天气(现.代码), 体感: 现.体感, 湿度: 现.湿度, 风: 现.风,
        } : null,
        今天: 快 && 快.天 && 快.天[0] ? 快.天[0] : null,
        明天: 快 && 快.天 && 快.天[1] ? 快.天[1] : null,
        早报日: S.早报日, 晚间日: S.晚间日,
        今日预警: S.预警日 === 今天 ? S.今日预警数 : 0,
        心跳: S.心跳,
        心跳时: S.心跳时 ? `${两(new Date(S.心跳时).getHours())}:${两(new Date(S.心跳时).getMinutes())}` : '',
        错: 抹令牌(S.错) || '',
        计划: { 早报: c.早报, 晚间: c.晚间, 静默起: c.静默起, 静默止: c.静默止 },
      },
      QQ: {
        开: !!配置.qqOn,
        地址: 目 && 目.base ? 目.base : '',
        有令牌: !!(目 && 目.token),
      },
      // 每个人自己的设置（位置/早报/晚报/突变）——只认私聊；收播报看控制台勾没勾
      对端: 指令对象().map((t) => {
        const 设 = 有效设置(t.号, t.名)
        const 状 = S.警[t.号] || {}
        const 今日 = 状.日 === 今天 ? Number(状.数) || 0 : 0
        return {
          号: 设.号,
          名: 设.名,
          城: 设.城 ? 设.城.名 : '',
          早: 设.早开 ? 设.早时 : -1,
          晚: 设.晚开 ? 设.晚时 : -1,
          突变: 设.突变,
          今日警: 今日,
          私聊过: !!(S.对端[设.号] && S.对端[设.号].首),
          收播报: 服务对象().some((x) => String(x.号) === String(设.号)),
        }
      }),
    }
  }

  try {
    const web = ctx.webServer || (ctx.get && ctx.get('webServer')) || null
    if (web && typeof web.register === 'function') {
      // 旧的独立控制台页面已下线（设置都搬到左侧边栏「天气关怀」里了），这里只留一个提示页
      const 提示页 = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>天气关怀</title>
<style>body{font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:48px 24px;background:#f7f8fa;color:#1f2430}
main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e6eb;border-radius:14px;padding:28px 30px}
h1{font-size:19px;margin:0 0 10px}p{margin:8px 0;color:#4a5262}code{background:#f0f2f5;padding:2px 6px;border-radius:5px}</style>
<main><h1>天气关怀已经搬进 DSH 左侧边栏</h1>
<p>打开 DSH 客户端，点左栏的「<b>天气关怀</b>」，位置、早晚时间、突变提醒、QQ 推送对象都在那里改。</p>
<p>纯浏览器访问时请用 DSH 打印出来的那个带 token 的地址，再从左栏进。</p></main></html>`
      const 读页 = () => 提示页
      const 回 = (res, 码, 类型, 体) => {
        try {
          res.statusCode = 码
          res.setHeader('content-type', 类型)
          res.setHeader('cache-control', 'no-store')
          res.end(体)
        } catch (e) { /* 已经断开就算了 */ }
      }
      const JSON回 = (res, 码, 体) => 回(res, 码, 'application/json; charset=utf-8', JSON.stringify(体))
      // 参数一律走 query string：宿主会在进 handler 前把 body 读掉，读 req 的 data 事件拿到的是空的
      const 查表 = (u) => {
        const o = {}
        for (const [k, v] of u.searchParams) o[k] = v
        return o
      }

      ctx.effect(() => web.register({
        kind: 'prefix',
        path: '/dsh-weather',
        handler: async (req, res) => {
          try {
            const u = new URL(req.url || '/', 'http://localhost')
            const p = u.pathname.replace(/\/+$/, '') || '/dsh-weather'
            const 方法 = String(req.method || 'GET').toUpperCase()

            // 简单来源校验：只接受本机同源 / 直接访问（curl、客户端自己的 fetch）。
            // 别的网站发起的跨站请求会被挡掉，免得被当成 CSRF 打进来改设置、读到 QQ 号。
            const 站 = String(req.headers['sec-fetch-site'] || '')
            if (站 === 'cross-site' || 站 === 'same-site') {
              return JSON回(res, 403, { ok: false, 说: '只接受本机同源访问' })
            }
            const 源 = String(req.headers.origin || '')
            if (源) {
              let 跨 = false
              try {
                const o = new URL(源)
                // http(s) 来源必须跟宿主一致；dsh-app:// 这类桌面客户端的自有协议放行
                if (o.protocol === 'http:' || o.protocol === 'https:') 跨 = o.host !== String(req.headers.host || '')
              } catch (e) { 跨 = false }
              if (跨) return JSON回(res, 403, { ok: false, 说: '只接受同源访问' })
            }

            if (p === '/dsh-weather' && !/\/$/.test(u.pathname)) {
              res.statusCode = 302
              res.setHeader('location', '/dsh-weather/')
              return res.end()
            }
            if (p === '/dsh-weather' || p === '/dsh-weather/index.html') return 回(res, 200, 'text/html; charset=utf-8', 读页())
            if (p === '/dsh-weather/api/state') return JSON回(res, 200, 取状态())

            if (p === '/dsh-weather/api/save') {
              const 改 = 存配置(查表(u))
              if ('place' in 改) { S.地 = null; S.地时间 = 0; S.地缓存 = false } // 换了城市就重新定位
              void 刷新(true).catch(() => {})
              日志(`控制台改了配置：${Object.keys(改).join('、') || '（无变化）'}`)
              return JSON回(res, 200, { ok: true, 改了: 改, ...取状态() })
            }

            if (p === '/dsh-weather/api/locate' && 方法 === 'POST') {
              S.地 = null; S.地时间 = 0; S.地缓存 = false; S.定位说明 = ''
              await 刷新(true).catch(() => {})
              return JSON回(res, 200, { ok: true, ...取状态() })
            }

            if (p === '/dsh-weather/api/version') {
              // 控制台拿它做「代码改了就自己刷新」：两个半边的 mtime 一变就算新版
              const 时 = (f) => { try { return Math.round(statSync(f).mtimeMs) } catch (e) { return 0 } }
              const 半 = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
              return JSON回(res, 200, { ok: true, v: `${时(join(半, 'index.js'))}.${时(join(半, 'client.js'))}` })
            }

            if (p === '/dsh-weather/api/targets') {
              const 单 = 查表(u)
              const 名 = await 拉名单(配置, 单.force === '1')
              return JSON回(res, 200, { ...名, ...取状态() })
            }

            if (p === '/dsh-weather/api/test-qq' && 方法 === 'POST') {
              const { base, token } = 解析QQ目标s(配置)
              const 名单 = 服务对象()
              let 发 = 0
              const 跳 = []
              const 失败 = []
              for (const t of 名单) {
                const 设 = 有效设置(t.号)
                if (!设.城 || !设.城.名) { 跳.push(String(t.号)); continue }
                const 快 = await 对象快照(t.号)
                if (!快 || !快.地) { 失败.push(`${t.号}：查不到「${设.城.名}」`); continue }
                const 文本 = `【天气】测试消息：${快.地.名} ${当前一句话('', 快.快)}。`
                const 回 = await 发QQ({ base, token, 号: t.号 }, 文本)
                if (回.ok) 发++
                else 失败.push(`${t.号}：${回.说}`)
              }
              return JSON回(res, 200, {
                ok: true,
                说: `发出 ${发} 条${跳.length ? `；跳过没设位置的 ${跳.length} 个（${跳.join('、')}）` : ''}${失败.length ? `；失败 ${失败.length} 个（${失败.join('；')}）` : ''}`,
                ...取状态(),
              })
            }

            if (p === '/dsh-weather/api/preview') {
              const 快 = S.快
              if (!快 || !S.地) return JSON回(res, 200, { ok: false, 说: '还没有天气数据，先等一次心跳' })
              const 早 = await 聊天气('早', S.地, 快)
              const 晚 = await 聊天气('晚', S.地, 快)
              return JSON回(res, 200, {
                ok: true,
                早报: 早.文,
                早报来源: 早.来源,
                晚间预告: 晚.文,
                晚间来源: 晚.来源,
                模型: (() => { const 选 = 宿主模型(); return 选 ? `${选.provider}/${选.model}` : '没拿到默认模型' })(),
              })
            }

            // 控制台改某个人的设置：/api/peer?号=123456789&城市=杭州&早报=07:30&早报开=1&晚报=21:00&晚报开=0&突变=1
            if (p === '/dsh-weather/api/peer') {
              const q = 查表(u)
              const 号 = String(q.号 || q.target || '').replace(/^private:/, '')
              if (!/^\d{4,12}$/.test(号)) return JSON回(res, 400, { ok: false, 说: '号 形如 123456789' })
              保对端(号)
              const 补 = {}
              if ('城市' in q) {
                const 名 = String(q.城市 || '').trim()
                if (!名) { 写对端(号, { 城: null }) }
                else {
                  const 地 = await 查地名(名)
                  if (!地) return JSON回(res, 200, { ok: false, 说: '没查到这个地方，换个说法试试' })
                  补.城 = { 名: 地.名, 纬: 地.纬, 经: 地.经 }
                }
              }
              if ('早报' in q) { const t = 解析时刻(q.早报, null); if (t !== null) 补.早 = { ...(补.早 || {}), 时: t, 开: true } }
              if ('早报开' in q) 补.早 = { ...(补.早 || {}), 开: q.早报开 === '1' || q.早报开 === 'true' }
              if ('晚报' in q) { const t = 解析时刻(q.晚报, null); if (t !== null) 补.晚 = { ...(补.晚 || {}), 时: t, 开: true } }
              if ('晚报开' in q) 补.晚 = { ...(补.晚 || {}), 开: q.晚报开 === '1' || q.晚报开 === 'true' }
              if ('突变' in q) 补.突变 = q.突变 === '1' || q.突变 === 'true'
              if (Object.keys(补).length) 写对端(号, 补)
              return JSON回(res, 200, { ok: true, ...取状态() })
            }

            // 从服务名单里去掉一个人（他还想收就再私聊一句，会自动加回来）
            if (p === '/dsh-weather/api/peer-remove') {
              const q = 查表(u)
              const 号 = String(q.号 || '').replace(/^private:/, '')
              if (!/^\d{4,12}$/.test(号)) return JSON回(res, 400, { ok: false, 说: '号 形如 123456789' })
              delete S.对端[号]
              存对端()
              存配置({ qqUsers: 号单(配置.qqUsers).filter((x) => x !== 号) })
              return JSON回(res, 200, { ok: true, ...取状态() })
            }

            JSON回(res, 404, { ok: false, 说: `没有这个路径：${p}` })
          } catch (e) {
            JSON回(res, 500, { ok: false, 说: String((e && e.message) || e) })
          }
        },
      }))
      日志('控制台已挂上：/dsh-weather/')
    } else {
      日志('没有 webServer 服务，控制台页面不可用（其余功能正常）', 'warn')
    }
  } catch (e) {
    日志(`控制台挂不上：${e && e.message}`, 'warn')
  }

  // ── 每轮上下文 + weather 工具 ────────────────────────────────────────────
  function 挂(agent) {
    const offs = []
    const 收 = (fn) => { if (typeof fn === 'function') offs.push(fn) }

    // ① 每轮一行天气
    try {
      收(agent.ctx.systemPrompt.context({
        name: 'weather',
        order: 900, // 排在沙箱/审批/子代理（110/115/120）后面，别插进别人的段落中间
        required: false,
        text: () => 一行(),
      }))
    } catch (e) {
      日志(`天气上下文挂不上：${e && e.message}`, 'warn')
    }

    // ② weather 工具
    try {
      收(agent.ctx.tools.register({
        name: 'weather',
        description:
          '查天气：现在、未来几小时逐小时、未来几天。' +
          '每轮上下文里已经带了一行概要，需要更细的（几点下雨、明天穿什么、这周哪天下雨）再调这个。' +
          '返回中文文本，直接照着说就行。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 7, description: '未来几天，默认 3，最多 7。' },
            hours: { type: 'integer', minimum: 0, maximum: 24, description: '未来几小时逐小时，默认 12；传 0 不要逐小时。' },
            where: { type: 'string', description: '可选：查另一个城市（中文名），不填就是当前位置。' },
            status: { type: 'boolean', description: '可选：传 true 只做自检——看定位、早报/预警状态、QQ 发到哪、桥配置读没读到（不查天气）。' },
          },
          required: [],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          render(_args, value) {
            const t = value && typeof value.text === 'string' ? value.text : '（没有天气数据）'
            return [{ type: 'text', text: t }]
          },
        },
        isConcurrencySafe() { return true },
        async execute(args) {
          const a = args && typeof args === 'object' ? args : {}
          try {
            if (a.status) return { text: 自检() }
            let 地 = S.地
            if (a.where) {
              const 找 = await 查地名(String(a.where))
              if (!找) return { text: `没找到「${a.where}」这个地方，换个说法试试。` }
              地 = 找
            } else {
              地 = await 要地点()
            }
            if (!地) return { text: '定位失败了（可能是网络或 IP 定位服务不通），暂时查不到天气。' }
            const 快 = await 取天气(地.纬, 地.经)
            const 文本 = 详细文本(地.名 + (地.国 ? `·${地.国}` : ''), 快, {
              days: a.days === undefined ? 3 : a.days,
              hours: a.hours === undefined ? 12 : a.hours,
            })
            return { text: 文本 }
          } catch (e) {
            return { text: `查天气失败：${e && e.message}` }
          }
        },
      }))
    } catch (e) {
      日志(`weather 工具挂不上：${e && e.message}`, 'warn')
    }

    return () => {
      for (const f of offs) { try { f() } catch (e) { /* 卸载失败无所谓 */ } }
    }
  }

  function 心跳挂载() {
    let 活着的
    try { 活着的 = ctx.agents.list() } catch (e) { return }
    const 见过的 = new Set()
    for (const agent of 活着的) {
      if (!agent || typeof agent !== 'object') continue
      const sid = String(agent.id)
      见过的.add(sid)
      const 旧 = S.挂载.get(sid)
      if (旧 && 旧.agent === agent) continue
      if (旧) { try { 旧.off() } catch (e) {} S.挂载.delete(sid) }
      try {
        S.挂载.set(sid, { agent, off: 挂(agent) })
      } catch (e) {
        日志(`挂 ${sid} 失败：${e && e.message}`, 'warn')
      }
    }
    for (const [sid, v] of [...S.挂载]) {
      if (见过的.has(sid)) continue
      try { v.off() } catch (e) {}
      S.挂载.delete(sid)
    }
  }

  /** 新加的好友：自动把指令说明发一次（第一次拿到名单只记录，不群发，免得一装就骚扰一圈人） */
  async function 招呼新好友() {
    if (!配置.qqOn || 配置.greetNewFriends === false) return 0
    if (Date.now() - (S.招呼时 || 0) < 10 * 60 * 1000) return 0
    const { base, token } = 解析QQ目标s(配置)
    if (!base) return 0
    let 友 = []
    try {
      const j = await 取OneBotPost(base, token, 'get_friend_list', {})
      友 = (j && Array.isArray(j.data) ? j.data : []).map((f) => String(f && f.user_id)).filter(Boolean)
    } catch (e) { return 0 }
    if (!友.length) return 0
    S.招呼时 = Date.now()
    if (!S.好友初) { S.好友 = 友.slice(); S.好友初 = true; 存对端(); return 0 }
    // 被删掉又加回来的，允许再招呼一次
    S.好友 = S.好友.filter((x) => 友.includes(String(x)))
    let 动 = 0
    for (const 号 of 友) {
      if (S.好友.includes(号)) continue
      const 回 = await 发QQ({ base, token, 号 }, 指令说明)
      S.好友.push(号)
      if (回.ok) { 动++; 日志(`新好友 ${号}，已把指令说明发过去`) } else 日志(`新好友 ${号} 招呼失败：${回.说}`, 'warn')
      await new Promise((r) => setTimeout(r, 1500))
    }
    if (动) 存对端()
    return 动
  }

  async function 慢心跳() {
    S.心跳++
    S.心跳时 = Date.now()
    // 每一段都自己兜住：这里抛出去就会变成 unhandled rejection，宿主可能直接退出
    try { await 刷新() } catch (e) { S.错 = `刷新：${e && e.message}`; 日志(`刷新失败：${e && e.message}`, 'warn') }
    try { await 播早报() } catch (e) { S.错 = `早报：${e && e.message}`; 日志(`早报失败：${e && e.message}`, 'warn') }
    try { await 播晚间() } catch (e) { S.错 = `晚间：${e && e.message}`; 日志(`晚间预告失败：${e && e.message}`, 'warn') }
    try { await 查预警() } catch (e) { S.错 = `预警：${e && e.message}`; 日志(`预警失败：${e && e.message}`, 'warn') }
    // 读私聊里的指令：第一次接入发一次说明书，之后按 */xxx 改设置
    try { await 处理指令() } catch (e) { S.错 = `指令：${(e && e.message) || e}`; 日志(`读指令失败：${(e && e.message) || e}`, 'warn') }
    // 新加的好友：自动把指令说明发一次
    try { await 招呼新好友() } catch (e) { S.错 = `新好友：${(e && e.message) || e}`; 日志(`招呼新好友失败：${(e && e.message) || e}`, 'warn') }
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  // 先拉一次，能看见天气的那些回合就能用上
  void 刷新().catch(() => {})

  // 定时器：直接用原生 setInterval，只借 ctx.effect 管卸载。
  // （不套 ctx.interval：它内部用 this.ctx.effect 注册，套在我的 effect 里一旦 this 绑不对
  //   就会静默变成「一次都不跳」——天气插件最不能出的就是这种错。）
  try {
    const 挂心跳 = setInterval(() => { try { 心跳挂载() } catch (e) { /* 挂不上就等下一次 */ } }, MOUNT_MS)
    const 慢心跳定时器 = setInterval(() => { void 慢心跳().catch(() => {}) }, LOOP_MS)
    ctx.effect(() => () => { clearInterval(挂心跳); clearInterval(慢心跳定时器) })
  } catch (e) {
    日志(`定时器挂不上：${e && e.message}`, 'error')
  }

  // 卸载时把挂在 agent 上的东西都收干净
  ctx.effect(() => () => {
    for (const v of S.挂载.values()) { try { v.off() } catch (e) {} }
    S.挂载.clear()
  })

  心跳挂载()
  const 启 = 现刻()
  日志(`已启动（定位：${配置.place || '自动'}；早报 ${点钟(启.早报)}；晚间预告 ${配置.eveningOn ? 点钟(启.晚间) : '关'}；静默 ${点钟(启.静默起)}~${点钟(启.静默止)}）`)
}
