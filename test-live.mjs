const { __test: T } = await import('./lib/index.js')
const ok = (s) => console.log('✔', s)
const bad = (s) => { console.log('✘', s); process.exitCode = 1 }

let 地 = null
try {
  地 = await T.定位()
  if (地 && Number.isFinite(地.纬)) ok(`定位：${地.名} / ${地.国} (${地.纬}, ${地.经})`)
  else bad(`定位失败：${JSON.stringify(地)}`)
} catch (e) { bad(`定位抛错：${e.message}`) }

if (地) {
  let 快 = null
  try {
    快 = await T.取天气(地.纬, 地.经)
    if (!快 || !快.现) throw new Error('没有 现')
    ok(`取天气：现=${JSON.stringify(快.现)}`)
    ok(`小时数=${快.小时.length} 天数=${快.天.length} 时区=${快.时区}`)
    ok(`第一天=${JSON.stringify(快.天[0])}`)
    if (快.小时.length) ok(`第一个小时=${JSON.stringify(快.小时[0])}`)
  } catch (e) { bad(`取天气失败：${e.message}`) }

  if (快) {
    console.log('\n--- 上下文那一行（模拟）---')
    const 段 = [T.当前一句话(地.名, 快), T.今天一句话(快), T.未来几小时一句话(快, 6), T.建议(快)]
    console.log(段.filter(Boolean).join('；'))

    console.log('\n--- weather 工具详细输出 ---')
    console.log(T.详细文本(地.名 + (地.国 ? `·${地.国}` : ''), 快, { days: 3, hours: 8 }))

    console.log('\n--- 突变判定 ---')
    console.log(JSON.stringify(T.找突变(快)))
    console.log('\n--- 未来6小时 ---')
    console.log(JSON.stringify(T.未来小时(快, 6)))
  }
}

// 固定地名解析
try {
  const 京 = await T.查地名('上海')
  if (京) ok(`地名解析：上海 → ${京.名} (${京.纬}, ${京.经}, ${京.时区})`)
  else bad('地名解析失败')
} catch (e) { bad(`地名解析抛错：${e.message}`) }
