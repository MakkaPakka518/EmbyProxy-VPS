# Emby 反代管理面板（VPS 版）

> 由 Cloudflare Workers 版反代面板移植的 VPS 自托管版本。零依赖 Node 实现，**不占用 80/443 端口**，支持**前后端分离**（前端登录域名与后端推流域名不同），只反代前端域名也能自动识别并反代后端推流。

- **管理面板**：TG PERSONA 同款深绿青柠主题，深色 / 米白亮色双模式，手机与桌面自适应
- **界面整理（v2.2.1）**：低频的「反代配置（前后端分离）」移动到全部功能最底部并默认收起；顶栏仅保留一个主题切换入口
- **媒体断线保护（v2.2.0）**：播放器退出、拖动或网络中断时立即取消上游拉流，并按下游背压转发，避免客户端已断开但 VPS 继续下载整部原盘
- **版本与一键更新（v2.2.0）**：顶栏显示当前版本，每次进入面板自动检查 GitHub；管理员可一键固定最新 main commit、备份程序文件、校验替换并重启服务
- **节点列表自动展示延迟**：每个节点卡片自动测速并实时显示延迟，点击徽章可重新测速
- **节点图标**：内置 TFEL Emby 图标库（528 个透明 PNG），添加/编辑节点时可搜索选择
- **源站保护**：节点源站地址默认隐藏（点击才可查看），**订阅用户不可见源站地址**，也无测速权限
- **播放统计图**：Chart.js 图表 —— 过去 7 天播放趋势折线 + 今日各节点播放柱状图
- **IP 访问控制**：全局白/黑名单、IP/CIDR 网段、国家码整体封锁；被拦可 302 跳转或显示禁用页；`/entry` 逃生入口 + 最高白名单兜底
- **TG bot 签到（v2.0.0 新增）**：面板内置 Telegram 签到——手机号 / session 登录后给机器人发命令（如 /checkin），每天时间窗内自动执行；自研 MTProto 客户端直连 Telegram，零第三方依赖
- **TG Persona 自动化（v2.1.0 新增）**：在签到账号之上叠加自动化——关键词自动回复 / 点表情、群保号定时发言（可自动删除）、签到（点按钮 / 连点 / 成功失败判定 / 积分提取）、抢注监控、抢红包、自定义多步任务（含验证码识别）、自动水群、通知推送（Bark / TG Bot）、会话守护，全部面板可视化配置
- **部署**：单文件 `server.js` + 单文件 `panel.html`（+ 可选 `tg-persona.js` 自动化模块），零依赖，systemd 常驻

---

## 特性一览

| 能力 | 说明 |
| --- | --- |
| 端口 | 默认 `3333`，不占用 80/443 |
| 认证 | 三档：管理员密钥 `ADMIN_TOKEN` > 网页密码（可选）> 订阅者密钥 |
| 节点反代 | 前缀路由表：`/xxx/**` → 目标地址，多目标逗号分隔自动 failover |
| 媒体断线保护 | 下游关闭后立即 Abort 上游请求并停止回源；转发遵守 backpressure，避免流量黑洞和内存堆积 |
| 在线更新 | `VERSION` 版本号、登录自动检查 GitHub、管理员一键更新；固定 commit 下载、限大小/路径校验、程序文件备份与失败回滚 |
| 前后端分离 | 只需填/反代**前端域名**，媒体源站自动识别并回源推流 |
| URL 双形式改写 | 已知源站 → 同源简洁形式；未知媒体源站 → 携带完整源站 URL 的绝对回源形式 |
| `/emby` 前缀回退 | 目标对不上时自动尝试 `目标地址/emby/...` |
| 伪造请求头 | 每节点可选 `strict` / `dual` / `realip_only` / `off` 模式（Origin / Referer / X-Real-IP） |
| WebSocket | 升级请求透明透传 |
| 静态资源缓存 | 图片等静态资源缓存提速；带鉴权态的请求不缓存，防止串号 |
| 自动测速 | 节点列表加载后自动 ping 全部节点并展示延迟，点击徽章重新测速，支持一键全部测速（仅管理员） |
| IPv6/IPv4 优先 | 全局可选"自动 / IPv6 优先 / IPv4 优先"（系统级 DNS 顺序），单个节点可单独覆盖（http 目标）；缺对应地址族自动回退 |
| 双栈监听 | 服务同时监听 IPv4 + IPv6，纯 IPv4 / 纯 IPv6 / 双栈机器均可访问面板 |
| 节点图标 | 内置 TFEL 图标库（528 个），添加节点时搜索选择，卡片显示对应图标 |
| 源站保护 | 管理员：源站链接默认隐藏，点击"点击查看"展开；订阅者：源站完全不可见，且无测速权限 |
| 拖拽排序 | 节点卡片可拖拽排序，自动保存 |
| 播放统计 | 仅按 `/PlaybackInfo` 播放点火计数，按节点/天聚合；Chart.js 展示 7 天趋势折线图 + 今日各节点柱状图 |
| 管理功能 | 节点增删改、多线路动态添加、订阅者管理、导入导出备份、缓存清理 |
| 反代 Token 门禁 | 账户弹窗可开启并设置字母数字密钥；开启后所有节点/302/改写链接需带 `/密钥/` 前缀才可反代，不带前缀的访问 302 跳转 `/catch` 展示"宝贝抓到你了"+ 来访 IP/UA，并记录到本地（面板内可查、可清空）；关闭立即恢复 |
| IP 访问控制 | 账户弹窗可设置白名单/黑名单、IP/CIDR 网段、国家码、跳转网址；面板与节点链接统一拦截，被拦可 302 跳转或显示禁用页；`/entry` 逃生入口只认管理员密钥，登录 IP 自动进最高白名单（黑/白模式均例外），最高白名单可增删；无 cookie 逃生 |
| TG Persona（v2.1.0） | 关键词自动回复/点表情（多规则同时命中）、群保号定时发言+自动删除、签到（窗口随机时刻、按钮文本/表情定位、连点 1-N 次、成功/失败关键词判定、积分正则提取、失败重试、结果发群）、抢注（监听+轮询双模式、{code} 提取）、抢红包（按钮自动点击）、自定义多步 JSON 任务（send/wait/click/captcha/awaitReply，OpenAI 兼容视觉 API 验证码识别）、自动水群（窗口同句 N 条跟发）、通知推送（Bark/TG Bot，成功失败分开关）、时区、拟人化延迟+同群冷却、会话掉线守护、日志分类筛选 |

---

## IP 访问控制（白名单 / 黑名单 / 国家封锁）

账户弹窗 → **IP 访问控制** 区域（管理员可见）：

- **模式**：关闭 / 白名单（仅命中放行）/ 黑名单（命中跳转）
- **IP 列表**：每行一个 IP 或 CIDR 网段（如 `1.2.3.4`、`5.6.7.0/24`），支持 IPv4/IPv6
- **国家列表**：每行一个 ISO 两位国家码（如 `US`、`RU`、`CN`）；需反代层（nginx/caddy/CF）透传 `cf-ipcountry` 或 `x-country` 请求头才生效，直连访问该字段为空
- **跳转网址**：被拦截时 302 跳转到该地址；留空则显示「你的 IP 已被禁用」页面
- **拦截范围**：面板页面、节点反代链接、WebSocket 连接统一生效（`/api/*`、`/entry`、`/catch` 等系统保留路径永不拦截）

### 管理员逃生入口 `/entry`

- 访问 `https://你的域名:端口/entry`，输入**管理员密钥**（`data/config.json` 的 `adminToken`）即可解锁
- 登录成功后当前 IP **自动加入最高白名单**，任何模式下都放行面板与节点
- 最高白名单可在账户弹窗与 `/entry` 就地增删（共享节点的他人 IP 可随时移除）
- **无 cookie 逃生**：与 CF 版一致，面板登录（admin_token cookie）不构成 IP 逃生——不在名单内的请求一律拦截，只能通过 `/entry` 恢复

## 目录结构

```
emby-proxy/
├── server.js          # 主程序（零依赖，仅用 Node 原生模块）
├── panel.html         # 管理面板前端（iOS 风格）
├── updater.js         # GitHub 固定 commit 检查、备份、校验、替换与回滚
├── VERSION            # 当前语义化版本号
├── tg-persona.js      # （可选）TG Persona 自动化模块，缺省不影响面板其余功能
├── install.sh         # 一键安装 / 升级 / 卸载脚本
├── data/
│   ├── config.json    # 管理员密钥 / 网页密码 / 订阅者 / 前后端域名 / 网络优先 / ipguard 访问控制
│   ├── routes.json    # 反代节点路由表
│   ├── stats.json     # 播放统计
│   ├── tg.json        # TG 签到账号 / 任务 / 日志（session 加密存储，600 权限）
│   └── persona.json   # TG Persona 规则 / 保号 / 任务 / 日志（600 权限）
└── test-upstream.js   # （可选）本地模拟 Emby 源站，用于自测
```

---

## 部署

### 方式一：一键脚本（推荐）

把 `install.sh`、`server.js`、`panel.html` 三个文件放同一目录，然后：

```bash
sudo bash install.sh
```

（GitHub 仓库上传后，也可以一行搞定，无需下载文件：）

```bash
curl -sSL https://raw.githubusercontent.com/MakkaPakka518/EmbyProxy-VPS/refs/heads/main/install.sh | bash
```

脚本自动完成全部步骤：检测 Node.js → 下载程序文件 → 生成管理密钥 → 初始化配置 → 注册 systemd（开机自启 + 崩溃自动重启）→ 验证面板 → 输出面板地址和管理密码。

跑完记下输出的**面板地址**和**管理密码**，浏览器打开 `http://服务器IP:端口/` 输入密码即可登录。已安装过再跑一遍会保留原有配置，可当升级用。

#### 一键卸载

不想用了，同样一条命令卸载干净（停止服务、删除 systemd 托管、删除全部配置/节点/订阅者数据）：

```bash
sudo bash install.sh uninstall
```

（也可以不下载文件直接卸载：`curl -sSL https://raw.githubusercontent.com/MakkaPakka518/EmbyProxy-VPS/refs/heads/main/install.sh | bash -s uninstall`）

执行后会先问一句确认，输入 `y` 回车才真正删除，误输入或回车直接取消，不会动任何东西。卸载后想重装，再跑一次安装命令即可。

### 方式二：手动部署（可选）

不想用脚本的话，按下面四步手动来。

#### 环境要求

任意 Node.js ≥ 18（推荐 v20，已实测 v22），零第三方依赖，无需 `npm install`。

### 第一步：建目录、放文件

```bash
mkdir -p /opt/emby-proxy/data
```

把 `server.js`、`panel.html` 上传到 `/opt/emby-proxy/`（宝塔文件上传 / scp 均可），再 `ls -l /opt/emby-proxy/` 确认两个文件都在。

### 第二步：初始化配置

```bash
cat > /opt/emby-proxy/data/config.json <<'EOF'
{
  "adminToken": "换成你自己的密钥",
  "adminPass": null,
  "subscribers": [],
  "frontendDomain": "",
  "backendDomain": ""
}
EOF
echo '[]' > /opt/emby-proxy/data/routes.json
```

（`adminToken` 改成你自己的密钥，它就是以后登录面板的管理员密钥）

### 第三步：注册 systemd 服务

先取 node 真实路径（填到下面 `ExecStart=` 后面）：

```bash
which node
```

然后执行（`ExecStart` 用刚才 `which node` 的输出替换）：

```bash
cat > /etc/systemd/system/emby-proxy.service <<'EOF'
[Unit]
Description=Emby Proxy Manager (VPS)
After=network.target

[Service]
WorkingDirectory=/opt/emby-proxy
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now emby-proxy
```

确认启动成功：

```bash
systemctl status emby-proxy
```

看到 `active (running)` 即成功；`failed` 见下方排查表。

### 第四步：验证

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3333/          # 输出 200 即面板已启动
```

再试登录：

```bash
curl -s -X POST http://127.0.0.1:3333/api/login \
  -H 'Content-Type: application/json' \
  -d '{"token":"你第二步设置的密钥"}'
```

返回 `{"success":true,"role":"admin"}` 就全通了，浏览器打开 `http://你的服务器IP:3333/` 就能进面板。

---

### 常见问题排查（部署必看）

**Q: 服务启动失败（`failed`）？**  
先看日志，日志会告诉你真实原因：

```bash
journalctl -u emby-proxy -n 30 --no-pager
```

常见报错对照：

| 日志关键字 | 原因 | 解决 |
| --- | --- | --- |
| `Error: Cannot find module '/opt/emby-proxy/server.js'` | 文件没传上去或放错目录 | `ls /opt/emby-proxy/` 确认两个文件都在 |
| `Error: Cannot find module 'config'` / 找不到 data | `WorkingDirectory` 或 data 目录不对 | 确认 `data/` 在 `/opt/emby-proxy/` 里 |
| `listen EADDRINUSE` | 3333 端口被别的程序占了 | 换端口：改 `server.js` 顶部 `PORT` 后重启 |
| `spawn node ENOENT` / `node: not found` | ExecStart 里 node 路径填错 | 按上面 `which node` 重新填 |

**Q: 怎么重启 / 停止 / 看日志？**（以后改配置都会用到）

```bash
systemctl restart emby-proxy      # 重启（改配置/换文件后必须用它，别用 nohup）
systemctl stop emby-proxy         # 停止
systemctl status emby-proxy       # 看状态
journalctl -u emby-proxy -f       # 实时滚动的日志（Ctrl+C 退出）
```

**Q: 不想用 systemd，就想简单跑一下？**  
临时调试可以（关了终端就没了，不适合长期用）：

```bash
cd /opt/emby-proxy && nohup node server.js > /tmp/emby-proxy.log 2>&1 &
```

---

## 管理面板使用

浏览器打开 `http://你的IP:3333/`，输入管理员密钥登录。

### 添加反代节点

点击「添加节点」：

| 字段 | 说明 |
| --- | --- |
| 节点备注 | 可选，便于识别 |
| 短路径前缀 | 访问路径，如 `emby` → `http://IP:3333/emby/**` 反代到目标 |
| 模式 | `保守（抹除IP）` 透传 / `严格（透传IP）` / `兼容（双重透传）` / `强力（防403）` |
| 节点图标 | 可选。内置 TFEL 图标库（528 个），可在搜索框按名称过滤，点击选中（再次点击取消） |
| 线路地址 | 主线路必填，可动态添加多条备用线路（逗号合并，自动故障切换） |
| 图片缓存 | 开：静态图片走缓存 |

保存后节点卡片会**自动开始测速**，展示最佳线路延迟（如 `32ms`），点击延迟徽章可重新测速。节点卡片默认不显示源站地址，点击「点击查看」才展开；**订阅者登录后看不到源站地址**（显示"仅管理员可见"），也无法发起测速。

### 前后端分离设置（关键）

- **前端域名**：Emby 前端登录域名（例如 `emby.example.com`）
- **后端域名**：后端推流域名（例如 `stream.example.com`，可留空）

只需把**前端域名**加到反代节点。当播放请求返回的媒体地址指向后端域名（或任何未配置的未知源站）时，面板**自动识别**（`/videos/`、`/stream/`、`/audio/`、`.m3u8`、`.ts`、`.mp4`、`.mkv`、`.flv` 等特征）并按"完整源站 URL"形式回源，客户端无需感知后端域名。

### IPv6 / IPv4 优先设置

- **全局（反代配置卡）**：`自动`（跟随系统默认）/ `全局优先 IPv6` / `全局优先 IPv4`，保存后立即生效，影响所有节点的转发与测速。
- **单节点（添加/编辑节点）**：`跟随全局` / `本节点优先 IPv6` / `本节点优先 IPv4`，可单独覆盖全局设置，适合个别线路只有 IPv4（或 IPv6）的场景。
- 节点优先级只对 `http://` 目标生效（`https://` 涉及证书校验不能换连接 IP）；指定地址族连不上时**自动回退**到另一族，不会导致节点不可用。
- 面板服务本身双栈监听（IPv4 + IPv6），纯 IPv4、纯 IPv6、双栈机器都能打开面板；一键脚本自动检测公网地址并输出可直接访问的链接（IPv6 地址自动带 `[]`）。

### 其他功能

- **订阅者**：添加订阅密钥，订阅者用它登录后只能访问面板中启用的反代（只读），无法管理配置，也**无法查看任何节点源站地址**（后端已打码）。
- **全部测速 / 点击徽章重测**：对任意节点执行 HEAD 探测，显示延迟与状态（仅管理员）。
- **清理缓存**：清除已缓存的静态资源。
- **导出 / 导入备份**：一键备份/恢复全部节点与前后端配置。
- **统计**：按节点查看每日播放点火次数与独立 IP 数；图表区展示**过去 7 天播放趋势折线图**与**今日各节点播放柱状图**（Chart.js，CDN 不可用时自动降级为纯数字）。
- **深色模式**：顶栏太阳/月亮按钮切换，自动记忆。
- **账户**：顶栏头像或账户按钮打开账户弹窗，可修改网页登录密码、查看角色、退出登录。

---

## TG Persona 自动化（v2.1.0 新增）

> 需要先部署 `tg-persona.js`（一键脚本会自动拉取；手动升级请与 server.js 一起覆盖）。数据独立存于 `data/persona.json`（600 权限），账号复用 TG 签到的账号体系（`data/tg.json`）。

### 开始使用

1. 在 **TG 签到** 卡片里用手机号登录或导入 session（已有的可直接用）。
2. 打开 **TG Persona** 卡片，在顶部下拉框选择**工作账号**（Persona 所有操作都走这个账号）。
3. 添加**监听群**：填群 `@username` 点添加（复用内核解析，支持群组/频道/用户会话）。
4. 按需配置**规则 / 保号 / 自动化任务**，保存即可自动运行（后台每 2-60 秒轮询一次，可配）。

### 功能说明

- **关键词规则**：命中群消息关键词（逗号分隔多词任意命中，可开正则）→ 随机延迟后 **回复文本**（`||` 分隔随机）/ **点表情** / 两者都做；可限定生效群；同群同规则冷却（默认 20 秒）；多条规则可同时命中。
- **保号**：到点给目标群发内容（`||` 随机，支持 `{num:N}` `{word:N}` `{alpha:N}` `{uuid}` `{time}` `{date}` 占位符），可设定**发送后 N 秒自动删除**；时间窗随机时刻或固定间隔两种模式；支持立即执行。
- **签到任务**（增强版）：时间窗随机时刻发命令 → 读机器人回复 → **成功/失败关键词判定** → **按按钮文字或表情定位按钮并点击**（可连点 1-N 次）→ **积分正则提取** → 失败可整链重试 → 结果可发到指定群 + 通知。
- **抢注任务**：监听群消息命中开注关键词 → 自动回复 / 群发注册文本（`{code}` 占位符自动提取验证码/邀请码）；可选**轮询模式**（定时给机器人发探测命令，命中后注册）。
- **抢红包**：监听带按钮消息，按钮文本/表情命中（默认 🧧）自动点击。
- **自定义任务**：JSON 步骤流：`send` 发文本 / `wait` 等待 / `click` 点按钮 / `captcha` 验证码识别（需在设置配置 **OpenAI 兼容视觉 API** base/key/model，或改用手动步骤）/ `awaitReply` 等回复；失败整链重试 N 次。
- **自动水群**：窗口内（默认 5 分钟）同一句话出现 N 条（默认 5）→ 随机跟发一条（`/` 开头的命令不跟）。
- **通知**：Bark Key 或 TG Bot（`聊天ID:BotToken`），成功/失败推送可分别开关。
- **会话守护**：每分钟检测工作账号在线，掉线推送一次通知，恢复自动复位并记日志。
- **拟人化**：随机延迟（默认 1-3 秒）、同群同规则冷却、不处理自己发出的消息（内核解析不返回发送者，机器人消息暂无法单独区分）。

### 已知限制（移植说明）

- TG-Persona 原版（Python/Telethon）的"监听推送"改为**轮询最近消息**（每 2-60 秒，可配），适合低频群。
- 回复为**群内直发**（未做消息引用/Reply），行为与原版"回复"语义略有差异。
- 验证码识别仅支持 **OpenAI 兼容视觉 API**（原版 ddddocr 本地识别无法在零依赖 Node 下移植）。
- 群自动发现（getDialogs）未移植：请用 `@群username` 手动添加；数字 ID 暂不支持。
- 全部接口仅管理员可用（`/api/tg-persona/*`），未登录 / 订阅者返回 403。

### API 速查（TG Persona，全部 POST 为主，均需管理员）

```
GET  /api/tg-persona/state                  总览（设置/统计/群列表）
POST /api/tg-persona/enable     {"enabled":bool}        全局开关
POST /api/tg-persona/settings   {tz,watcherSec,delayMin,delayMax,coolSec,sessionGuard,water,notify,ocr}
POST /api/tg-persona/account    {"accountId":"..."}     选择工作账号
POST /api/tg-persona/chats      {"ref":"@群username","monitored":true}    添加群
POST /api/tg-persona/chats/monitor {"id","on"}          开关监听
DELETE /api/tg-persona/chats    {"id"}                  移除群
POST /api/tg-persona/rules      {name,keywords,regex,action,replies,emoji,chats}   新增规则
PUT  /api/tg-persona/rules      {id,...}                更新规则
DELETE /api/tg-persona/rules    {"id"}                  删除规则
POST /api/tg-persona/keepalive  {name,chats,content,windowStart,windowEnd,intervalMin,deleteAfterSec}  新增保号
PUT  /api/tg-persona/keepalive  {id,...}                更新保号
DELETE /api/tg-persona/keepalive {"id"}                 删除保号
POST /api/tg-persona/keepalive/run {"id"}               立即执行保号
POST /api/tg-persona/tasks      {kind:"signin"|"grab"|"redpack"|"custom",...}   新增任务
PUT  /api/tg-persona/tasks      {id,...}                更新任务
DELETE /api/tg-persona/tasks    {"id"}                  删除任务
POST /api/tg-persona/tasks/run  {"id"}                  立即执行任务
GET  /api/tg-persona/logs       ?type=&q=&limit=        日志（筛选/搜索）
POST /api/tg-persona/logs/clear {mode:"all"}            清空日志
```

---

## API 速查

```
POST /api/login            {"token":"..."}        登录
POST /api/logout           —                      登出
GET  /api/me               —                      当前角色
POST /api/account          {"password":"..."}     设置/修改网页密码（空串清除）
GET  /api/routes           —                      节点列表（订阅者视角 target 打码为 "***"）
POST /api/routes           {prefix,target,mode,cache_img,icon,v6}   新增/更新（v6: auto|v6|v4）
DELETE /api/routes         ?prefix=...            删除
POST /api/routes/reorder   {items:[{prefix,sort_order}]}    排序
GET  /api/routes/export    —                      导出备份
POST /api/routes/import    (body=导出备份内容)     导入备份
GET/POST /api/subscribers  — / {"action":"add"|"del","password":"..."}
GET/POST /api/config       — 前后端域名、networkPreference(auto|v6|v4)
GET  /api/analytics        —                      播放统计（含 trend：过去 7 天）
GET  /api/ping-node        ?url=...               节点测速（仅管理员）
POST /api/purge-cache      —                      清理缓存
```

---

## 常用运维

重启 / 停止 / 看日志等常用命令都在上文"常见问题排查"的表里，不再重复。

- **改端口**：编辑 `server.js` 顶部 `PORT` 常量后 `systemctl restart emby-proxy`
- **改密钥**：编辑 `data/config.json` 的 `adminToken` 后重启
- **升级版本（推荐）**：管理员登录面板后，在顶部「系统更新」卡片点「检查更新 → 一键更新」。更新器会固定 GitHub main 的 commit，备份当前程序到 `data/update-backup-*`，校验归档后只替换程序文件；`data/` 配置与账号数据不动。systemd 安装会自动重启。
- **手动升级**：覆盖 `server.js`、`panel.html`、`tg-persona.js`、`updater.js`、`VERSION` 后执行 `systemctl restart emby-proxy`。

---

## 本地自测（可选）

`test-upstream.js` 是一个模拟 Emby 源站（端口 8096），返回含 `MediaSources` 的 JSON 用于验证 URL 改写：

```bash
cd /opt/emby-proxy && node test-upstream.js &
```

在面板加节点 `prefix=test2, target=http://127.0.0.1:8096`，然后：

```bash
curl -s 'http://127.0.0.1:3333/test2/Items/123/PlaybackInfo' | head -c 500
```

看到 JSON 中的 `http://你的IP:3333/test2/...`（同源简洁形式）或 `http://你的IP:3333/test2/http://后端域名/...`（绝对回源形式）即改写生效。

---

## 常见问题

**Q: 为什么顶栏账户按钮点了没反应？**  
A: 旧版 UI 的弹窗被 `display:none !important` 的 class 压制，点击永远无法弹出。本版已修复（弹窗由 `style.display` 直接控制）。

**Q: 订阅者能看到源站地址吗？**  
A: 不能。后端对订阅者角色的 `/api/routes` 响应中 `target` 一律打码为 `***`，前端显示"仅管理员可见"；且测速接口 `/api/ping-node` 仅管理员可用，订阅者无法探测任意 URL。

**Q: 节点图标库哪里来的？图标加载不出来？**  
A: 图标库数据（528 个图标名称与地址）已内嵌在 `panel.html` 中，图标 PNG 由 `emby-icon.vercel.app` 托管。该站点不可达时卡片会回退为默认图标，不影响其他功能；可自行修改 `panel.html` 里的 `ICONS_DATA` 以替换图标源。

**Q: 节点卡片显示"离线"但 Emby 能访问？**  
A: 面板只对目标地址发起 `HEAD` 请求测连通性，某些源站不支持 HEAD 会误报。点击徽章重测，或直接访问入口验证。

**Q: 统计图不显示？**  
A: 统计图依赖 Chart.js CDN（jsdelivr）。加载失败时自动降级为纯数字展示，不影响统计功能。

**Q: 可以占用 80/443 吗？**  
A: 默认 3333 即为不占用；如确需 80/443，改 `server.js` 顶部 `PORT` 即可，但会与已有 Web 服务冲突，请自行规划。

---

## 原理讲解（小白必读，部署遇到疑问再看）

### 0. 一键脚本为什么要问两个问题？

脚本开始会依次问两件事，直接回车即可：

- **请输入面板端口**：面板服务监听在哪个端口。直接回车用默认 `3333`；想换就输入一个数字（如 `8080`），回车确认。选择端口时避开已在用的端口即可。
- **请输入面板管理密码**：这就是以后登录面板时输入的密码（管理密钥）。直接回车自动生成一串随机密码（脚本结束会打印给你）；想自己定就输入，回车确认。

两个问题都只问一次（首次安装）。**已经装过的机器再跑脚本**，端口仍会让你确认，但密码不会再问（保留你之前的密码，节点/订阅者配置也不动，相当于升级）。

如果是在纯自动化的环境跑（没有终端、无人值守），脚本检测不到交互输入会自动跳过提问，端口用默认 `3333`、密码自动随机生成，行为与旧版一致。

### 1. systemd 是什么？为什么用它？

直接跑 `node server.js` 有两个问题：**一关 SSH 窗口程序就死了**，**服务器重启也不会自启**。systemd 是 Linux 自带的进程管家，用它托管程序后：开机自动启动、程序崩了自动拉起、24 小时在后台跑。托管文件叫"服务文件"，存在 `/etc/systemd/system/` 下。

### 2. service 文件每行是什么意思？

```text
[Unit]
Description=Emby Proxy Manager (VPS)   # 服务显示名，只用于展示
After=network.target                   # 等网络就绪后再启动

[Service]
WorkingDirectory=/opt/emby-proxy       # 工作目录：程序找 server.js 和 data/ 就靠它
ExecStart=/usr/bin/node server.js      # 启动命令 = node + 空格 + 脚本名
Restart=always                         # 进程退出就自动重启
RestartSec=3                           # 崩了等 3 秒再拉起

[Install]
WantedBy=multi-user.target             # 开机自启（multi-user = 正常登录运行级别）
```

### 3. ExecStart 的 node 路径怎么填？

先在服务器跑 `which node` 拿到 node 的**真实绝对路径**，原样填到 `ExecStart=` 后面（中间有空格）：

```text
ExecStart=/usr/bin/node server.js     ← 正确：真实绝对路径 + 空格 + server.js
ExecStart=$(which node) server.js     ← 错误：systemd 不会执行 $( ) 命令替换，启动直接失败
ExecStart=node server.js              ← 错误：systemd 环境里 PATH 不完整，找不到 node
```

### 4. systemctl 命令都是干嘛的？

| 命令 | 作用 |
| --- | --- |
| `systemctl enable --now emby-proxy` | 开机自启 + 立即启动（一条顶两步） |
| `systemctl restart emby-proxy` | 重启（改配置 / 换文件后用它） |
| `systemctl stop emby-proxy` | 停止 |
| `systemctl status emby-proxy` | 看状态，`active (running)` = 正常 |
| `systemctl daemon-reload` | 改了 service 文件后让 systemd 重新读一遍 |
| `journalctl -u emby-proxy -f` | 实时滚动日志（Ctrl+C 退出） |

### 5. 为什么改完配置必须 restart？

面板启动时把配置读进内存，直接改文件不会自动生效。`systemctl restart` 会先杀掉旧进程、再按新文件拉起，是唯一可靠的重载方式。如果此时再手滑跑一个 `node server.js`，会出现两个进程抢 3333 端口，表现为 `listen EADDRINUSE`。

### 6. IPv6/IPv4 优先是怎么实现的？

- **全局优先**：面板通过 Node 的 `dns.setDefaultResultOrder()` 改变系统 DNS 解析顺序——`ipv6first` 让解析结果里 IPv6 地址排前面、`ipv4first` 让 IPv4 排前面。它影响的是所有转发与测速请求的"连接目标地址族偏好"，目标本身没有对应地址族时系统会自动落到另一族，所以不会把节点搞挂。该能力需要 Node ≥ 17（`ipv4first` 需 Node ≥ 18），低版本面板自动忽略此设置，按系统默认行为走。
- **节点级优先**：单个节点选了"优先 IPv6 / 优先 IPv4"时，面板在转发前先把目标域名按指定地址族解析出来（`dns.resolve6` / `dns.resolve4`），用解析出的 IP 直连，同时把 `Host` 头保留为原始域名，保证源站按域名认人。仅对 `http://` 目标生效，因为 `https://` 要做证书校验（SNI 必须匹配域名），不能偷偷换成 IP。指定地址族连不通时自动回退原域名连接。
- **一键脚本的输出地址**：脚本优先用 `curl -4` 探测公网 IPv4（多个备用服务商），探测不到再用 `curl -6` 探测 IPv6。拿到 IPv6 时自动加上方括号（`http://[2001:db8::1]:3333/`），浏览器才能正确识别；全是内网的环境则退回网卡地址兜底。
- **双栈监听**：`server.listen(PORT)` 不指定地址时，Node 监听系统全部地址（IPv6 双栈、IPv4 自动映射），所以纯 IPv4、纯 IPv6、双栈 VPS 都能打开面板，不会再出现"绑定 0.0.0.0 导致 IPv6 机器打不开"的问题。

---

## License

MIT
