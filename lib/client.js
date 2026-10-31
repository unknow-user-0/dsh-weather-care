// 天气关怀：把控制台搬进 DSH 左栏（sidebar.panellist）和主面板（main）
// 纯 JS + React.createElement（浏览器模块表里的 React），不需要构建。
window.__ModuleLoader__.load({
  id: 'dsh-weather-care',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ── 文案：中文为准；以后要英文就往 词典.en 里补同名键，结构不用动 ──────
    const 词典 = {
      zh: {
        台: '天气关怀',
        台述: '改完立刻生效，不用重启插件。',
        刷新: '刷新',
        定位: '重新定位',
        定位中: '定位中…',
        概览: '现在',
        城市: '播报城市',
        城市述: '留空 = 自动定位；填城市名 = 固定这个城市（如 北京、杭州）',
        城市占位: '留空则自动定位',
        定位来源: '定位来源',
        定位说明: '定位说明',
        补发设置: '补发设置',
        数据: '天气数据',
        令牌: '彩云令牌',
        令牌有: '已填 · 当前走彩云天气',
        令牌无: '没填 · 当前走 Open-Meteo（免费、不用令牌）',
        令牌占位: '粘贴彩云 token，留空就不改',
        清空: '清空',
        全局默认: '全局默认 · 每个人可在推送对象里单独设',
        早报: '早间播报',
        早报述: '每天这个点说一句今天的天气',
        补发: '补发窗口',
        补发述: '因为某些原因错过发送后，多少时间内自动补发',
        晚开机: '晚开机补发',
        晚开机述: '开机时已经过了点，最多往后补多久还能收到一条',
        晚间: '前一天晚上预告明天',
        晚间述: '晚上提前说一说明天要不要带伞',
        内容: '播报内容',
        日出: '带日出日落',
        日出述: '早报和晚间预告里加上日出日落时刻',
        提醒: '突变提醒',
        提醒述: '天气要变的时候主动说一声',
        任意间隔: '任意两次间隔',
        任意间隔述: '至少隔多少分钟才再说（防刷屏）',
        同类间隔: '同类天气间隔',
        同类间隔述: '同一种提醒（比如下雨）至少隔多少分钟',
        每天上限: '每天最多',
        每天上限述: '一天最多主动说几次',
        静默: '静默时段',
        静默述: '这段时间不主动说话（跨午夜也行）',
        推送: 'QQ 推送',
        推送述: '播报和提醒直接发到 QQ，手机上就能看到',
        通道: '发送通道',
        通道述: '走本机 dsh-qq-bridge 接的 OneBot（SnowLuma / NapCat），不需要另配账号',
        推给QQ: '推送对象',
        推给QQ述: '只发私聊（群聊已去掉）；点开从已接通、没归档的好友里选，可以多选',
        选择: '选择',
        全选: '全选',
        清空: '清空',
        确定: '确定',
        取消: '取消',
        收起: '收起',
        搜索: '搜名字或号码',
        名单空: '名单是空的',
        载入中: '读名单中…',
        只列已接通: '只列出已经接进 DSH 会话、且没被归档的 QQ 和群',
        未选: '还没选',
        重读名单: '重新读一遍已接通的 QQ 和群',
        令牌: '访问令牌',
        令牌述: 'SnowLuma 的 OneBot accessToken（qqbridge/config.json 里的 snowluma.accessToken），留空 = 不改',
        令牌占位: '不修改',
        测试: '发条测试',
        预览: '播报长相',
        预览空: '还没有天气数据，等一下心跳（每 60 秒一次）',
        看预览: '看预览',
        状态: '运行状态',
        心跳: '心跳',
        快照: '天气数据',
        今日已发: '今天已发',
        计划: '计划',
        报错: '最近报错',
        保存中: '保存中…',
        已保存: '已保存',
        失败: '失败：',
        对端: '每个人的设置',
        对端述: '位置、早报、晚报、突变都能让对方在 QQ 私聊里用指令自己改，这里也能直接改',
        收播报: '收播报',
        只设不收: '只设不收',
        对端空: '还没有人接入：先在下面选推送对象，或者等对方私聊一句',
        指令述: '对方私聊发 */帮助 就能看到全部指令；第一次接入会自动发一份说明书',
        未设置: '未设置',
        设: '设',
        改: '改',
        关: '关',
        早报时: '早报',
        晚报时: '晚报',
        突变: '突变',
      },
      en: {},
    }

    function 应用(ctx) {
      const 取服务 = (名) => { try { return ctx.get(名) } catch (e) { return null } }
      const 语种 = () => {
        try {
          const l = 取服务('locale')
          const s = l && l.getSnapshot ? l.getSnapshot() : null
          const a = String((s && s.active) || '').toLowerCase()
          return a.startsWith('en') ? 'en' : 'zh'
        } catch (e) { return 'zh' }
      }
      const t = (k) => { const d = 词典[语种()] || {}; return d[k] || 词典.zh[k] || k }

      // ── 跟宿主说话的三个口子（都走 query string，宿主会先把 body 读空）──
      const 请求 = async (路径, 方法) => {
        const r = await fetch('/dsh-weather/api/' + 路径, {
          method: 方法 || 'GET', cache: 'no-store',
          headers: { 'x-requested-with': 'dsh-weather' },
        })
        const 文 = await r.text()
        try { return JSON.parse(文) } catch (e) { return { ok: false, 说: `返回不是 JSON（HTTP ${r.status}）：${文.slice(0, 120)}` } }
      }
      const 存 = (改) => {
        const q = new URLSearchParams()
        for (const k of Object.keys(改)) q.set(k, 改[k] === true ? 'true' : 改[k] === false ? 'false' : String(改[k]))
        return 请求('save?' + q.toString())
      }

      // ── 小组件 ──────────────────────────────────────────────────────────
      const 开关 = ({ 值, 切, 停 }) => h('button', {
        type: 'button', className: 'dsw-pill', 'data-on': 值 ? '1' : '0',
        'aria-pressed': !!值, disabled: !!停, onClick: () => 切(!值),
        title: 值 ? '开' : '关',
      })

      const 行 = ({ 题, 述, 子 }) => h('div', { className: 'dsw-row' },
        h('div', { className: 'dsw-lab' }, h('span', null, 题), 述 ? h('span', null, 述) : null),
        h('div', { className: 'dsw-ctl' }, 子),
      )

      const 卡 = ({ 题, 子 }) => h('section', { className: 'dsw-card' },
        h('h3', null, 题), ...(Array.isArray(子) ? 子 : [子]))

      const 天气图标 = ({ size, active }) => {
        const c = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
        const s = Number(size) || 20
        return h('svg', {
          width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 8.6, cy: 8.6, r: 3.2, stroke: c, strokeWidth: 1.7 }),
        h('path', {
          d: 'M8.6 1.7v1.9M8.6 13.6v1.9M1.7 8.6h1.9M13.6 8.6h1.9M3.8 3.8l1.3 1.3M12.1 12.1l1.3 1.3M13.4 3.8l-1.3 1.3',
          stroke: c, strokeWidth: 1.7, strokeLinecap: 'round', fill: 'none',
        }),
        h('path', {
          d: 'M9.4 19.2a3.05 3.05 0 0 1 .15-6.05 4.25 4.25 0 0 1 8.1 1.15 2.85 2.85 0 0 1 .4 4.9z',
          fill: 'var(--dsw-alias-bg-base)', stroke: c, strokeWidth: 1.7, strokeLinejoin: 'round',
        }))
      }

      // ── 主面板 ──────────────────────────────────────────────────────────
      function 天气台() {
        const [st, setSt] = useState(null)
        const [忙, set忙] = useState('')
        const [提, set提] = useState(null)
        const [预, set预] = useState(null)
        const [名单, set名单] = useState(null)   // { 好友: [{号,名}], 群: [...] }，抽屉用，拿一次就缓存
        const [抽, set抽] = useState(null)       // 抽屉打开状态：{ 种类, 载入, 名单, 选, 错, 搜 }
        const [改城, set改城] = useState(null)   // 正在改城市的对象键（private:xxx / group:xxx）
        const [, 语变] = useState(0)
        const 定时 = useRef(0)

        const 刷 = useCallback(async () => {
          const s = await 请求('state')
          if (s && s.配置) setSt(s)
          return s
        }, [])

        useEffect(() => { void 刷() }, [刷])

        useEffect(() => {
          const id = setInterval(() => { void 刷() }, 60000)
          return () => clearInterval(id)
        }, [刷])

        useEffect(() => {
          // 控制台代码一改，宿主那边 mtime 就变 → 自己 reload 一次（这个桌面端没绑 Ctrl+R）
          const 版本 = { v: '' }
          let 停 = false
          const 查 = async () => {
            if (停) return
            let r = null
            try { r = await 请求('version') } catch (e) { return }
            if (停 || !r || !r.v) return
            if (!版本.v) { 版本.v = r.v; return }
            if (版本.v !== r.v) { 版本.v = r.v; try { window.location.reload() } catch (e) { /* 只读环境就算了 */ } }
          }
          void 查()
          const id = setInterval(() => void 查(), 15000)
          return () => { 停 = true; clearInterval(id) }
        }, [])

        useEffect(() => {
          const l = 取服务('locale')
          if (!l || !l.subscribe) return undefined
          return l.subscribe(() => 语变((n) => n + 1))
        }, [])

        useEffect(() => {
          if (!提) return undefined
          const id = setTimeout(() => set提(null), 4000)
          return () => clearTimeout(id)
        }, [提])

        const 改 = async (k, v) => {
          setSt((s) => (s ? { ...s, 配置: { ...s.配置, [k]: v } } : s))
          set忙(t('保存中'))
          const r = await 存({ [k]: v })
          set忙('')
          if (r && r.配置) { setSt(r); set提({ ok: true, 文: t('已保存') + ' · ' + k }) }
          else set提({ ok: false, 文: t('失败') + ((r && r.说) || '无回应') })
          set预(null)
        }

        const 定位 = async () => {
          set忙(t('定位中'))
          set提(null)
          const r = await 请求('locate', 'POST')
          set忙('')
          if (r && r.配置) setSt(r)
          set提(r && r.ok !== false ? { ok: true, 文: (r.状态 && r.状态.定位来源) || '' } : { ok: false, 文: (r && r.说) || '定位失败' })
        }

        const 测试 = async () => {
          set忙('QQ…')
          set提(null)
          const r = await 请求('test-qq', 'POST')
          set忙('')
          if (r && r.配置) setSt(r)
          set提({ ok: !!(r && r.ok), 文: (r && (r.说 || r.回执 && r.回执.message)) || '没有回执' })
        }

        const 看预 = async () => {
          set忙('…')
          const r = await 请求('preview')
          set忙('')
          set预(r && r.ok ? r : { 错: (r && r.说) || '拿不到预览' })
        }

        if (!st) {
          return h('div', { className: 'dsw-wrap' }, h('style', null, CSS),
            h('div', { className: 'dsw-in' }, h('div', { className: 'dsw-sub' }, '天气关怀加载中…')))
        }

        const c = st.配置 || {}
        const z = st.状态 || {}
        const 勾 = (k) => c[k] === true
        const 数 = (k, 最, 最2, 步) => h('input', {
          type: 'number', className: 'dsw-inp dsw-num', defaultValue: String(c[k] ?? ''),
          min: 最, max: 最2, step: 步 || 1,
          onBlur: (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== Number(c[k])) void 改(k, v) },
        })
        const 时 = (k) => h('input', {
          type: 'time', className: 'dsw-inp', defaultValue: c[k] || '',
          onChange: (e) => { const v = e.target.value; if (v && v !== c[k]) void 改(k, v) },
        })
        const 文 = (k, 占位, 宽) => h('input', {
          type: 'text', className: 'dsw-inp', defaultValue: c[k] || '',
          placeholder: 占位, style: 宽 ? { width: 宽 } : undefined,
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
          onBlur: (e) => { const v = e.target.value.trim(); if (v !== (c[k] || '')) void 改(k, v) },
        })

        const 概 = h('div', null,
          h('div', { className: 'dsw-h' },
            h(天气图标, { size: 22, active: true }),
            h('span', null, t('台')),
            h('span', { className: 'dsw-tag' }, z.城市 || '—')),
          h('div', { className: 'dsw-sub', style: { marginTop: 6 } }, z.概览 || t('预览空')),
          h('div', { className: 'dsw-ctl', style: { marginTop: 10 } },
            h('button', { className: 'dsw-btn', disabled: !!忙, onClick: () => void 刷() }, t('刷新')),
            h('button', { className: 'dsw-btn', disabled: !!忙, onClick: () => void 定位() }, 忙 === t('定位中') ? t('定位中') : t('定位')),
            提 ? h('span', { className: 'dsw-msg' + (提.ok ? '' : ' 坏') }, 提.文) : null,
            忙 ? h('span', { className: 'dsw-msg' }, 忙) : null))

        const 播报卡 = 卡({ 题: t('补发设置'), 子: [
          行({ 题: t('补发'), 述: t('补发述'), 子: [数('catchUpMin', 15, 720), h('span', { className: 'dsw-tag' }, '分钟')] }),
        ] })

        const 数据卡 = 卡({ 题: t('数据'), 子: [
          行({
            题: t('令牌'),
            述: c.caiyunToken已配 ? t('令牌有') : t('令牌无'),
            子: [
              h('input', {
                type: 'password', className: 'dsw-inp', placeholder: t('令牌占位'), defaultValue: '',
                style: { width: 220 },
                onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
                onBlur: (e) => { const v = e.target.value.trim(); if (v) { void 改('caiyunToken', v); e.target.value = '' } },
              }),
              c.caiyunToken已配
                ? h('button', { className: 'dsw-btn', type: 'button', onClick: () => void 改('caiyunToken', '') }, t('清空'))
                : null,
            ],
          }),
        ] })

        const 提醒卡 = 卡({ 题: [t('提醒'), h('span', { className: 'dsw-tip' }, t('全局默认'))], 子: [
          行({ 题: t('提醒'), 述: t('提醒述'), 子: 开关({ 值: 勾('alertsEnabled'), 切: (v) => void 改('alertsEnabled', v) }) }),
          行({ 题: t('任意间隔'), 述: t('任意间隔述'), 子: [数('minAlertGapMin', 5, 1440)] }),
          行({ 题: t('同类间隔'), 述: t('同类间隔述'), 子: [数('sameKindGapMin', 10, 1440)] }),
          行({ 题: t('每天上限'), 述: t('每天上限述'), 子: [数('maxAlertsPerDay', 1, 24)] }),
          行({ 题: t('静默'), 述: t('静默述'), 子: [时('quietFrom'), '→', 时('quietTo')] }),
        ] })

        const 内容卡 = 卡({ 题: t('内容'), 子: [
          行({ 题: t('日出'), 述: t('日出述'), 子: 开关({ 值: 勾('sunOn'), 切: (v) => void 改('sunOn', v) }) }),
        ] })

        // ── 抽屉：从「已接通」的好友/群里多选推送对象 ──────────────────────
        const 开抽屉 = async (种类) => {
          const 当前 = (c.qqUsers || []).slice()
          const 已知 = 名单 ? 名单.好友 : null
          set抽({ 种类, 载入: true, 名单: 已知 || [], 选: 当前, 错: '', 搜: '' })
          if (已知 && 已知.length) { set抽((s) => (s ? { ...s, 载入: false } : s)); return }
          await 刷名单(种类, true, false)
        }

        const 存抽屉 = async () => {
          if (!抽) return
          const 选 = 抽.选.slice()
          set抽(null)
          await 改(抽.种类 === 'user' ? 'qqUsers' : 'qqGroups', 选)
        }

        // 重新问一遍宿主：现在接通了哪些好友/群（强刷 = 绕过宿主 60 秒缓存）
        const 刷名单 = async (种类, 静默, 强刷 = true) => {
          if (!静默) set忙(t('载入中'))
          const r = await 请求('targets' + (强刷 ? '?force=1' : ''))
          const 好友 = (r && r.好友) || []
          const 群 = (r && r.群) || []
          if (r && (r.好友 || r.群 || r.错 || r.说 === undefined)) set名单({ 好友, 群 })
          set抽((s) => (s ? { ...s, 载入: false, 名单: s.种类 === 'user' ? 好友 : 群, 错: (r && r.说) || '' } : s))
          if (!静默) {
            set忙('')
            const 坏 = !(r && r.ok)
            const 计 = (r && r.计数) || null
            const 好文 = 计
              ? `已接通：好友 ${计.好友}/${计.好友共} · 群 ${计.群}/${计.群共}（已归档的 ${计.归档} 个会话不算）`
              : `好友 ${好友.length} 个 · 群 ${群.length} 个`
            set提({ ok: !坏, 文: 坏 ? ((r && r.说) || '名单拉不到') : 好文 })
          }
          return { 好友, 群, 说: (r && r.说) || '' }
        }

        const 名表 = (种类) => {
          const 源 = 名单 && 名单.好友
          const m = new Map()
          for (const x of 源 || []) m.set(x.号, x.名)
          return m
        }
        const 已选 = (种类) => {
          const 号们 = c.qqUsers || []
          const m = 名表(种类)
          if (!号们.length) return h('span', { className: 'dsw-sub' }, t('未选'))
          return h('div', { className: 'dsw-chips' },
            ...号们.map((号) => h('span', { className: 'dsw-chip', key: 号 }, m.get(号) || 号)))
        }

        // ── 每个人的设置：位置 / 早报 / 晚报 / 突变（也能让对方在 QQ 里用指令改）──
        const 对端们 = st.对端 || []
        const 点钟 = (n) => `${String(Math.floor((n || 0) / 60)).padStart(2, '0')}:${String((n || 0) % 60).padStart(2, '0')}`
        const 改对端 = async (号, 键, 值) => {
          set忙(t('保存中'))
          set提(null)
          const r = await 请求(`peer?号=${encodeURIComponent(号)}&${encodeURIComponent(键)}=${encodeURIComponent(值)}`)
          set忙('')
          if (r && r.配置) setSt(r)
          set提({ ok: !!(r && r.ok), 文: r && r.ok ? t('已保存') : ((r && r.说) || t('失败')) })
        }
        const 对端行 = (x) => {
          const 名 = (名表('user').get(String(x.号)) || x.名 || ('QQ ' + x.号))
          const 编 = 改城 === x.号
          const 时 = (键, 值) => h('input', {
            type: 'time', className: 'dsw-inp', style: { width: 92 },
            defaultValue: 值 >= 0 ? 点钟(值) : '',
            disabled: !!忙,
            onBlur: (e) => {
              const v = e.target.value
              if (!v) return
              void 改对端(x.号, 键, v)
            },
          })
          return h('div', { className: 'dsw-cityrow dsw-peer', key: x.号 },
            h('div', { className: 'dsw-peer-head' },
              h('span', { className: 'dsw-cityname' }, 名),
              h('span', { className: 'dsw-sub' }, 'QQ ' + x.号),
              x.城 ? h('span', { className: 'dsw-tag' }, x.城) : h('span', { className: 'dsw-tag' }, t('未设置')),
              编
                ? h('input', {
                  className: 'dsw-inp', defaultValue: x.城 || '', autoFocus: true, style: { width: 110 },
                  placeholder: t('城市占位'),
                  onKeyDown: (e) => { if (e.key === 'Enter') { void 改对端(x.号, '城市', e.currentTarget.value); set改城(null) } },
                  onBlur: (e) => { const v = e.currentTarget.value.trim(); if (v) void 改对端(x.号, '城市', v); set改城(null) },
                })
                : h('button', { className: 'dsw-btn', disabled: !!忙, onClick: () => set改城(x.号) }, x.城 ? t('改') : t('设')),
              h('button', {
                className: 'dsw-btn', disabled: !!忙,
                onClick: () => void 改对端(x.号, '突变', x.突变 ? '0' : '1'),
              }, `${t('突变')} ${x.突变 ? '开' : t('关')}`),
            ),
            h('div', { className: 'dsw-peer-time' },
              h('span', { className: 'dsw-sub' }, t('早报时')),
              开关({ 值: x.早 >= 0, 停: !!忙, 切: () => void 改对端(x.号, '早报开', x.早 >= 0 ? '0' : '1') }),
              时('早报', x.早),
              h('span', { className: 'dsw-sub' }, t('晚报时')),
              开关({ 值: x.晚 >= 0, 停: !!忙, 切: () => void 改对端(x.号, '晚报开', x.晚 >= 0 ? '0' : '1') }),
              时('晚报', x.晚)),
          )
        }
        const 对端块 = h('div', { className: 'dsw-citybox' },
          h('div', { className: 'dsw-sub' }, t('对端述')),
          ...(对端们.length ? 对端们.map(对端行) : [h('div', { className: 'dsw-sub' }, t('对端空'))]),
          h('div', { className: 'dsw-msg' }, t('指令述')))

        // 选人面板：跟着「推送对象」那一行原地展开，不浮层、不跑到页面底下
        const 抽屉UI = (() => {
          if (!抽) return null
          const q = (抽.搜 || '').trim().toLowerCase()
          const 列表 = (抽.名单 || []).filter((x) => !q || String(x.名 || '').toLowerCase().includes(q) || String(x.号).includes(q))
          const 勾一 = (号) => set抽((s) => (s ? { ...s, 选: s.选.includes(号) ? s.选.filter((x) => x !== 号) : [...s.选, 号] } : s))
          return h('div', { className: 'dsw-pickbox' },
            h('div', { className: 'dsw-pickbox-head' },
              h('span', { className: 'dsw-sub' }, t('只列已接通')),
              h('span', { className: 'dsw-sub', style: { marginLeft: 'auto' } }, `已选 ${抽.选.length}`)),
            h('div', { className: 'dsw-pickbar' },
              h('input', {
                className: 'dsw-inp', placeholder: t('搜索'), defaultValue: 抽.搜,
                onChange: (e) => set抽((s) => (s ? { ...s, 搜: e.target.value } : s)),
              }),
              h('button', { className: 'dsw-btn', title: t('重读名单'), disabled: !!忙, onClick: () => void 刷名单(抽.种类) }, t('刷新')),
              h('button', { className: 'dsw-btn', onClick: () => set抽(null) }, t('收起'))),
            h('div', { className: 'dsw-list' },
              ...(抽.载入
                ? [h('div', { className: 'dsw-sub' }, t('载入中'))]
                : 列表.length
                  ? 列表.map((x) => h('label', { className: 'dsw-item', key: x.号 },
                    h('input', { type: 'checkbox', checked: 抽.选.includes(x.号), onChange: () => 勾一(x.号) }),
                    h('span', { className: 'dsw-name' }, x.名 || x.号),
                    h('span', { className: 'dsw-no' }, x.号)))
                  : [h('div', { className: 'dsw-sub' }, 抽.错 || t('名单空'))])),
            h('div', { className: 'dsw-df' },
              h('button', { className: 'dsw-btn', onClick: () => set抽((s) => (s ? { ...s, 选: 列表.map((x) => x.号) } : s)) }, t('全选')),
              h('button', { className: 'dsw-btn', onClick: () => set抽((s) => (s ? { ...s, 选: [] } : s)) }, t('清空')),
              h('button', { className: 'dsw-btn 主', onClick: () => void 存抽屉() }, t('确定'))),
          )
        })()

        const QQ卡 = 卡({ 题: t('推送'), 子: [
          行({ 题: t('推送'), 述: `${t('通道')}：dsh-qq-bridge → OneBot`, 子: 开关({ 值: 勾('qqOn'), 切: (v) => void 改('qqOn', v) }) }),
          行({ 题: t('推给QQ'), 述: t('推给QQ述'), 子: [
            h('button', { className: 'dsw-btn', onClick: () => void 开抽屉('user') }, t('选择')),
            h('button', { className: 'dsw-btn', title: t('重读名单'), disabled: !!忙, onClick: () => void 刷名单('user') }, t('刷新')),
            已选('user'),
          ] }),
          抽屉UI,
          对端块,
          行({ 题: t('令牌'), 述: t('令牌述'), 子: [
            h('input', {
              type: 'password', className: 'dsw-inp', defaultValue: '', placeholder: t('令牌占位'), style: { width: 160 },
              onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
              onBlur: (e) => { const v = e.target.value.trim(); if (v) { void 改('qqToken', v); e.target.value = '' } },
            }),
            h('span', { className: 'dsw-tag' }, (st.QQ && st.QQ.有令牌) ? '已配置' : '未配置'),
          ] }),
          行({ 题: t('测试'), 述: st.QQ ? `${st.QQ.地址 || '—'} · ${对端们.length} 个对象` : '', 子: h('button', {
            className: 'dsw-btn 主', disabled: !!忙, onClick: () => void 测试(),
          }, t('测试')) }),
        ] })

        const 预览卡 = 卡({ 题: t('预览'), 子: [
          h('div', { className: 'dsw-ctl' }, h('button', { className: 'dsw-btn', disabled: !!忙, onClick: () => void 看预() }, t('看预览'))),
          预 ? (预.错 ? h('div', { className: 'dsw-msg 坏' }, 预.错) : h('div', null,
            h('div', { className: 'dsw-pre' }, 预.早报 || ''),
            h('div', { className: 'dsw-pre' }, 预.晚间预告 || ''))) : null,
        ] })

        const 计划 = z.计划 || {}
        const 状态卡 = 卡({ 题: t('状态'), 子: h('div', { className: 'dsw-kv' },
          h('b', null, t('心跳')), h('span', null, `${z.心跳 || 0} 次${z.心跳时 ? ` · ${z.心跳时}` : ''}`),
          h('b', null, t('快照')), h('span', null, z.快照时间 || '—'),
          h('b', null, t('今日已发')), h('span', null, String(z.今日预警 || 0)),
          h('b', null, t('计划')), h('span', null, `早报 ${点钟(计划.早报)} · 晚间 ${点钟(计划.晚间)} · 静默 ${点钟(计划.静默起)}–${点钟(计划.静默止)}`),
           z.错 ? h('b', null, t('报错')) : null,
           z.错 ? h('span', { className: 'dsw-msg 坏' }, z.错) : null,
        ) })

        return h('div', { className: 'dsw-wrap' },
          h('style', null, CSS),
          h('div', { className: 'dsw-in' }, 概, QQ卡, 播报卡, 数据卡, 提醒卡, 内容卡, 预览卡, 状态卡))
      }

      // ── 左栏图标 ────────────────────────────────────────────────────────
      function 栏标(props) {
        const p = props || {}
        return h('span', { className: 'dsw-nav', title: t('台') },
          h(天气图标, { size: p.size || 20, active: !!p.active }))
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'weather', order: 20, label: () => t('台'),
      }, 栏标))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'weather',
      }, 天气台))
    }

    // ── 样式：全部走 --dsw-alias-* 主题令牌，跟着明暗主题走 ──────────────
    const CSS = `
.dsw-wrap{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:26px 24px 60px;font-size:14px;line-height:1.5}
.dsw-in{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.dsw-h{display:flex;align-items:center;gap:9px;font-size:19px;font-weight:600}
.dsw-sub{color:var(--dsw-alias-label-secondary);font-size:13px}
.dsw-tag{display:inline-block;padding:2px 9px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400}
.dsw-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:14px 18px;display:flex;flex-direction:column;gap:10px}
.dsw-card>h3{margin:0 0 2px;font-size:13px;font-weight:600;letter-spacing:.3px;color:var(--dsw-alias-label-primary)}
.dsw-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:3px 0}
.dsw-lab{display:flex;flex-direction:column;gap:3px;min-width:130px;max-width:52%}
.dsw-lab>span:first-child{font-size:13.5px}
.dsw-lab>span:last-child{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.dsw-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-inp{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:6px 10px;font:inherit;font-size:13px;min-width:96px;outline:none;color-scheme:light dark}
.dsw-inp:focus{border-color:var(--dsw-alias-brand-primary)}
.dsw-inp::placeholder{color:var(--dsw-alias-state-idle-primary)}
.dsw-num{width:82px;min-width:82px}
.dsw-btn{display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:9px;padding:6px 13px;font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.dsw-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dsw-btn:disabled{opacity:.5;cursor:default}
.dsw-btn.主{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsw-pill{position:relative;width:42px;height:23px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;flex:none;padding:0;transition:background .15s,border-color .15s}
.dsw-pill::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:99px;background:var(--dsw-alias-state-idle-primary);transition:transform .15s,background .15s}
.dsw-pill[data-on="1"]{background:var(--dsw-alias-bg-overlay);border-color:var(--dsw-alias-brand-primary)}
.dsw-pill[data-on="1"]::after{transform:translateX(19px);background:var(--dsw-alias-brand-primary)}
.dsw-pill:disabled{opacity:.5;cursor:default}
.dsw-pre{white-space:pre-wrap;line-height:1.65;font-size:13px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;margin-top:8px}
.dsw-msg{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dsw-msg.坏{color:var(--dsw-alias-state-error-primary)}
.dsw-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 16px;font-size:12.5px;align-items:baseline}
.dsw-kv b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsw-nav{display:inline-flex;align-items:center;justify-content:center}
.dsw-chips{display:flex;gap:6px;flex-wrap:wrap;max-width:380px}
.dsw-chip{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:99px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dsw-citybox{display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:2px 0 4px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}
.dsw-cityrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-peer{flex-direction:column;align-items:stretch;gap:6px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsw-peer:first-of-type{border-top:none}
.dsw-peer-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-peer-time{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-tip{margin-left:8px;font-weight:400;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsw-cityname{font-size:13px;color:var(--dsw-alias-label-primary);min-width:70px}
.dsw-pickbox{display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 12px;margin:2px 0 4px}
.dsw-pickbox-head{display:flex;align-items:center;gap:8px}
.dsw-pickbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsw-pickbar>.dsw-inp{flex:1;min-width:120px}
.dsw-list{overflow:auto;max-height:min(38vh,300px);display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px 0}
.dsw-item{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:9px;cursor:pointer;font-size:13px}
.dsw-item:hover{background:var(--dsw-alias-bg-layer-2)}
.dsw-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-no{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.dsw-df{display:flex;align-items:center;gap:8px}
.dsw-df>.dsw-sub{margin-left:auto;margin-right:4px}
`

    return {
      inject: ['slots'],
      apply: 应用,
    }
  },
})
