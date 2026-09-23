#!/bin/bash
# Hermes QQ bot 状态报备脚本
# 每5分钟由 launchd 触发，采集在线状态和群聊活跃情况后私聊发给主人
# 异常情况（连接断开、发送失败、假在线）立刻单独告警

API_BASE="http://127.0.0.1:6200"
STATE_ROOT="${HERMES_QQ_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
OWNER_ID="${HERMES_QQ_OWNER_ID:-$(jq -r '.privateChats.ownerUserIds[0] // empty' "$STATE_ROOT/config.json" 2>/dev/null)}"
STATE_FILE="$STATE_ROOT/data/.last_status_state"

if [ -z "$OWNER_ID" ]; then
  echo "No owner QQ configured; skipping status report" >&2
  exit 0
fi

send_msg() {
  local msg="$1"
  curl -sf -X POST "$API_BASE/api/send_private" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg user_id "$OWNER_ID" --arg msg "$msg" '{user_id: $user_id, message: $msg}')" >/dev/null 2>&1
}

# 采集状态
RESPONSE=$(curl -sf --max-time 10 "$API_BASE/api/status" 2>/dev/null)
CURL_OK=$?

if [ $CURL_OK -ne 0 ] || [ -z "$RESPONSE" ]; then
  MSG="【小跟班报备】$(date +%H:%M)
❌ 桥接服务无响应"
  send_msg "$MSG"
  exit 1
fi

# 解析关键字段
ONEBOT=$(echo "$RESPONSE" | jq -r '.health.onebotConnected // false')
QQ_STATUS=$(echo "$RESPONSE" | jq -r '.health.qqLogin.status // "unknown"')
STALE=$(echo "$RESPONSE" | jq -r '.health.onebotStale // false')
SEND_FAIL=$(echo "$RESPONSE" | jq -r '.health.sendFailureActive // false')
SINCE_MSG=$(echo "$RESPONSE" | jq -r '.health.runtime.secondsSinceLastMessage // null')
SINCE_FRAME=$(echo "$RESPONSE" | jq -r '.health.runtime.secondsSinceLastFrame // null')
MSG_INACTIVE=$(echo "$RESPONSE" | jq -r '.health.messageInactive // false')
QUEUED=$(echo "$RESPONSE" | jq '.health.queuedGroups | length')

# --- 异常检测：与上一次状态对比，新异常即时告警 ---
mkdir -p "$(dirname "$STATE_FILE")"

# 读取上次状态
LAST_ONEBOT=""
LAST_STALE=""
LAST_QQ_STATUS=""
LAST_SEND_FAIL=""
if [ -f "$STATE_FILE" ]; then
  source "$STATE_FILE"
fi

# 保存当前状态供下次对比
cat > "$STATE_FILE" <<STATEEOF
LAST_ONEBOT=$ONEBOT
LAST_STALE=$STALE
LAST_QQ_STATUS="$QQ_STATUS"
LAST_SEND_FAIL=$SEND_FAIL
STATEEOF

# 判断是否为新发异常并单独告警
ALERTS=""
# OneBot 从连上变成断开
if [ "$ONEBOT" != "true" ] && [ "$LAST_ONEBOT" = "true" ]; then
  ALERTS="${ALERTS}\n🚨 OneBot 连接断开！"
fi
# 假在线
if [ "$STALE" = "true" ] && [ "$LAST_STALE" != "true" ]; then
  ALERTS="${ALERTS}\n🚨 OneBot 疑似假在线！"
fi
# QQ 登录从正常变为失效
if [ "$QQ_STATUS" = "login_invalid" ] && [ "$LAST_QQ_STATUS" != "login_invalid" ]; then
  ALERTS="${ALERTS}\n🚨 QQ 登录失效！"
fi
if [ "$QQ_STATUS" = "disconnected" ] && [ "$LAST_QQ_STATUS" != "disconnected" ]; then
  ALERTS="${ALERTS}\n🚨 QQ 连接断开！"
fi
# 发送通道异常
if [ "$SEND_FAIL" = "true" ] && [ "$LAST_SEND_FAIL" != "true" ]; then
  ALERTS="${ALERTS}\n🚨 发送通道异常！"
fi

# 如果有新异常，立即单独发告警
if [ -n "$ALERTS" ]; then
  send_msg "⚠️ 异常告警 $(date +%H:%M)${ALERTS}"
fi

# --- 构建常规报备 ---
# 构建在线状态标签
case "$QQ_STATUS" in
  online)                 QQ_LABEL="✅在线" ;;
  login_invalid)          QQ_LABEL="❌登录失效" ;;
  login_required)         QQ_LABEL="🟡需扫码" ;;
  verification_required)  QQ_LABEL="🟡需验证" ;;
  quick_login)            QQ_LABEL="🔄快速登录中" ;;
  send_failed)            QQ_LABEL="⚠️发消息失败" ;;
  disconnected)           QQ_LABEL="⚪未连接" ;;
  *)                      QQ_LABEL="❓$QQ_STATUS" ;;
esac

if [ "$ONEBOT" = "true" ]; then
  [ "$STALE" = "true" ] && ONEBOT_LABEL="🟡疑似假在线" || ONEBOT_LABEL="🟢已连接"
else
  ONEBOT_LABEL="🔴未连接"
fi

# 构建群聊活跃标签
if [ "$SINCE_MSG" != "null" ] && [ -n "$SINCE_MSG" ]; then
  if [ "$SINCE_MSG" -lt 120 ]; then
    ACTIVE_LABEL="🟢活跃（${SINCE_MSG}秒前有消息）"
  elif [ "$SINCE_MSG" -lt 600 ]; then
    ACTIVE_LABEL="🟡较静（${SINCE_MSG}秒前消息）"
  else
    ACTIVE_LABEL="🔴安静（${SINCE_MSG}秒前消息）"
  fi
  [ "$MSG_INACTIVE" = "true" ] && ACTIVE_LABEL="${ACTIVE_LABEL} ⚠️超时静默"
else
  ACTIVE_LABEL="⚪暂无消息记录"
fi

[ "${QUEUED}" -gt 0 ] && QUEUED_LABEL="${QUEUED}个会话处理中" || QUEUED_LABEL="空闲"

# 拼接报备正文
REPORT="【小跟班报备】$(date +%H:%M)
🤖 在线状态：$QQ_LABEL
🔌 OneBot：$ONEBOT_LABEL
💬 群聊活跃：$ACTIVE_LABEL
📊 队列：$QUEUED_LABEL"

if [ "$SINCE_FRAME" != "null" ] && [ -n "$SINCE_FRAME" ]; then
  REPORT="$REPORT
📡 事件帧：${SINCE_FRAME}秒前"
fi

[ "$SEND_FAIL" = "true" ] && REPORT="$REPORT
⚠️ 发送通道异常"

# 发送常规报备
send_msg "$REPORT"
