# dsh-douyin（v0.2，浏览 + 视频理解 + 写操作）

汐的抖音插件：推荐流/搜索/视频页/评论/截图/下载/观看记忆/通知（互动消息）/私信读+回；配套 dsh-media 做转写、抽帧、OCR。
写操作：点赞/收藏/评论（含 @提及）/评论删除/评论回复/私信读+回；必须 owner/home + `confirm:true`，能 dryRun/draft 的先检查。
通知面板只读：只读已加载的通知（@提及/回复/赞/关注），每条带稳定 id/index/isOwner；不点条目、不标记已读、不回复；面板里没有回复入口。**2026-11-15 起 notifyList/notifyReply 固定走独立 notify tab，不占/不导航 main。**
通知实时事件源（默认关）：`notifyWatchEnabled=true` 时每 3s（可配 2–30s）用 badge/角标 DOM + 远端 jsWatch（MutationObserver/fetch）等新通知；**不每轮强开面板**，只在角标/网络真变化时开一次面板读完即关（Escape/入口切换，绝不点搜索框）；事件带 id/actor/type/text/time/ageMs/isOwner/replyable，主人→home，其他人→统一「抖音」会话。
私信策略：不设白名单，只回对方消息 ≤1 小时的会话；主人（`dm-owner.txt`=饲养员，别名草荧）可主动发；每日 3 条。
私信 watcher（默认关）：`dmWatchEnabled=true` 时每 2–5s（默认 3s）只读 `/chat` 会话列表，新消息事件带 `owner=true/false`；供 autonomy 取用，不打开会话、不发送、不路由。
**多页面（2026-11-14）**：桥固定 `main`/`notify`/`dm` 三个 tab；feed/search/open/评论走 main，通知 watcher 走 notify，私信 watcher 走 dm，互不导航。
精确选择：`dm_list`/`dm_read` 返回稳定 `conversationId`/`messageId`，`dm_send` 可按 id/index 定向发送；`notify_list` 返回稳定 `id`，`notify_reply` 可按 id 定向回复。
评论回复受“评论列表热门排序”限制，找不到新评论时返回 `E_NOT_FOUND`；发布未做。
不写记忆（watch 除外）、不调 `dy_say`、不自动发消息；只有通知事件源会通过 `dyHome.deliver` 投递事件（可 `notifyWatchDeliver:false` 关闭）。
**交接/现状/已知坑/A+C 计划见 `/sdcard/DSHA/工作区/统筹/16-抖音交接文档.md` §19。**

> 当前任务只交付代码与测试：**不注册 profile、不改 profile、不重启、未改远程**。
> `cordis.patch.yml` 只是示例 insert；远程服务端由另一个任务部署。

## 工具（19 个，owner/home 专用）

| 工具 | 说明 | 返回 |
|---|---|---|
| `dy_douyin_status()` | ping + 当前页 title/url + 当前 watch 状态 | `{ok,proto,browser,pages,url,title,latencyMs,blockAssets,activeWatch,minWatchMs,watchedCount}` |
| `dy_douyin_feed({limit=8,scroll=false})` | 必要时打开首页，`list div.waterfall-videoCardContainer`；`scroll=true` 时最多再下滚 3 次（700px/次，等 0.8s），按 videoId 去重到 limit | `{ok,items:[{videoId,url,text}],count}` |
| `dy_douyin_search({query,limit=8,type})` | type=general/video 走卡片 click→modal_id；type=user 读 `/user/` 链接去重；type=live 读 `/live/` 或 `live.douyin.com` 链接；user/live 空结果 `ok:true,count:0` 带 note | 视频同上；user `{userId,url,text,type}`；live `{roomId,url,text,type}` |
| `dy_douyin_open({videoId\|url})` | 只允许 `douyin.com/video/<数字>` | `{ok,videoId,url,status,title}` |
| `dy_douyin_comments({videoId,limit=20})` | 打开视频页读评论；最多点 20 个 `button.comment-reply-expand-btn` 展开回复后重新 list 合并（点失败跳过）；每条带 `time`（刚刚/N分钟前/N小时前/日期） | `{ok,videoId,items:[{author,text,likes,time,replyCount,replies[]}],count}` |
| `dy_douyin_notify_list({limit=20,loadMore=true})` | **只读**读「通知/互动消息」（固定 notify tab，不碰 main）：点「通知」开面板，解析 @提及/回复评论/赞/弹幕/关注；每条带稳定 `id`/`index`/`isOwner`/`replyable`，另有 `rawCount`（面板 DOM 行数，含系统提示/加载更多）；`loadMore` 会自动点「点击加载更多」最多 3 次。不点条目（不标已读、不跳视频）、不回复；关闭面板：Escape → 页面空白处真实点击（真机实测 Escape 不关浮层）→ 入口兜底，**不点搜索框/条目** | `{ok,panel,filter,items:[{id,index,actor,relation,type,text,time,ageMs,likeCount,isOwner,replyable,...}],count,loaded,reply}` |
| `dy_douyin_notify_reply({id?,target?,text,confirm,index?,commentTarget?})` | **写操作**回复一条通知：只支持 mention/comment_reply；按 `id`/`index`/`target` 精确定位（id 与 target/index 不一致 `E_BAD_ARG`；只给 target 且多条 `E_AMBIGUOUS`）→ 在 notify tab 点开条目（**标记已读**）→ URL 取 videoId → 同一个 notify tab 评论区回复（owner 默认显示名草荧，失败回退备注名）→ 评论列表回读判 verified；回复完 notify tab 回首页，main 不动。`confirm:true` 必须；like/follow `E_NOT_REPLYABLE`（不点）；时间只有日期/星期或超 1h `E_STALE`（不点）；找不到 `E_NOT_FOUND`；不自动/不批量 | `{ok,action:'notify_reply',videoId,notification,replyTarget,usedAltTarget,verified,markedRead:true,note}` |
| `dy_douyin_download({videoId?,url?,quality?})` | **只有她明确要求才调用，绝不自动下载 feed**；打开视频页→`html video` 取 `<source src>`→本地 fetch 存 `.../<videoId>.mp4`；≤300MB；**只保存文件和 sidecar，不写观看记忆** | `{ok,videoId,file,bytes,seconds,title?,author}` |
| `dy_douyin_watch({videoId?,path?,thought?,summary?,note?})` | 看完后从 sidecar 取 title/author/file，写一条 `dyMemory.addEpisode`（source=`douyin_watch`）；同 videoId 幂等；失败只 warn | `{ok,videoId,file,title,author,memoryWritten,memoryId?,duplicate?}` |
| `dy_douyin_like({videoId,undo?,confirm?,dryRun?,inputMode?})` | 点赞/取消，selector `[data-e2e="video-player-digg"]`；dryRun 只读；真实写 confirm:true；`inputMode=auto/click/key`（auto 点击失败回退键盘 Z）；回读 `data-e2e-state`（`is-digged`/`no-digged`） | `{ok,action,videoId,targetState,before,after,verified,via,code?}` |
| `dy_douyin_favorite({videoId,undo?,confirm?,dryRun?,inputMode?})` | 收藏/取消，selector `[data-e2e="video-player-collect"]`；`inputMode=auto/click/key`（auto 回退键盘 C）；回读 `data-e2e-state`（`is-collected`/`no-collect`），同上 | 同上 |
| `dy_douyin_comment({videoId,text,draftOnly?,confirm?})` | 评论草稿（默认不提交）：打开评论栏/输入框，**先清空已有草稿**再剪贴板粘贴；文本以 `@名字` 开头走键盘 `@`+名字+回车选中提及，再粘贴正文；draftOnly=false+confirm 才尝试提交 | `{ok,action,videoId,targetState,before,after,verified,draftFilled?,draftValue?,inputVia?,mention?,submitVia?}` |
| `dy_douyin_comment_reply({videoId,target,text,confirm})` | 回复一条 1 小时内的新评论：按 target（正文片段/作者）定位 → 点「回复」→ 主输入框进入 `.comment-input-container-focus` 回复态 → 粘贴 → 点发送 → 回读回复段；旧评论 `E_STALE`，找不到 `E_NOT_FOUND`，必须 confirm:true | `{ok,action:'comment_reply',target,verified,result,chars,textHash}` |
| `dy_douyin_comment_delete({videoId,text,confirm})` | 删除自己的一条评论：按文本在已加载评论里定位 → 该条「更多」→「删除评论」→ 回读确认；必须 confirm:true | `{ok,action:'comment_delete',deletedText,matchedIndex,loadedBefore,loadedAfter,verified}` |
| `dy_douyin_dm_list()` | 列出私信会话（只读）：打开 `/chat`，读会话名/预览/时间，不点开会话；每条带稳定 `id`/`index`/`isOwner`（饲养员/草荧/dm-owner.txt） | `{ok,items:[{id,index,name,preview,time,isOwner}],count}` |
| `dy_douyin_dm_read({conversationId?,index?,name?,limit?})` | 读一个已有私信会话（只读）：按 `conversationId`/`index`/`name` 精确定位并点开（重名 `E_AMBIGUOUS`，不猜），读最近最多 50 条；每条带稳定 `id`/`index`/`sender`/`fromMe`/`time`/`isOwner` | `{ok,name,conversation,items,count,loaded}` |
| `dy_douyin_dm_send({messageId?/conversationId?/index?/name?,text,confirm})` | 回一条已有私信：按 `messageId`（精确到某条）/`conversationId`/`index`/`name` 定位（重名 `E_AMBIGUOUS`；messageId 找不到 `E_NOT_FOUND`，指向自己 `E_BAD_ARG`）；只回对方消息 ≤1 小时的会话（主人会话例外）+ `confirm:true` + 每日限额；剪贴板粘贴输入，发送后回读验证 | `{ok,name,conversation,messageId,chars,textHash,verified}`（不含正文） |
| `dy_douyin_dm_watch({action?,limit?})` | **只读**私信实时 watcher：`poll`（默认，轮询一次并取队列）/`drain`/`start`/`stop`/`status`；第一次读取只建基线，之后只投“会话预览+时间”首次变化；事件带 `owner`/`sender`/`conversationId`/`conversationName`/`text`/`time`；不打开会话、不标已读、不发送、不路由 | `{ok,events:[{id,type,owner,isOwner,fromMe,sender,conversationId,conversationName,text,time,...}],count,tick,primed,...}` |
| `dy_douyin_screenshot()` | 远程 `screenshot` + SSH `cat` 取回 PNG，存 `/sdcard/DSHA/媒体/抖音/` | `{ok,file,bytes}` |

所有工具返回统一外层 `{ok, detail}`（`detail` 是 JSON 字符串）；失败在 `detail` 里带 `code/message`。

## 通知 → 实时事件源（默认关闭）

只读事件源（默认关闭）：不再每 10 分钟轮询面板。每 3s（`notifyWatchIntervalMs`，2–30s 可配）检查三件事：
1. **角标/入口 DOM**：只读 header 通知入口的 HTML/text/子元素，数字角标增加或红点出现才算触发；不点击、不开面板。
2. **jsWatch**：远端 MutationObserver（通知面板/私信面板 DOM）+ fetch/XHR 包装；DOM 里的新通知条目直接解析成事件（无需开面板），通知/互动 API 响应只当触发信号（绝不把响应正文带进事件；私信/聊天 URL 排除）。
3. **已打开面板**：面板本来就开着时只被动读当前 DOM（`allowOpen:false`），不点条目、不标已读。

只有 badge/net 真触发、且距离上次主动开面板 ≥ `notifyWatchPanelMinGapMs`（默认 15s）时，才点一次「通知」入口读快照，**读完立即 closeNotifyPanel（Escape + 页面空白处真实点击 + 入口兜底；真机实测 Escape 不关这个浮层，绝不点 `searchbar-input`/条目）**。间隔内的触发会记 `pendingTrigger`，过窗后即使没有新事件也会补读一次，避免漏掉。开/读面板本身会触发通知 API 响应，读取后 5s 内的 net 事件不再当第二次触发，防自激循环。watcher 固定跑在独立的 **notify tab**，不导航 main；只有 notify tab 自己处在视频/模态页、私信页或非抖音页时才返回 `E_PAGE_UNSAFE` 并等它恢复。`/chat` 页不启动 jsWatch（避免 clone 观察 DM fetch/XHR 流量）。

- 开启：`notifyWatchEnabled=true`（默认 `false`，需 profile 显式开）；`notifyWatchIntervalMs` 默认 `3000`（强制 2000–30000）；`notifyWatchStartupDelayMs` 默认 1000；`notifyWatchLimit` 默认 20；`notifyWatchMaxSeen` 默认 500；`notifyWatchMaxAgeMs` 默认 10 分钟。
- 源模式：`notifyWatchSource=auto`（默认，badge+js+panel）/`badge`/`js`/`panel`；`notifyWatchBadgeSelectors` 默认通知入口；`notifyWatchBadgeHtmlFallback=false`（无数值/红点时是否用入口 HTML 变化当触发，默认关防误报）；`notifyWatchJsTakeLimit=30`。
- 基线：第一次成功读取面板只建基线（历史不投）；`notifyWatchBaselineEnabled=true`，失败按 `notifyWatchBaselineRetryMs`（默认 15s）重试，不每轮强开。状态文件只存 id hash/primed，不存正文。
- 去重：稳定 id = `type+actor+text+归一化时间` 的 hash（刚刚/N分钟前 → recent），同快照重复项加 `-2/-3`；`ageMs=null`（星期/日期）视为旧通知，不投实时事件；超过 `notifyWatchMaxAgeMs` 也不投。
- 事件：`{id,type,actor,text,time,ageMs,isOwner,owner,replyable,route,source,at}`；`replyable` = mention/comment_reply 且（窗口=0 或 ≤commentReplyWindowMs）。
- 投递（`notifyWatchDeliver=true`）：主人 → `{channel:'douyin',contactId:actor,contactName:actor}`（home 房间）；其他人 → 统一 `{contactId:notifyWatchOtherContactId(默认 douyin),contactName:'抖音'}`；`dyHome` 不可用/拒收只记日志，不重试、不直连。
- 服务/订阅：`notifyWatch({action:poll|drain|start|stop|status})`、`notifyWatchStatus()`、`notifyWatchSubscribe(fn)`（返回取消订阅函数）；事件同时进内存队列，`poll/drain` 可取。
- 定时器 `.unref()`；`ctx.on('dispose')` 时 stop 并 `jsWatch stop`（只断 observer；远端 fetch 包装会留到页面刷新，属 bridge 既有行为）。watcher 不点条目、不标已读、不回复、不发消息。

## 私信 → autonomy watcher（默认关闭）

只读轮询 `/chat` 会话列表，把**新消息事件**放进内存队列/订阅回调；不打开会话、不标已读、不发送、不投 home、不路由。
供 autonomy 通过 `ctx.get('dyDouyin')?.dmWatch(...)` / `dmWatchStatus()` / `dmWatchSubscribe(fn)` 取用（subscribe 返回取消订阅函数）。

- 开启：`dmWatchEnabled=true`（默认 `false`，需 profile 显式开）；`dmWatchIntervalMs` 默认 `3000`（强制 2000–300000，要求 2–5s）；`dmWatchStartupDelayMs` 默认 3000；`dmWatchLimit` 默认 20；`dmWatchMaxSeen` 默认 1000；`dmWatchKeepOpen` 默认 `true`（调用结束保持 `/chat`，否则每轮恢复原页面）。
- 去重：会话名 + 最后一条预览 + **归一化时间**（刚刚/N分钟前 → `recent`）；第一次成功读取只建基线（历史会话不投），之后只投“会话指纹”首次出现的变化。
- **两轮确认**：新指纹要连续 `dmWatchConfirmTicks`（默认 2）次成功读取都出现才投，过滤页面切换/并发导航时名称/预览错位造成的假事件；代价是新消息事件晚一个间隔（默认约 3s）。真机 e2e 曾抓到并发导航时 4 条会话同时“变化”的假事件，所以默认 2。
- 事件：`{id,type:'dm_message',kind:'dm_message',seq,at,owner,isOwner,fromMe,sender,conversationId,conversationName,conversationIndex,text,preview,time,conversation,dedupeKey}`；`owner=true` = 主会话（饲养员/草荧/dm-owner.txt）。
- `dmWatch({action})`：`poll`（默认，轮询一次并取走队列）/`drain`/`start`/`stop`/`status`；`limit` 1–100（默认 20）。
- 读取失败只记日志、不重试、不 throw；并发 tick 第二次返回 `skipped:true, reason:'busy'`。
- 开启后 dm watcher 固定占用独立的 **dm tab**（停在 `/chat`），不占用/导航 main；feed/search/open 可以同时在 main 刷，三个 tab 互不抢页。
- 状态文件（可选）：只存指纹 hash 与 `primed`，不存消息正文；`dmWatchStateFile` 为空 = 只在内存去重（重启后重新建基线）。

## 依赖与启动行为

- **零 npm 依赖**：只用 Node 24 内置模块（`child_process`/`fs`/`path`/`url`），不 import Cordis 包、Playwright、ssh2。
- **import 阶段零副作用**：模块顶层只定义类和函数，不连 SSH、不起子进程、不读远程、不注册定时器、无顶层 await。
- **apply 阶段零 IO**：只做配置归一化、构造对象、注册 19 个工具；不读审计文件、不建截图目录、不 spawn ssh。
  唯一例外：`notifyWatchEnabled=true` / `dmWatchEnabled=true` 时在 apply 末尾各挂一个 unref 的只读 watcher（默认都关，见下节）。
- **首次工具调用才懒加载**：先检查本地 key/known_hosts（缺了直接 `E_SSH_AUTH`，不 spawn），再建立 SSH 会话。
- 远程不可用、SSH 不可用、key 不存在时插件照常加载；工具返回错误码，不把异常抛给宿主。
- `apply` 内部有 try/catch，任何装配异常都只记日志并返回 false；工具执行层再包一层 try/catch。
- 串行：所有工具共用一个 `SerialQueue`；队列满返回 `E_BUSY`，不无限堆积。
- **主页面推荐页**：默认 `https://www.douyin.com/?recommend=1&from_nav=1`（实测 3/3 停在推荐：feed-active-video=1、waterfall=0）；`/` 与 `/?recommend=1` 会在数秒后落到 `/jingxuan`（精选），不要用。
- **浏览器复用**：远程 bridge 活着时 `open` 只导航对应 role 的 page，不 restart/stop；`start.sh` 只在 bridge 真不在时启动，不再按 profile 杀 Chrome。Playwright 走 `--remote-debugging-pipe`，bridge 死后无法 attach 还活着的 Chromium，这种情况只报告、不自动 kill（见 `start.sh` 提示）。

## 传输（v1：ssh-exec）

```
ssh -i /root/.dsh/douyin/ssh/id_ed25519 -p 2222 \
    -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/root/.dsh/douyin/known_hosts \
    root@127.0.0.1 \
    "PATH=/manager/extensions/harness/program/node/bin:$PATH node /persistent/cdp/client-stdin.js"
```

- 请求 JSON 只走 stdin 一行，不拼 shell；读 stdout 一行 JSON；超时 kill 子进程；失败不自动重放。
- `open` 超时 120s，其余 30s；超时错误码分别为 `E_OPEN_TIMEOUT` / `E_TIMEOUT`。
- `transport: 'ssh-exec' | 'streamlocal'`；**v1 只实现 ssh-exec**，streamlocal 是占位（明确 `E_BRIDGE_DOWN`，不偷偷回退）。
- 截图用 `cat -- '<远程路径>'` 取回；远程路径必须匹配 `/persistent/cdp/shots/[A-Za-z0-9._-]+\.png`，上限 2MB。
- 可选资源拦截：`blockAssets=true` 时 `feed`/`search` 开始会调一次 `assets {block:true}`（只拦 image/font/media），
  失败只 warn 不阻断；结束后不强制恢复，所以后续截图里的封面/图片会是空的。
- 搜索稳定性：整体失败时只对 `E_SELECTOR_MISS/E_TIMEOUT/E_OPEN_TIMEOUT/E_REMOTE_IO` 重试一次
  （等 2s 后重新 open 搜索页）；`E_CHALLENGE/E_LOGIN_REQUIRED` 等不重试。卡片等待 `count>0` 后还要
  `list` 验证有文本行，空 list（spinner/骨架）继续等。

## 限流与时段（硬规则）

- 每天最多 **40 条**；单次浏览会话最多 **8 条**；两次活动间隔 ≥30 分钟算新会话；每次工具调用最小间隔 **5s**。
- “条数”= **真正看够 `minWatchMs`（默认 10s）的视频**：
  - `open` 成功只记 `activeWatch {videoId,startedAt}`，**open 本身不计数**；
  - 下一次 `feed`/`search`/`open`/`comments` 先结算上一条：`now-startedAt >= minWatchMs` 计 1，否则计 0；结算后清空；
  - `status`/`screenshot` **不结算**，只读展示当前 `activeWatch`；
  - `feed`/`search` 浏览列表免费，不按展示条数计；`open`/`comments` 自身也不计。
- 进程退出时未结算的 `activeWatch` 直接丢弃；重启不恢复（宁少不多）。
- 配额满时：`feed`/`search` 仍可浏览（guard `need=0`）；`open`/`comments` 会被拒（guard `need=1`，避免配额满了还能打开新视频）。
- 可用时段（Asia/Shanghai，固定 UTC+8）：
  - 工作日 08:00–09:00、12:00–14:00、18:00–次日 09:00（实现为 18:00–24:00 + 次日 08:00–09:00）；
  - 周末全天；
  - **00:00–08:00 静默最高优先**，对所有日期生效。
- 可用时段拦 `feed/search/open/comments`；配额只拦 `open/comments`（`feed/search` guard `need=0`）；`status`/`screenshot` 是排障能力，不受时段限制，但仍受最小间隔与串行约束。

## 配置（默认值）

| 字段 | 默认 |
|---|---|
| `enabled` | `true` |
| `transport` | `ssh-exec` |
| `sshHost` / `sshPort` / `sshUser` | `127.0.0.1` / `2222` / `root` |
| `sshKeyPath` / `knownHosts` | `/root/.dsh/douyin/ssh/id_ed25519` / `/root/.dsh/douyin/known_hosts` |
| `openTimeoutMs` / `callTimeoutMs` | `120000` / `30000` |
| `dailyQuota` / `perSession` | `40` / `8` |
| `minWatchMs` | `10000`（≥10s 才算看过；open 后下一次浏览类调用结算） |
| `sessionGapMs` / `minIntervalMs` | `1800000` / `5000` |
| `timeWindows` | 见上；可传对象或共享数组 |
| `feedSelector` / `searchSelector` | `div.waterfall-videoCardContainer` / `div.search-result-card` |
| `feedScrollDelta` / `feedScrollWaitMs` / `feedScrollMaxSteps` | `700` / `800` / `3` |
| `searchCardWaitMs` / `searchCardRetries` | `1500` / `12` |
| `searchRetries` | `1`（整体失败最多重试 1 次；仅选择器/超时/远程 IO 类） |
| `commentReplyExpandMax` / `commentReplyWaitMs` | `20` / `500` |
| `writeReadbackWaitMs` | `800`（点赞/收藏点击后回读等待） |
| `commentInputSelectors` / `commentInputOpenSelectors` | `['[contenteditable]']` / `['text=留下你的精彩评论吧']` |
| `commentSubmitSelectors` | `['#comment-input-container .commentInput-right-ct span:last-child']`（2026-11-08 真实页面抓取；**真实提交尚未验收**，点击后仍以评论列表回读判定 verified） |
| `remoteDisplay` / `remoteXAuthority` | `:20` / `/manager/extensions/desktop/Xauthority`（草稿输入用 xdotool） |
| `writeBlockedSelectors` | 短信验证/登录浮层选择器；命中即 `E_LOGIN_REQUIRED`，不点写 |
| `blockAssets` | `false`（true=feed/search 前屏蔽 image/font/media；截图封面会空） |
| `screenshotDir` | `/sdcard/DSHA/媒体/抖音` |
| `downloadDir` | `/sdcard/DSHA/媒体/抖音/下载`（工具不接受任意路径，文件名只由 videoId 生成） |
| `maxScreenshotBytes` | `2097152` |
| `auditFile` | `/root/.dsh/douyin/douyin_audit.jsonl` |
| `homeCwd` / `ownerPrivateDirs` | `/sdcard/DSHA/生活/数据/home` / `[]` |
| `exposeService` | `false`（true 时 `ctx.provide('dyDouyin', ...)`，供后续 autonomy 调用） |
| `notifyWatchEnabled` | `false`（通知实时事件源总开关） |
| `notifyWatchIntervalMs` / `notifyWatchStartupDelayMs` | `3000`（强制 2000–30000）/ `1000` |
| `notifyWatchSource` | `auto`（auto/badge/js/panel） |
| `notifyWatchBadgeSelectors` | `['header [data-e2e="something-button"]:has-text("通知")']` |
| `notifyWatchBadgeHtmlFallback` / `notifyWatchJsTakeLimit` | `false` / `30` |
| `notifyWatchBaselineEnabled` / `notifyWatchBaselineRetryMs` | `true` / `15000` |
| `notifyWatchPanelMinGapMs` | `15000`（两次主动开面板最小间隔） |
| `notifyWatchLimit` / `notifyWatchMaxSeen` / `notifyWatchMaxAgeMs` | `20` / `500` / `600000` |
| `notifyWatchDeliver` / `notifyWatchOtherContactId` / `notifyWatchOtherContactName` | `true` / `douyin` / `抖音` |
| `notifyWatchStateFile` | `''`（可选；只存 id hash/primed，不存正文） |
| `dmOwnerAliases` / `dmOwnerDisplayName` | `['饲养员', '草荧']` / `草荧`（主人识别；显式空数组=不用别名） |
| `dmWatchEnabled` | `false`（私信 watcher 总开关；profile 显式开） |
| `dmWatchIntervalMs` / `dmWatchStartupDelayMs` | `3000`（强制 2000–300000）/ `3000` |
| `dmWatchLimit` / `dmWatchMaxSeen` / `dmWatchConfirmTicks` | `20` / `1000` / `2`（1–5；新指纹连续出现 N 次才投） |
| `dmWatchKeepOpen` | `true`（保持在 `/chat`，否则每轮恢复原页面） |
| `dmWatchStateFile` | `''`（可选；只存指纹 hash/primed，不存正文） |

非法配置不会抛错：回落默认值并写入 `cfg.warnings`。

## 审计

本地 JSONL：`/root/.dsh/douyin/douyin_audit.jsonl`，一行一条：

```json
{"ts":1794047400000,"at":"2026-11-07T18:30:00+08:00","cmd":"feed","count":0,"ok":true,"error":null,"durationMs":1234}
{"ts":1794047412000,"at":"2026-11-07T18:30:12+08:00","cmd":"watch","count":1,"ok":true,"error":null,"videoId":"123456789","watchMs":12000,"charged":true}
```

普通命令只记 `时间/命令/条数(0)/ok/error`；只有 `cmd:'watch'` 带 `videoId/watchMs/charged`。
**不记页面正文、cookie、密钥**。
审计文件超过 5MB 滚动为 `.1`；写入失败静默忽略，不影响工具结果。
重启后从审计文件惰性重建“今日用量 / 当前会话 / 上次调用时间”。

## 错误码

约定码：`E_BRIDGE_DOWN`、`E_SSH_AUTH`、`E_TIMEOUT`、`E_OPEN_TIMEOUT`、`E_BAD_ARG`、`E_BAD_URL`、
`E_SELECTOR_MISS`、`E_LOGIN_REQUIRED`、`E_CHALLENGE`、`E_REMOTE_IO`、`E_BUSY`、`E_PARSE`。

下载码：`E_NO_MEDIA`（拿不到媒体流/链接过期/本地 fetch 被拦/内容不是 MP4）、`E_TOO_LARGE`（>300MB）、
`E_DISK_FULL`、`E_PERMISSION`、`E_DOWNLOAD_FAILED`、`E_NOT_FOUND`（watch 找不到 sidecar）；
失败不会留下 `.part` 文件。

闸门附加码：`E_DISABLED`、`E_TIME_WINDOW`、`E_MIN_INTERVAL`、`E_QUOTA`、`E_SESSION_QUOTA`、`E_PERMISSION`。

写操作码：`E_CONFIRM_REQUIRED`（真实写缺 confirm）、`E_UNVERIFIED`（点击后回读不一致，不重试）、
`E_NO_INPUT`（传输不支持草稿输入）、`E_INPUT_FOCUSED`（评论输入框打开时拒绝按快捷键）。

## 搜索与评论补充

- `search type=user`：打开 `...?type=user`，读非 self 的 `/user/` 链接，过滤导航/空文本，按 userId 去重；
  空结果返回 `ok:true,count:0,note`（不是选择器错误）。
- `search type=live`：打开 `...?type=live`，读 `/live/`、`live.douyin.com/<id>`、`[data-e2e*=live]`
  三类白名单结果，按 roomId 去重；确实无直播时返回 `ok:true,count:0,note`。
- `comments`：初始评论拿到后、滚动前，`count('button.comment-reply-expand-btn')`，
  最多点 `min(limit, commentReplyExpandMax=20)` 个（每次 nth=0 + 等 500ms），
  点完重新 list 同一评论容器并按 `...` 段合并 replies；`replyCount` 取真实值/回复段数。
  点失败跳过，不把“展开N条回复”按钮当评论。

## 写操作第一层（点赞/收藏/评论草稿）

- 只 owner/home；账号级串行（复用插件 SerialQueue）。真实写必须 `confirm:true`，否则 `E_CONFIRM_REQUIRED`；
  `dryRun:true` 只打开视频页读状态/选择器，不点击。
- 写前检查标题与登录浮层；`E_CHALLENGE/E_LOGIN_REQUIRED` 直接停，不写。
- 点赞 `[data-e2e="video-player-digg"]`、收藏 `[data-e2e="video-player-collect"]`；点击后回读
  **`data-e2e-state`**（2026-11-08 实测：点赞 `video-player-is-digged`/`video-player-no-digged`，
  收藏 `video-player-is-collected`/`video-player-no-collect`；class 是 CSS Modules 哈希、aria 为 null），
  读不到再回落 class/aria/文本计数；`verified` 只来自回读，不一致返回 `verified:false, E_UNVERIFIED`，不重试。
- 图文作品（`/note/<id>`）从 `/video/<id>` 客户端重定向，按钮会晚 1–2 秒挂载：`readToggleState`
  最多重试 3 次×700ms；已在 `/note/<id>` 时不重复导航。
- **点击被挡时的键盘回退（2026-11-09 真机验收）**：Playwright click 在点赞/收藏按钮、feed 卡片、
  `<video>` 上都会 15s 超时（元素能找到，但命中测试被浮层挡住）；实测 `force` 点击会点到遮罩上，
  状态不变。改用远程 X11 键盘：
  - 抖音网页版快捷键：**Z=点赞、C=收藏、X=评论**（两处外部资料一致，Z/C 已真机双向验证）；
  - 快捷键只对“有焦点的播放器”生效：`transport.pressKey()` **默认先** `focusPage()` 在 Chrome
    窗口中心点一下（xdotool，X 层鼠标，绕开命中测试），等 300ms 再 `xdotool key z/c`；
    聚焦已折进 `pressKey`，调用方不需要记得单独加（`focus:false` 可关）；
  - 关键顺序：点击失败后**先回读**确认状态没变，再按键，避免二次切换；
  - 评论框打开（`[contenteditable]`）或有 `input:focus`/`textarea:focus` 时拒绝按键（`E_INPUT_FOCUSED`），
    防止把 z/c 打进输入框；
  - 工具参数 `inputMode`：`auto`（默认，先点后回退键）/`click`/`key`；结果里带 `via: "click"|"key"`。
- 本地账本 `<downloadDir>/.write-ledger.json` 记 videoId/action/targetState/at/result/verified；
  同 videoId+action+目标状态已验证则幂等，不重复点。
- 评论草稿：打开评论栏，输入框真实 selector `[contenteditable]`（DraftEditor）；点击聚焦后**等 400ms**，
  再用**远程剪贴板粘贴**（文本写临时文件 → `xclip -selection clipboard -i` → `xdotool key ctrl+v`），
  读回输入值 → `draftFilled:true, draftValue, inputVia:"paste"`；**默认不提交**。
  依赖远程 `xclip`（2026-11-09 远程 Ubuntu 已 `apt-get install -y xclip`，0.13-3）；
  没有 xclip 时回退 `xdotool type`（中文丢字严重，不推荐）。
  - **已有草稿先清空**：2026-11-09 真实事故——框里留着上次草稿时，第二次直接打字会插到光标处、重复一遍；
    现在点完输入框先 `ctrl+a BackSpace`（`transport.clearText`），读回不匹配时再清空重打一次（本地草稿，不涉及提交）。
  - **@提及**（2026-11-10 真机）：文本以 `@名字` 开头时，粘贴的 `@` 只是普通字符、不会触发提及；
    改为键盘输入 `@`+名字 → 候选列表（`[class~="lgAE_oZa"]`）→ 回车/点选 → 生成 `douyin_mention_word` 提及 →
    再粘贴剩余正文。返回 `mention` 与 `inputVia:"mention+paste"`；候选没出现就 `E_UNVERIFIED`，不静默降级成普通文本。
  - 删除评论：`dy_douyin_comment_delete` 按文本匹配当前**已加载**的评论（最多 50 条），点该条
    `[data-e2e="video-comment-more"]` → 菜单 `text=删除评论` → 回读列表确认消失；找不到返回 `E_NOT_FOUND`，
    不是自己的评论没有删除项 → `E_SELECTOR_MISS`，绝不盲删。返回里的 `loadedBefore/loadedAfter` 是
    “本次抓取到的条数”，不是视频总评论数；删一条后下一条会补位，所以两个数可能相同，判断以 `verified` 为准。
  - 幂等：同 videoId 已有 `comment:posted` 已验证账本时，再评论返回 `idempotent:true`（带 before/after，不发送）；
    要再发一条传 `force:true`（仍需 `confirm:true`）；删除成功后清掉该记录。
  `draftOnly:false + confirm:true` 才尝试点 `commentSubmitSelectors`；选择器已从真实页面抓取
  （`#comment-input-container .commentInput-right-ct span:last-child`；空文本 class 为 `wchsYBpK`，
  有文本时变 `wchsYBpK jfGCpJo0` 启用态），但**真实提交未验收**，第一次点击后必须靠评论列表回读确认。`replyTo` 暂不支持（返回 `E_BAD_ARG`），
  不做自动回复/批量评论。

## 私信（/chat）

- 只回**已有会话**：`dy_douyin_dm_send` 不会新建会话/群发/自动回复。
- **回复窗口（2026-11-10 主人定）**：不设白名单；只允许回复“对方消息在 `dmReplyWindowMs`（默认 1 小时）内”的会话。
  抖音私信只显示日期（10/30）或 “刚刚 / N分钟前 / HH:MM”；只有能解析出 ≤1 小时的才放行，旧日期一律 `E_STALE`。
- **主人例外**：`/sdcard/DSHA/媒体/抖音/dm-owner.txt` 第一行写主人会话名；别名默认 `饲养员`/`草荧`（`dmOwnerAliases`）。该会话可主动发（不受 1 小时限制），列表/事件里 `isOwner=true`。
- **稳定 id（2026-11-14）**：`dm_list` 每条会话有 `id=dmc_<名字 hash>`（重名按顺序 `-2/-3`）+ `index`；`dm_read` 每条消息有 `id=<conversationId>.m_<fromMe+正文 hash>` + `index` + `isOwner`。
- **精确回复**：`dm_send` 支持 `messageId`（反推会话并校验该消息仍在已加载列表里）、`conversationId`、`index`、`name`；同时给多个选择器只做一致性校验。重名/多候选 `E_AMBIGUOUS`（带 `indexes/candidates`），找不到 `E_NOT_FOUND`，messageId 指向自己发的消息 `E_BAD_ARG`，**绝不按名字猜**。
- **消息 id 稳定性**：同一条消息在连续读取中 id 不变（时间标签变化不影响 id）；相同 `fromMe+text` 的重复消息按出现顺序加 `-2/-3`。只加载最近 50 条，超出范围无法用 messageId 定位（重新 `dm_read`）。
- 限额：`dmDailyLimit` 默认 3 条/天，按审计里当天 `cmd:"dm_send", ok:true` 计数；失败不占额度。
- `dm-allowlist.json` 已弃用（保留兼容，不再作为门禁）。
- **跑完自动回原页面**：`dm_list`/`dm_read`/`dm_send` 会记下进入 `/chat` 前的 URL，结束时恢复；
  避免把浏览器留在私信页、切不回视频。恢复失败只 warn，不影响工具结果。
- 发送流程：打开 `/chat` → 按 `messageId`/`conversationId`/`index`/`name` 精确找到会话并点开 → 点输入框 `[data-slate-editor="true"]` →
  `clearText` → `pasteText` → 读回草稿 → 检查发送按钮带 `messageMsgInputpublishRedBtn` → 点 `.e2e-send-msg-btn` →
  回读消息列表，确认出现 `isFromMe` 且包含正文的那条。
- 账本只记 `name/chars/textHash`，**不存私信正文**；工具返回也不含正文。
- 选择器（2026-11-10 真机）：会话名 `[class~="conversationConversationItemtitle"]`、
  消息 `[class~="MessageItemTextcontainer"]`（`MessageItemTextisFromMe` = 自己发的）、
  发送 `.e2e-send-msg-btn`。

## 下载与观看记忆

- `dy_douyin_download` **不会**被 feed/search/open 自动调用；只有显式调用才下载。
- `quality` 只做参数校验（`best/source/720p/1080p/540p`）；当前取页面首个 source（通常最高码率），
  不保证与请求分辨率一致。
- 媒体来源：优先远程 `html video` 的 `<source src>`（HTML 实体反解、只允许抖音媒体域名 https），
  取不到再回退 `list video source`；仍无 → `E_NO_MEDIA`，提示主人手动保存，不绕路。
- 本地 `fetch` 流式写入临时文件，校验 MP4 后 rename；单文件 300MB 上限、10 分钟超时、失败清理 tmp。
- 下载成功写 sidecar `.../<videoId>.json`：`videoId/title/author/file/bytes/seconds/downloadedAt`；
  **download 不写观看记忆**，避免把“打开下载”误当“看完”。
- 看完后显式调 `dy_douyin_watch`：从 sidecar 取 title/author/file，写一条观看记忆
  `source='douyin_watch'`、`ref` 带 videoId+路径、`header` 用当前 session header；
  `thought/summary/note` 分别截断；成功后更新 sidecar 的 `watchedAt/watchMemoryId`，
  同 videoId 再次调用幂等跳过；`dyMemory` 不存在/写入失败只 warn，不抛。
- 作者优先从视频页 JSON-LD（Breadcrumb 的 user 链接）取，再试 HTML（data-e2e/user 链接/meta）
  和页面文本（@xxx/作者：xxx）；取不到才 `未知`。不写转写/评论全文、不发消息。

## 测试

```sh
cd /root/.dsh/plugin-src/dsh-douyin
npm run check   # node --check 所有 lib
npm test        # node --test tests/*.test.mjs（不真连 SSH）
```

- 全部用 fake transport / fake SSH 子进程；不会 spawn 真实 ssh、不碰生产目录。
- 覆盖：远程不可用、key/known_hosts 缺失、超时、SSH 认证失败、坏 JSON、非法参数、
  时段/配额/最小间隔拒绝、并发串行/E_BUSY、截图路径/PNG/超限失败、审计重建、owner 门禁、
  推荐流 scroll 去重/最多 3 次/失败回退、搜索等待卡片/click+Escape/modal_id 解析/验证码/无卡片/点击失败跳过、
  搜索失败一次重试成功/只重试一次/不可重试错误不重试/空 list 继续等、
  blockAssets 开/关/assets 失败继续/status 回报、watch <10s/≥10s 结算、feed/search 免费、
  comments 触发结算、配额满后 open 被拒而 feed 仍可浏览、charge 不改 lastCallAt、
  like/favorite dryRun/confirm/状态回读/undo/账本幂等、评论草稿填充/提交回读/选择器缺失、
  下载成功/短链/媒体提取/体积上限/磁盘不足/权限失败/不自动下载、作者解析、sidecar 写读更新、
  download 不写记忆、watch 成功/重复幂等/无 memory/失败不抛/路径校验、
  评论回复展开/点失败跳过、search user/live 的 URL/去重/空结果、
  notify_list 的解析/只读/loadMore/空面板/参数校验/稳定 id/owner/replyable、notify_reply 的 confirm/类型/定位/id/歧义/旧消息/成功路径/拿不到 videoId/回复失败/主人显示名回退、
  通知实时事件源（3s 默认间隔、baseline、badge 变化才开面板、无变化不反复开、DOM 直投、net 触发、面板被动读、E_PAGE_UNSAFE 不导航、利率限制、owner→home/其他人→统一抖音、home 不可用、状态落盘、订阅、jsWatch start/take/stop、角标解析、绝不点搜索框/条目）；
  私信精确选择（dm_read 的 conversationId/index/name、重名 E_AMBIGUOUS、messageId 稳定/找不到/指向自己、dm_send 按 id 发送/回读、主人别名、没有选择器拒绝）、私信 watcher（基线/owner/时间归一/队列/订阅/失败恢复/状态落盘/启停/并发 busy/不触达 home）。

## 部署注意（不由本任务执行）

1. 远程需先部署 `/persistent/cdp/client-stdin.js` + `bridge.sock`（另一个任务）；
2. 本地需生成专用 ed25519 key 并加入远程 `authorized_keys`，known_hosts 固定；
3. 注册前由主人跑 `verify-restart.mjs`，确认 `insert id` 唯一、package/patch 合法、无重复注册；
4. 同一插件只能注册一次（bundle patch 与 profile insert 二选一，别同时写）；
5. 不装包、不改 profile、不重启；注册/重启由主人点头。

## 未做 / 风险

- **通知回复（task-12）**：写操作、confirm 门控；点通知条目会**标记已读**；`videoId` 只能靠点条目跳转拿；只支持 `mention/comment_reply`，like/follow 不点并返回 `E_NOT_REPLYABLE`；时间只有日期/星期或超 1h 在点之前 `E_STALE`。**真实回复未执行/未验证**（测试用 fake `commentReply`）；首次真实使用需主人确认目标与正文。
- **通知实时事件源（task-13，2026-11-14）**：默认关闭（`notifyWatchEnabled=false`），本轮**没有改 profile、没有重启**。
  代码默认 3s，但 profile 里旧的 `notifyWatchIntervalMs: 600000` 会在归一化时回落 3000（超出 2000–30000 范围），
  下次重启后按 3s 跑；请确认这是要的行为。角标选择器默认是通知入口；真机只读探测时页面在 `/chat`（角标 E_BADGE_MISS、
  不开面板），**还没有在真实首页验证“数字角标出现→开面板”的完整链路**，首次开启需观察日志/status。
  jsWatch 的 observer 在页面导航后会丢，watcher 每 10s 幂等重装；`stop` 只断 observer，远端 fetch/XHR 包装会留到页面刷新。
  watcher 固定跑在 notify tab（不导航 main）；notify tab 若被切到视频/私信/非抖音页面会返回 E_PAGE_UNSAFE，等它恢复后再补；
  基线失败期间的通知可能被当成历史基线吞掉（宁少不多）。
- **通知事件投递**：主人→home（contactId=actor），其他人→统一 `contactId='douyin'` 的会话；这是 dsh-douyin 侧对
  “主人→home，其他人→统一抖音会话”的实现。若 autonomy 也订阅并路由，注意不要重复投递（可设 `notifyWatchDeliver:false`）。
- **通知恢复面板**：关闭只按 Escape/通知入口切换；真机资料说 Escape 单独可能不关面板，所以仍保留“入口切换”兜底；
  任何代码都不再点 `notifyCloseSelector/searchbar-input`（旧字段保留兼容但不再使用）。
- **通知面板回复**：`notify_reply` 已实现，固定 notify tab：点条目拿 `modal_id`（会标已读）→ 在同一个 notify tab 评论区回复；回复完 notify tab 回首页，main 不动。id 优先、index 次之；id/index/target 冲突 `E_BAD_ARG`，多条 `E_AMBIGUOUS`。
- **私信 watcher（2026-11-14）**：默认关闭（`dmWatchEnabled=false`），本轮**没有改 profile、没有重启**，所以生产不会自动开始轮询。
  开启后按默认 3s 在独立 dm tab 只读 `/chat` 会话列表，不会把 main 留在 `/chat`，也不和 feed/search/open 抢页面
  （2026-11-14 已改为多页面 role 模型；`dmWatchIntervalMs` 可配 2–5s）。
  事件来自会话列表的“最后一条预览 + 时间标签”，**没有消息 id/方向**；精确到某条消息要用事件里的
  `conversationId` 再 `dm_read`。列表层无法区分“同一会话在 1 小时内又发了完全相同的文字”（相对时间已归一为 recent 防误报）。
- **私信稳定 id**：`messageId` 只覆盖当前已加载的最近 50 条；消息列表变了/被挤出 50 条后旧 id 会 `E_NOT_FOUND`（不盲发）。
  同名会话按出现顺序加 `-2/-3`，会话改名会生成新 `conversationId`。
- **通知稳定 id**：`type+actor+text+time` 的 hash；同一快照内完全相同的通知按顺序加 `-2/-3`。
  面板重新加载/顺序变化时 `index` 会变，`id` 在同内容下稳定；回复前都会重新读面板，找不到就 `E_NOT_FOUND`。

- **评论/搜索已做真机验证**：`[data-e2e="comment-item"]` + `button.comment-reply-expand-btn` 能展开回复；
  `search type=user/live` 能返回结果/空结果 note。视频卡片 modal 流程仍按既有白名单实现，改版时可能失效。
- **鼠标命中被挡（2026-11-09）**：Playwright click 在点赞/收藏按钮、feed 卡片、`<video>` 上 15s 超时
  （元素可见/稳定，但命中测试被浮层挡）；`force` 点击会点到遮罩、状态不变。点赞/收藏已用键盘 Z/C 回退
  （先窗口中心点一下聚焦），真机双向验证通过；评论输入/提交仍走点击，若同样被挡需另做键盘方案。
- **写操作只到 dryRun/草稿**：真实点赞/收藏/评论提交**未执行**；点赞/收藏回读已改读
  `data-e2e-state`（2026-11-08 真机 dryRun 四种状态全部读对，含 10.6 万赞的万级计数视频），
  但**点击后的回读尚未真机验收**；评论提交按钮选择器已抓取，真实提交未验收；短信验证浮层会直接
  `E_LOGIN_REQUIRED`；xdotool 草稿可能留在输入框（2026-11-08 采集后已清空）。
- **搜索卡片/`modal_id`/scroll 流程未实测**：`div.search-result-card`、click 的 `nth`、
  `modal_id` 参数与 `scroll`/`press` 命令都是按新桥约定实现；远程 DOM 未验收，失败会返回错误码。
- 抖音页面会弹登录浮层/验证码；插件只识别标题里的验证码/登录字样并返回错误码，不做自动过验证码。
- 登录态失效、DOM 改版、远程 OOM/桥崩溃都会以错误码返回；不自动重试/重放。
- 下载已做真实链路验证：远程 `html video` 返回签名 MP4，本地 fetch 200、完整文件 2,488,274 字节，
  ffprobe 7.566667s；作者从 JSON-LD 取到 `许肆意.`，sidecar 已写入；`dy_douyin_watch` 用 fake dyMemory
  实测写入并验证重复幂等（真实记忆库未在未重启的当前进程中写）。签名 URL 有时效，过期返回 `E_NO_MEDIA`。
- 真机评论：video 7704981021560687882 返回 20 条，5 条带 replies；首条 replyCount=1、回复作者 `ciclisti`。
- 真机搜索：`海` type=user 返回 5 个用户；type=live 返回 5 个直播间（roomId 去重）。
- 真机写 dryRun（2026-11-08 晚，新代码）：like 已赞视频 `7558343112453410106` →
  `state=video-player-is-digged, active:true, count:628`；未赞 `7502397064967753010` →
  `no-digged, active:false, count:106000`；`7583327361597263138` → `no-digged, active:false, count:118`；
  favorite 已收藏 `7704981021560687882` → `is-collected, active:true, count:1540`；未收藏
  `7558343112453410106` → `no-collect, active:false, count:82`；均未点击。
- 评论提交按钮（2026-11-08）：输入草稿后 `#comment-input-container .commentInput-right-ct span:last-child`
  唯一命中发送图标（class 从 `wchsYBpK` 变 `wchsYBpK jfGCpJo0`），随后已清空草稿；未点发送。
- 真机安全门：随后评论/视频页出现短信验证浮层（`[class*="verify_sms"]` 计数 6），like dryRun 与
  comment draft 实测均返回 `E_LOGIN_REQUIRED`，不输入/不点击；真实写未执行。

## 2026-11-16 读写稳定性 / 性能优化（桥协议 v2）

> 背景：bridge.log 实测 `click ok` 平均 2,214ms（5,835 次里 **0 次 <100ms**）、notify tab 崩溃后
> 20,276 次 `Target crashed` 空转 5 小时、用户写操作要排在两个 3s watcher 后面（p95 排队 1,305ms）。
> 本次按「协议 v2」改造桥 + 插件，全部有实测证据（见 `/sdcard/DSHA/工作区/团队/2026-11-16-抖音优化/`）。

### 桥新命令（`/persistent/cdp/cdp-bridge.js`，capability 见 `ping.capabilities`）
| 命令 | 用途 |
|---|---|
| `health` | 每个 role 的 `{url,title,renderer:'ok'\|'crashed'\|'closed'\|'unknown'}`；**不进串行队列**，p95 有保证 |
| `probe` | 一次往返拿 `url/title/readyState` + ≤8 个 selector 的 count + 一次 list（替代 4–6 次往返） |
| `waitFor` | `{selector,state,timeoutMs}` → `{matched,ms}`，替代 20×`count` 轮询 |
| `netArm`/`netTake` | 固定包装 fetch+XHR，只记 `url/method/status/seq`（不存 body），写操作等接口响应用 |
| `type` | 桥内文本输入（`fill`/`insert`/`keys`），**中文不再依赖 X11 剪贴板/xdotool** |
| `press` | 白名单加 `z/c/x`；输入框聚焦时返回 `E_INPUT_FOCUSED`（`allowFocused:true` 仅提交/关面板用） |

### 行为变化
- **崩溃自愈**：每个 role page 挂 `page.on('crash')`，崩溃页立即摘出映射并 close，下次 `ensureRolePage` 重建；
  `context.on('close')` 清理映射。watcher 连续失败走**指数退避 3s→6s…60s + 熔断**（12 次/冷却 5 分钟）。
- **队列分道**：`userQueue`（工具）与 `watchQueue`（watcher 原语，深度 1）分开，用户调用不再排在 watcher 后面；
  `service.queueStats()` 暴露深度与 `retryAfterMs`。
- **写路径**：`openForWrite` 一次 `probe`；写后回读改轮询（120ms/1.6s，状态一变立即返回）；
  `inputMode=auto` 改为**桥内快捷键优先 → click 兜底 → X11 兜底**；文本输入桥内 `type` 优先。
- **错误码**：新增 `E_EXECUTION_UNKNOWN`（动作已发出但结果读不到；**先查真实状态，绝不自动重放**）。
- **watcher 面板**：`notifyWatchSource=panel` 不再每 tick 开关面板，改为 trigger 优先 + `notifyPanelPollMs`（默认 60s）节流。

### 新增配置（均有默认值）
`clickTimeoutMs=3000`、`clickScrollTimeoutMs=600`、`openReuse=true`、`probeEnabled=true`、`waitForTimeoutMs=2500`、
`writeVerifyPollMs=120`、`writeVerifyTimeoutMs=1600`、`toggleReadRetries=4`、`toggleReadWaitMs=150`、
`netVerifyEnabled=true`、`netVerifyTimeoutMs=1500`、`notifyPanelPollMs=60000`、
`watchBackoffMinMs=3000`、`watchBackoffMaxMs=60000`、`watchBackoffFactor=2`、
`watchBreakerFails=12`、`watchBreakerCooldownMs=300000`。

### 部署
```bash
# 桥（会短暂关闭远程 Chromium 窗口，需主人同意后执行）
DRY_RUN=1 bash /root/.dsh/plugin-src/dsh-douyin/bridge/deploy.sh
bash /root/.dsh/plugin-src/dsh-douyin/bridge/deploy.sh
bash /root/.dsh/plugin-src/dsh-douyin/bridge/restart.sh   # 见 bridge-report.md §6
# 插件：主人手动重启 DSH App（profile 未改；插件代码已同步）
```
