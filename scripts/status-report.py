#!/usr/bin/env python3
"""
旧版状态报备，由 launchd 调用（频率以实际 plist 为准）。
通知中心启用或策略不可确认时不发送；--dry-run 仅输出安全健康摘要。
内容：bot在线状态 + 群聊活跃情况
"""

import json
import os
import sys
import urllib.request
import re
from datetime import datetime

BRIDGE_URL = "http://127.0.0.1:6200"
STATE_ROOT = os.environ.get("HERMES_QQ_HOME", os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
CONFIG_PATH = os.path.join(STATE_ROOT, "config.json")
POLICY_PATH = "/api/owner/notification-policy"


def legacy_status(state, delivery_allowed=False, **summary):
    print(json.dumps({"source": "legacy-status-report", "script": "python",
                      "state": state, "deliveryAllowed": delivery_allowed,
                      **summary}, ensure_ascii=False))


def legacy_delivery_allowed():
    # Missing/old endpoints and malformed responses are NOT permission to send.
    # Never fetch an admin session or fall back to local config for this decision.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    try:
        req = urllib.request.Request(f"{BRIDGE_URL}{POLICY_PATH}",
                                     headers={"Accept": "application/json"})
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=5) as resp:
            raw = resp.read(4097)
            policy = json.loads(raw) if resp.status == 200 and len(raw) <= 4096 else None
        if not isinstance(policy, dict) or type(policy.get("centralized")) is not bool:
            raise ValueError("invalid notification policy")
    except Exception:
        legacy_status("policy_unavailable")
        return False
    if policy["centralized"]:
        legacy_status("centralized")
        return False
    return True


def owner_user_id():
    explicit = os.environ.get("HERMES_QQ_OWNER_ID", "").strip()
    if explicit:
        return explicit
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as handle:
            config = json.load(handle)
        owners = config.get("privateChats", {}).get("ownerUserIds", [])
        return str(owners[0]) if owners else ""
    except Exception:
        return ""


def http_get(path):
    url = f"{BRIDGE_URL}{path}"
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}


def http_post(path, data):
    if not legacy_delivery_allowed():
        return {"error": "legacy delivery blocked by notification policy"}
    url = f"{BRIDGE_URL}{path}"
    body = json.dumps({**data, "source": "legacy-status-report"}).encode()
    try:
        token = http_get("/api/admin/session").get("token")
        if not token:
            return {"error": "admin session unavailable"}
        # Recheck after the auth await; the center may have been enabled meanwhile.
        if not legacy_delivery_allowed():
            return {"error": "legacy delivery blocked by notification policy"}
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "Origin": BRIDGE_URL,
                     "x-hermes-qq-admin": token},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        return {"error": str(e)}


def extract_group_activity(health):
    """Extract recent group activity from health data."""
    qq_login = health.get("qqLogin", {})
    recent = qq_login.get("recent", [])

    # Parse recent events to find group message activity
    active_groups = {}  # group_id -> count
    for event in recent:
        # Pattern: 接收 <- 群聊 [group_name(group_id)] [sender] msg
        m = re.search(r'群聊 \[[^\]]*\((\d+)\)\]', event)
        if m:
            gid = m.group(1)
            active_groups[gid] = active_groups.get(gid, 0) + 1

    # Also look through status logs
    runtime = health.get("runtime", {})
    seconds_since_msg = runtime.get("secondsSinceLastMessage")
    seconds_since_frame = runtime.get("secondsSinceLastFrame")

    return active_groups, seconds_since_msg, seconds_since_frame


def main():
    if not legacy_delivery_allowed():
        return
    if "--dry-run" in sys.argv[1:]:
        health = http_get("/health")
        legacy_status("dry_run", bridgeReachable="error" not in health,
                      onebotConnected=health.get("onebotConnected") is True,
                      healthy=health.get("ok") is True)
        return
    legacy_status("legacy_allowed", delivery_allowed=True)
    owner_id = owner_user_id()
    if not owner_id:
        print("No owner QQ configured; skipping status report", file=sys.stderr)
        return
    health = http_get("/health")

    if "error" in health:
        # Bridge might be down
        report = f"[跟班报备] {datetime.now().strftime('%H:%M')}\n🔴 桥接离线 - {health['error']}"
        result = http_post("/api/send_private", {
            "user_id": owner_id,
            "message": report,
        })
        if result.get("ok"):
            print(f"Offline status sent: {report}")
        else:
            print(f"Send failed (bridge down?): {result}", file=sys.stderr)
        return

    # --- Bot online status ---
    ok = health.get("ok", False)
    onebot_connected = health.get("onebotConnected", False)
    onebot_stale = health.get("onebotStale", False)
    qq_login = health.get("qqLogin", {})
    qq_status = qq_login.get("status", "unknown")
    qq_needs_login = qq_login.get("needsLogin", False)
    send_failure = health.get("sendFailureActive", False)

    if ok:
        online_icon = "✅"
        online_text = "在线"
    elif onebot_connected and not qq_needs_login and not send_failure:
        online_icon = "⚠️"
        online_text = f"连接但旧 ({qq_status})"
    elif qq_needs_login:
        online_icon = "🔴"
        online_text = "需要登录"
    elif send_failure:
        online_icon = "❌"
        online_text = "发送异常"
    elif not onebot_connected:
        online_icon = "⚫"
        online_text = "OneBot未连接"
    else:
        online_icon = "⚫"
        online_text = f"离线 ({qq_status})"

    # --- Group activity ---
    active_groups, sec_since_msg, sec_since_frame = extract_group_activity(health)

    activity_parts = []
    if active_groups:
        group_count = len(active_groups)
        activity_parts.append(f"活跃群 {group_count}个")
    if sec_since_msg is not None:
        if sec_since_msg < 120:
            activity_parts.append(f"最新消息 {sec_since_msg}s前")
        else:
            mins = sec_since_msg // 60
            activity_parts.append(f"最新消息 {mins}分钟前")
    else:
        activity_parts.append("暂无消息记录")

    if sec_since_frame is not None:
        activity_parts.append(f"距上帧 {sec_since_frame}s")

    activity_text = " | ".join(activity_parts)

    # --- Last event preview ---
    recent = qq_login.get("recent", [])
    last_event = recent[-1] if recent else ""
    # Shorten the last event to something readable
    if last_event:
        # Extract just the meaningful part after the timestamp
        last_event_short = re.sub(r'^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[info\]\s+', '', last_event)
        if len(last_event_short) > 30:
            last_event_short = last_event_short[:27] + "..."
    else:
        last_event_short = ""

    # Build 2-line report
    now_str = datetime.now().strftime('%H:%M')
    report = f"[跟班报备 {now_str}]\n{online_icon} {online_text}\n💬 {activity_text}"

    # Send to the configured owner.
    result = http_post("/api/send_private", {
        "user_id": owner_id,
        "message": report,
    })

    if result.get("ok"):
        print(f"Status sent OK: {report}")
    else:
        print(f"Send failed: {result.get('error', 'unknown')}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
