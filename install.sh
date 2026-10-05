#!/usr/bin/env bash
# ============================================================
# Emby 反代管理面板（VPS 版）一键安装脚本
# 用法：
#   方式一（GitHub 已上传后）：
#     curl -sSL https://raw.githubusercontent.com/MakkaPakka518/EmbyProxy-VPS/refs/heads/main/install.sh | bash
#   方式二（本地文件）：
#     把 install.sh 和 server.js、panel.html 放同一目录，然后：
#     sudo bash install.sh
# ============================================================
set -e

# ============ 可改配置（按需修改） ============
PORT="${PORT:-3333}"                      # 面板端口（不占用 80/443）
INSTALL_DIR="${INSTALL_DIR:-/opt/emby-proxy}"
# GitHub 发布地址：把下面改成你自己的仓库（上传后一行即可）
GITHUB_RAW="https://raw.githubusercontent.com/MakkaPakka518/EmbyProxy-VPS/refs/heads/main"

# ============ 输出工具 ============
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say(){ echo -e "${GREEN}[一键部署]${NC} $1"; }
warn(){ echo -e "${YELLOW}[提示]${NC} $1"; }
die(){ echo -e "${RED}[错误]${NC} $1"; exit 1; }

echo "=============================================="
echo "  Emby 反代管理面板（VPS 版）一键安装"
echo "=============================================="

# ---------- 1. 检查 root ----------
[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash install.sh"

# ---------- 2. 检查 Node.js（没有则尝试自动安装） ----------
try_install_node() {
  warn "未检测到 Node.js，尝试自动安装（可能需要 1-2 分钟）..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y nodejs >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs >/dev/null 2>&1 || true
  fi
}
if ! command -v node >/dev/null 2>&1; then
  try_install_node
fi
if ! command -v node >/dev/null 2>&1; then
  die "仍未检测到 Node.js，请手动安装后重跑本脚本：
  Debian/Ubuntu:  apt install -y nodejs
  CentOS:         yum install -y nodejs
  或用 nvm 装新版: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && source ~/.bashrc && nvm install 20"
fi
NODE_BIN=$(command -v node)
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
if [ "${NODE_MAJOR:-0}" -lt 12 ]; then
  die "Node 版本过低（当前 v$NODE_MAJOR），需要 ≥ 12。建议升级到 v20：
  Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
  或用 nvm:      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && source ~/.bashrc && nvm install 20"
fi
say "Node.js 正常：$NODE_BIN (v$NODE_MAJOR)"

# ---------- 3. 准备目录与程序文件 ----------
mkdir -p "$INSTALL_DIR/data"
cd "$INSTALL_DIR"

say "正在从 GitHub 拉取最新版 server.js / panel.html ..."
curl -fsSL --connect-timeout 10 "$GITHUB_RAW/server.js"  -o server.js.tmp  || true
curl -fsSL --connect-timeout 10 "$GITHUB_RAW/panel.html" -o panel.html.tmp || true
if [ -s server.js.tmp ] && [ -s panel.html.tmp ]; then
  mv -f server.js.tmp server.js
  mv -f panel.html.tmp panel.html
  say "已更新到最新版（覆盖旧文件，配置与节点数据不受影响）"
else
  rm -f server.js.tmp panel.html.tmp
  if [ -s server.js ] && [ -s panel.html ]; then
    warn "GitHub 拉取失败，改用本目录已有 server.js / panel.html（版本可能偏旧）"
  else
    die "GitHub 下载失败。请把 server.js、panel.html 与 install.sh 放在同一目录再运行，
  或修改脚本顶部的 GITHUB_RAW 为你的仓库地址"
  fi
fi
say "程序文件就绪：$INSTALL_DIR/server.js / panel.html"

# ---------- 4. 初始化配置（已存在则保留，可用于升级） ----------
if [ -f data/config.json ]; then
  warn "已有 config.json，保留现有配置（密钥/订阅者/域名不变）"
else
  ADMIN_TOKEN=$(openssl rand -hex 16 2>/dev/null || (head -c 16 /dev/urandom | od -An -tx1 | tr -d ' '))
  cat > data/config.json <<EOF
{
  "adminToken": "$ADMIN_TOKEN",
  "adminPass": null,
  "subscribers": [],
  "frontendDomain": "",
  "backendDomain": ""
}
EOF
  echo '[]' > data/routes.json
  say "已生成随机管理密钥并写入 config.json"
fi

# ---------- 5. 注册 systemd 服务 ----------
cat > /etc/systemd/system/emby-proxy.service <<EOF
[Unit]
Description=Emby Proxy Manager (VPS)
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
Environment=PORT=$PORT
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now emby-proxy >/dev/null 2>&1
sleep 1
say "systemd 服务已注册并启动（开机自启 + 崩溃自动重启）"

# ---------- 6. 验证并输出结果 ----------
# 纯 IPv6 机器没有 127.0.0.1，两种回环都试一遍
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/" 2>/dev/null \
  || curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://[::1]:$PORT/" 2>/dev/null || echo 000)
if [ "$HTTP_CODE" = "200" ]; then
  # 优先探测公网 IPv4；没有 IPv4 的机器再探测 IPv6（链尾 || true 防止 set -e 误退出）
  PUBLIC_IP=$(curl -4 -s --noproxy '*' --connect-timeout 5 https://ifconfig.me 2>/dev/null \
    || curl -4 -s --noproxy '*' --connect-timeout 5 https://ip.sb 2>/dev/null \
    || curl -4 -s --noproxy '*' --connect-timeout 5 https://api.ipify.org 2>/dev/null \
    || curl -4 -s --noproxy '*' --connect-timeout 5 https://ipv4.icanhazip.com 2>/dev/null || true)
  if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP=$(curl -6 -s --noproxy '*' --connect-timeout 5 https://ifconfig.me 2>/dev/null \
      || curl -6 -s --noproxy '*' --connect-timeout 5 https://api6.ipify.org 2>/dev/null \
      || curl -6 -s --noproxy '*' --connect-timeout 5 https://ipv6.icanhazip.com 2>/dev/null || true)
    if [ -n "$PUBLIC_IP" ]; then
      # IPv6 地址必须带方括号，浏览器才能访问
      PUBLIC_IP="[$PUBLIC_IP]"
    fi
  fi
  # 外网探测全部失败时，退而给本机网卡地址（可能为内网，仅供参考）
  if [ -z "$PUBLIC_IP" ]; then
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ -n "$LOCAL_IP" ]; then
      case "$LOCAL_IP" in *:*) PUBLIC_IP="[$LOCAL_IP]";; *) PUBLIC_IP="$LOCAL_IP";; esac
    fi
  fi
  [ -z "$PUBLIC_IP" ] && PUBLIC_IP="你的服务器IP"
  echo ""
  echo "=============================================="
  echo -e "${GREEN}  部署成功！${NC}"
  echo "=============================================="
  echo ""
  echo "  面板地址： http://$PUBLIC_IP:$PORT/"
  if [ -n "$ADMIN_TOKEN" ]; then
    echo "  管理密钥： $ADMIN_TOKEN   （请立即记下，登录面板用）"
  else
    echo "  管理密钥： 在 $INSTALL_DIR/data/config.json 的 adminToken 字段"
  fi
  echo ""
  echo "  常用命令："
  echo "    重启面板   systemctl restart emby-proxy"
  echo "    查看日志   journalctl -u emby-proxy -f"
  echo ""
  echo "  使用建议：登录面板后先到「账户」里设置网页密码，"
  echo "  并在「反代节点」中添加你的 Emby 节点。"
  echo "=============================================="
else
  die "面板启动异常（HTTP $HTTP_CODE），请执行 journalctl -u emby-proxy -n 30 查看日志"
fi
