# QQ 实例探测/唤起探针（sn0wbot 启动器的 sidecar 执行器）
#
# 用法：
#   list          枚举本机已登录的 QQ 账号 -> JSON {instances:[{hwnd,title,account}]}
#   focus <hwnd>  唤起指定窗口（最小化则还原，再抢前台）-> JSON {ok:bool}
#
# 只做执行器（枚举/唤起），决策在 Node 核心（AGENTS.md：sidecar 不做决策）。
# 复用桥接的 qq_uia 模块（账号名取自窗口左栏昵称，与桥接 window_account 同源）：
# 桥接目录 bridges/ 不入库（venv 由安装环节建立），本探针按相对路径找它的 scripts/。
import sys, os, json, ctypes, time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_SCRIPTS = os.path.normpath(os.path.join(HERE, '..', 'bridges', 'qq-onebotv11-uia-bridge', 'scripts'))
sys.path.insert(0, BRIDGE_SCRIPTS)
import qq_uia
import uiautomation as auto

user32 = ctypes.windll.user32


class WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ('length', ctypes.c_uint), ('flags', ctypes.c_uint), ('showCmd', ctypes.c_uint),
        ('ptMinPosition', ctypes.c_long * 2), ('ptMaxPosition', ctypes.c_long * 2),
        ('rcNormalPosition', ctypes.c_long * 4),
    ]


def cmd_list():
    instances = []
    for h, title in qq_uia.find_qq_windows():
        w = qq_uia.QQWindow()
        w.hwnd, w.title = h, title
        try:
            w.win = auto.ControlFromHandle(h)
        except Exception:
            continue
        # 主窗口判别：只有主窗口有「会话列表」pane。独立聊天窗/托盘辅助窗没有，
        # 且它们的 account_nickname 会读到误值（如独立聊天窗把"发送"按钮当账号）
        try:
            if w._pane_by_name(qq_uia.SESSION_LIST_NAME) is None:
                continue
        except Exception:
            continue
        account = ''
        try:
            account = (w.account_nickname() or '').strip()
        except Exception:
            account = ''
        if not account:
            continue
        minimized = bool(user32.IsIconic(h))
        instances.append({'hwnd': int(h), 'title': title, 'account': account, 'minimized': minimized})
    print(json.dumps({'instances': instances}, ensure_ascii=False))


def cmd_focus(hwnd):
    if not user32.IsWindow(hwnd):
        print(json.dumps({'ok': False, 'error': 'window not found'}))
        return
    w = qq_uia.QQWindow()
    w.hwnd, w.title = hwnd, ''
    ok = w.force_foreground()
    print(json.dumps({'ok': bool(ok)}, ensure_ascii=False))


def main():
    args = sys.argv[1:]
    if not args or args[0] == 'list':
        cmd_list()
    elif args[0] == 'focus' and len(args) >= 2:
        cmd_focus(int(args[1], 0))
    else:
        print(json.dumps({'error': 'usage: list | focus <hwnd>'}))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
