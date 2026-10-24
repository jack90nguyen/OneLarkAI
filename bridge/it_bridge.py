"""Cầu nối account Lark cá nhân (it@) ↔ OneLark, qua giao thức Lark web của package larkx.

  serve --owners <id,...>   Giữ WebSocket; mỗi tin của owner in 1 dòng JSON ra stdout,
                            nhận lệnh JSON (history / messages / send / download) từ stdin, trả kết quả ra stdout.
  send --chat <id> [--reply-to <msg_id>] [--thread <root_id>]
                            Gửi 1 tin (nội dung đọc từ stdin) rồi thoát — dùng cho `onelark report`.

stdout chỉ dành cho JSON; log của larkx (loguru) đi stderr.
"""
import argparse
import asyncio
import json
import os
import re
import sys
import threading
from datetime import datetime

from larkx import AuthExpired, LarkAuth, LarkClient, media
from loguru import logger
from larkx.proto import builders, decoders
from larkx.proto import proto_pb2 as P
from larkx.proto.ids import generate_long_request_id

_out_lock = threading.Lock()

IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def emit(obj: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def clean_text(text: str) -> str:
    """Bỏ nhãn tiếng Trung của larkx: tiền tố [富文本] của tin post, [图片] imageKey=… → [ảnh]."""
    text = re.sub(r"^\[富文本\]\s*", "", text or "")
    return re.sub(r"\[图片\](?: imageKey=\S+ \([^)]*\)(?: 已加密)?)?", "[ảnh]", text).strip()


def _varint(b: bytes, i: int) -> tuple:
    n = shift = 0
    while True:
        x = b[i]
        i += 1
        n |= (x & 0x7F) << shift
        if x < 0x80:
            return n, i
        shift += 7


def pb_string(b: bytes, field: int) -> str:
    """Đọc 1 field string từ protobuf thô — proto của larkx không có schema cho ảnh trong rich text."""
    i = 0
    while i < len(b):
        tag, i = _varint(b, i)
        wt = tag & 7
        if wt == 0:
            _, i = _varint(b, i)
        elif wt == 1:
            i += 8
        elif wt == 5:
            i += 4
        elif wt == 2:
            n, i = _varint(b, i)
            if tag >> 3 == field:
                return b[i:i + n].decode()
            i += n
        else:
            return ""
    return ""


class Bridge:
    def __init__(self, client: LarkClient):
        self.client = client
        self.me = str(client.auth.user_id)
        self._names: dict = {}

    # ─── Đọc ──────────────────────────────────────────────────────────────

    def sender_name(self, user_id: str, chat_id: str) -> str:
        key = (user_id, chat_id)
        if key not in self._names:
            self._names[key] = self.client.get_user_name(user_id, chat_id) or user_id
        return self._names[key]

    def chat_name(self, chat_id: str, chat_type: int, sender: str) -> str:
        if chat_type == 1:
            return sender
        if chat_id not in self._names:
            self._names[chat_id] = self.client.get_group_name(chat_id) or chat_id
        return self._names[chat_id]

    @staticmethod
    def mentions(content_data) -> list:
        """userId của các @mention trong rich text."""
        rich = (content_data or {}).get("richText") or {}
        out = []
        for el in ((rich.get("elements") or {}).get("dictionary") or {}).values():
            if el.get("tag") != 5 or not el.get("property"):
                continue
            ap = P.AtProperty()
            ap.ParseFromString(el["property"])
            out.append({"user_id": ap.userId, "text": ap.content})
        return out

    @staticmethod
    def image_keys(msg_type: int, content_data) -> list:
        """imageKey của tin ảnh (type 5) hoặc các ảnh dán trong tin post (type 2, element tag 2 → field 2)."""
        if msg_type == 5:
            key = media.extract_resource_key(5, content_data or {})
            return [key] if key else []
        if msg_type != 2:
            return []
        rich = (content_data or {}).get("richText") or {}
        keys = []
        for el in ((rich.get("elements") or {}).get("dictionary") or {}).values():
            if el.get("tag") != 2 or not el.get("property"):
                continue
            try:
                key = pb_string(el["property"], 2)
            except Exception as e:
                logger.warning(f"Không đọc được imageKey trong tin post: {e}")
                continue
            if key:
                keys.append(key)
        return keys

    def line(self, v: dict, chat_id: str) -> dict:
        """Tin thô (protobuf → dict) của API pull → dòng bối cảnh."""
        mt = decoders.enum_to_int(v.get("type", 0))
        text, data = decoders.decode_message_content(mt, v.get("content", b""))
        from_id = str(v.get("fromId") or "")
        ts = v.get("createTime")
        return {
            "msg_id": v.get("id"),
            "sender": self.sender_name(from_id, chat_id) if from_id else "?",
            "is_me": from_id == self.me,
            "text": clean_text(text),
            "image_keys": self.image_keys(mt, data),
            "time": datetime.fromtimestamp(int(ts)).strftime("%d/%m/%Y %H:%M:%S") if ts else "",
            "position": v.get("position"),
            "thread_position": v.get("threadPosition"),
        }

    def by_ids(self, chat_id: str, ids: list) -> list:
        resp = self.client.api("messages.PullMessagesByIdsRequest", {"messageIds": [str(i) for i in ids]})
        return [self.line(v, chat_id) for v in ((resp or {}).get("messages") or {}).values()]

    def history(self, chat_id: str, msg_id: str, count: int, thread_id: str = "") -> dict:
        """N tin trước msg_id (tính cả nó): trong thread nếu có thread_id, ngược lại ở chat chính.
        Tin trong thread không nằm trong position của chat chính → phải đọc riêng theo threadPosition."""
        cur = next(iter(self.by_ids(chat_id, [msg_id])), None)
        if not cur:
            return {"root": None, "lines": []}
        if thread_id:
            end = int(cur.get("thread_position") or 0)
            resp = self.client.api(
                "thread.PullThreadMessagesByPositionsRequest",
                {"threadId": thread_id, "positions": list(range(max(0, end - count + 1), end + 1))},
            )
            raw = ((resp or {}).get("messages") or {}).values()
            root = next(iter(self.by_ids(chat_id, [thread_id])), None)
        else:
            end = int(cur.get("position") or 0)
            resp = self.client.api(
                "messages.PullMessagesByPositionsRequest",
                {"chatId": chat_id, "positions": list(range(max(1, end - count + 1), end + 1))},
            )
            raw = ((resp or {}).get("messages") or {}).values()
            root = None
        lines = sorted((self.line(v, chat_id) for v in raw), key=lambda l: int(l["thread_position" if thread_id else "position"] or 0))
        return {"root": root, "lines": lines}

    def download(self, chat_id: str, msg_id: str, key: str, out_dir: str) -> str:
        """Tải ảnh của tin về out_dir — server trả về ảnh đã giải mã, đuôi file theo content-type."""
        url = media.message_resource_url(msg_id, key, chat_id, host=self.client.auth.region.file_host)
        buf, content_type = media.download(self.client.auth, url, max_bytes=MAX_IMAGE_BYTES)
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, os.path.basename(key) + IMAGE_EXT.get(content_type.split(";")[0].strip(), ""))
        with open(path, "wb") as f:
            f.write(buf)
        return path

    # ─── Gửi ──────────────────────────────────────────────────────────────

    def send(self, chat_id: str, text: str, reply_to: str = "", thread: str = "") -> str:
        """thread → reply trong thread; reply_to → quote tin đó ở chat chính; không có → tin thường."""
        if thread:
            msg_id = self.client.send_msg(text, chat_id, root_id=thread)
            if not msg_id:
                raise RuntimeError("Gửi tin vào thread thất bại (xem log larkx)")
            return msg_id
        pkt = builders.build_send_message_packet(text, str(chat_id), generate_long_request_id())
        if reply_to:
            # Quote ở chat chính = có rootId/parentId nhưng KHÔNG có isReplyInThread
            req = P.PutMessageRequest()
            req.ParseFromString(pkt.payload)
            req.rootId = req.parentId = str(reply_to)
            pkt.payload = req.SerializeToString()
        msg_id = builders.decode_put_message_response(self.client._gateway_post(pkt))
        if not msg_id:
            raise RuntimeError("Lark không trả về message id sau khi gửi")
        return msg_id

    # ─── serve ────────────────────────────────────────────────────────────

    def handle(self, cmd: dict) -> None:
        req_id = cmd.get("id")
        try:
            op = cmd.get("op")
            if op == "history":
                data = self.history(cmd["chat_id"], cmd["msg_id"], int(cmd.get("count", 30)), cmd.get("thread_id", ""))
            elif op == "messages":
                data = self.by_ids(cmd["chat_id"], cmd["ids"])
            elif op == "send":
                data = {"msg_id": self.send(cmd["chat_id"], cmd["text"], cmd.get("reply_to", ""), cmd.get("thread", ""))}
            elif op == "download":
                data = {"path": self.download(cmd["chat_id"], cmd["msg_id"], cmd["key"], cmd["dir"])}
            else:
                raise ValueError(f"op không hỗ trợ: {op}")
            emit({"type": "result", "id": req_id, "ok": True, "data": data})
        except AuthExpired as e:
            emit({"type": "result", "id": req_id, "ok": False, "error": str(e)})
            emit({"type": "auth_expired", "reason": str(e)})
        except Exception as e:
            emit({"type": "result", "id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"})

    def read_stdin(self) -> None:
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                cmd = json.loads(raw)
            except json.JSONDecodeError:
                continue
            # Mỗi lệnh một thread: gửi tin không phải chờ lệnh history đang chạy của chat khác
            threading.Thread(target=self.handle, args=(cmd,), daemon=True).start()
        # stdin đóng = daemon đã chết → thoát theo, không để WS mồ côi
        os._exit(0)

    @staticmethod
    def thread_id(msg: dict) -> str:
        """larkx gắn scope=topic cho mọi tin có root_id, kể cả quote ở chat chính.
        Tin trong thread không có position ở chat chính (âm, vd -3) → dùng để tách hai loại."""
        if msg.get("scope") != "topic":
            return ""
        if msg.get("root_id") and int(msg.get("position") or 0) >= 0:
            return ""  # quote-reply ở chat chính
        return msg.get("anchor") or ""

    async def on_message(self, msg: dict, owners: set) -> None:
        from_id = str(msg.get("from_id") or "")
        if from_id not in owners:
            return  # tin của người khác không rời khỏi bridge
        chat_id = str(msg["chat_id"])
        sender = await asyncio.to_thread(self.sender_name, from_id, chat_id)
        chat_type = int(msg.get("chat_type") or 0)
        mentions = self.mentions(msg.get("content_data"))
        text = clean_text(msg.get("content") or "")
        for m in mentions:
            if m["user_id"] == self.me and m["text"]:
                text = text.replace(m["text"], "", 1)
        emit({
            "type": "message",
            "msg_id": msg["msg_id"],
            "chat_id": chat_id,
            "chat_type": chat_type,
            "chat_name": await asyncio.to_thread(self.chat_name, chat_id, chat_type, sender),
            "from_id": from_id,
            "sender_name": sender,
            "msg_type": msg.get("msg_type_name") or "",
            "text": text.strip(),
            "image_keys": self.image_keys(decoders.enum_to_int(msg.get("msg_type", 0)), msg.get("content_data")),
            "mentions_me": bool(msg.get("at_me")) or any(m["user_id"] == self.me for m in mentions),
            "thread_id": self.thread_id(msg),
            "parent_id": msg.get("parent_id") or "",
            "create_time": int(msg.get("create_time") or 0),
        })


async def serve(owners: set) -> int:
    try:
        client = LarkClient(LarkAuth())
    except AuthExpired as e:
        emit({"type": "auth_expired", "reason": str(e)})
        return 2
    bridge = Bridge(client)
    emit({"type": "ready", "user_id": bridge.me})
    threading.Thread(target=bridge.read_stdin, daemon=True).start()
    while True:
        try:
            await client.connect_websocket(lambda m: bridge.on_message(m, owners))
        except AuthExpired as e:
            emit({"type": "auth_expired", "reason": str(e)})
            return 2
        except Exception as e:
            print(f"[it_bridge] WS lỗi, 10s sau nối lại: {e}", file=sys.stderr, flush=True)
        await asyncio.sleep(10)


def send_once(args) -> int:
    text = sys.stdin.read().strip()
    if not text:
        print("Thiếu nội dung (stdin)", file=sys.stderr)
        return 1
    try:
        bridge = Bridge(LarkClient(LarkAuth()))
        emit({"msg_id": bridge.send(args.chat, text, args.reply_to or "", args.thread or "")})
        return 0
    except Exception as e:
        print(f"Gửi thất bại: {e}", file=sys.stderr)
        return 1


def main() -> int:
    p = argparse.ArgumentParser(prog="it_bridge")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--owners", required=True, help="user id nội bộ của owner, cách nhau bởi dấu phẩy")
    s2 = sub.add_parser("send")
    s2.add_argument("--chat", required=True)
    s2.add_argument("--reply-to")
    s2.add_argument("--thread")
    args = p.parse_args()
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    if args.cmd == "serve":
        owners = {o.strip() for o in args.owners.split(",") if o.strip()}
        return asyncio.run(serve(owners))
    return send_once(args)


if __name__ == "__main__":
    sys.exit(main())
