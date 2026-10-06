# Emby 反代管理面板（VPS 版）

> 由 VPS 托管版本的emby反代管理面板。零依赖 Node 实现，**不占用 80/443 端口**，支持**前后端分离**（前端登录域名与后端推流域名不同），只反代前端域名也能自动识别并反代后端推流。
- **节点列表自动展示延迟**：每个节点卡片自动测速并实时显示延迟，点击徽章可重新测速
- **节点图标**：内置 TFEL Emby 图标库，添加/编辑节点时可搜索选择
- **源站保护**：节点源站地址默认隐藏（点击才可查看），**订阅用户不可见源站地址**，也无测速权限
- **播放统计图**：Chart.js 图表 —— 过去 7 天播放趋势折线 + 今日各节点播放柱状图
- **部署**：单文件 `server.js` + 单文件 `panel.html`，零依赖，systemd 常驻

---

## 特性一览

| 能力 | 说明 |
| --- | --- |
| 端口 | 默认 `3333`可自定义，不占用 80/443 |
| 认证 | 三档：管理员密钥 `ADMIN_TOKEN` > 网页密码（可选）> 订阅者密钥 |
| 节点反代 | 前缀路由表：`/xxx/**` → 目标地址，多目标逗号分隔自动 failover |
| 前后端分离 | 只需填/反代**前端域名**，媒体源站自动识别并回源推流 |
| URL 双形式改写 | 已知源站 → 同源简洁形式；未知媒体源站 → 携带完整源站 URL 的绝对回源形式 |
| `/emby` 前缀回退 | 目标对不上时自动尝试 `目标地址/emby/...` |
| 伪造请求头 | 每节点可选 `strict` / `dual` / `realip_only` / `off` 模式（Origin / Referer / X-Real-IP） |
| WebSocket | 升级请求透明透传 |
| 静态资源缓存 | 图片等静态资源缓存提速；带鉴权态的请求不缓存，防止串号 |
| 自动测速 | 节点列表加载后自动 ping 全部节点并展示延迟，点击徽章重新测速，支持一键全部测速（仅管理员） |
| 节点图标 | 内置 TFEL 图标库（528 个），添加节点时搜索选择，卡片显示对应图标 |
| 源站保护 | 管理员：源站链接默认隐藏，点击"点击查看"展开；订阅者：源站完全不可见，且无测速权限 |
| 拖拽排序 | 节点卡片可拖拽排序，自动保存 |
| 播放统计 | 仅按 `/PlaybackInfo` 播放点火计数，按节点/天聚合；Chart.js 展示 7 天趋势折线图 + 今日各节点柱状图 |
| 管理功能 | 节点增删改、多线路动态添加、订阅者管理、导入导出备份、缓存清理 |

---

## 目录结构

```
emby-proxy/
├── server.js          # 主程序（零依赖，仅用 Node 原生模块）
├── panel.html         # 管理面板前端（iOS 风格）
├── data/
│   ├── config.json    # 管理员密钥 / 网页密码 / 订阅者 / 前后端域名
│   ├── routes.json    # 反代节点路由表
│   └── stats.json     # 播放统计
└── test-upstream.js   # （可选）本地模拟 Emby 源站，用于自测
```

---

## 部署

### 方式一：一键脚本（推荐）

```bash
curl -sSL https://raw.githubusercontent.com/MakkaPakka518/EmbyProxy-VPS/refs/heads/main/install.sh | bash
```

脚本自动完成全部步骤：检测 Node.js → 下载程序文件 → 生成随机管理密钥或者自定义密钥 → 初始化配置 → 注册 systemd（开机自启 + 崩溃自动重启）→ 验证面板 → 输出面板地址和管理密钥。

跑完记下输出的**面板地址**和**管理密钥**，浏览器打开 `http://服务器IP:端口/` 输入密钥即可登录。已安装过再跑一遍会保留原有配置，可当升级用。

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

任意 Node.js ≥ 12（已实测 v22），零依赖，无需 `npm install`。

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

浏览器打开 `http://你的IP:端口/`，输入管理员密钥登录。

### 添加反代节点

点击「添加节点」：

| 字段 | 说明 |
| --- | --- |
| 节点备注 | 可选，便于识别 |
| 短路径前缀 | 访问路径，如 `emby` → `http://IP:端口/emby/**` 反代到目标 |
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

## API 速查

```
POST /api/login            {"token":"..."}        登录
POST /api/logout           —                      登出
GET  /api/me               —                      当前角色
POST /api/account          {"password":"..."}     设置/修改网页密码（空串清除）
GET  /api/routes           —                      节点列表（订阅者视角 target 打码为 "***"）
POST /api/routes           {prefix,target,mode,cache_img,icon}   新增/更新
DELETE /api/routes         ?prefix=...            删除
POST /api/routes/reorder   {items:[{prefix,sort_order}]}    排序
GET  /api/routes/export    —                      导出备份
POST /api/routes/import    (body=导出备份内容)     导入备份
GET/POST /api/subscribers  — / {"action":"add"|"del","password":"..."}
GET/POST /api/config       — 前后端域名等配置
GET  /api/analytics        —                      播放统计（含 trend：过去 7 天）
GET  /api/ping-node        ?url=...               节点测速（仅管理员）
POST /api/purge-cache      —                      清理缓存
```

---

## 常用运维

重启 / 停止 / 看日志等常用命令都在上文"常见问题排查"的表里，不再重复。

- **改端口**：编辑 `server.js` 顶部 `PORT` 常量后 `systemctl restart emby-proxy`
- **改密钥**：编辑 `data/config.json` 的 `adminToken` 后重启
- **升级版本**：用新版 `server.js` / `panel.html` 覆盖 `/opt/emby-proxy/` 里的同名文件，然后 `systemctl restart emby-proxy`（配置和数据都在 `data/`，不会被覆盖）

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

面板启动时把配置读进内存，直接改文件不会自动生效。`systemctl restart` 会先杀掉旧进程、再按新文件拉起，是唯一可靠的重载方式。如果此时再手滑跑一个 `node server.js`，会出现两个进程抢  端口，表现为 `listen EADDRINUSE`。

---

