# OneLark AI

Cầu nối **Lark Bot ↔ Claude Code**: nhắn hoặc @mention bot trên Lark để giao việc. Brain (một session Claude Code chạy headless trên máy này) tự xử lý, hoặc giao cho session đang mở trong cmux, rồi gửi báo cáo tóm tắt về Lark.

```
 Lark: DM / @bot trong nhóm
        │ WebSocket long-connection (không cần public URL)
        ▼
 daemon ── lọc OWNER_OPEN_IDS ── react OnIt ── gom bối cảnh
        │ queue tuần tự theo chat
        ▼
 Brain = Agent SDK query() sống lâu, 1 session / 1 chat
        ├─ tự làm → trả lời tóm tắt
        └─ onelark delegate → cmux agent message → ws project
                                   │ xong
                                   ▼
                        onelark report → reply về Lark
```

## Kiến trúc

| File | Vai trò |
|---|---|
| `src/daemon.ts` | Nhận event, guard allowlist, command, queue theo chat |
| `src/brain.ts` | Mỗi chat một process Claude Code (Agent SDK, streaming input). Lưu `session_id` vào SQLite nên restart hay idle-close vẫn resume được |
| `src/context.ts` | Gom bối cảnh: cả thread / N tin gần nhất của nhóm / tin được quote |
| `src/lark.ts` | Lark SDK: WSClient, reply markdown (post `md`), reaction, list message |
| `src/prompt.ts` | Rules append vào system prompt (preset `claude_code`); CLAUDE.md, skills, MCP của anh vẫn load bình thường |
| `src/cli.ts` | `delegate` / `report` / `tasks`, dùng cho Brain và session worker |
| `src/store.ts` | SQLite (`node:sqlite`): chat→session, task, dedup event |

So với ONEBOT (adapter ACP, 1 session chung):

- Gọi thẳng Agent SDK, bớt một lớp JSON-RPC.
- Mỗi chat Lark có session riêng.
- Session còn nguyên sau restart.
- Task nền chạy xong thì tự báo về chat.

## Setup bot Lark

1. Vào [open.larksuite.com/app](https://open.larksuite.com/app), tạo **Custom App**, bật **Bot**.
2. **Permissions & Scopes**: thêm các quyền dưới đây (search theo tên trên console):
   - Nhận tin DM gửi bot: `im:message.p2p_msg:readonly`
   - Nhận tin @bot trong nhóm: `im:message.group_at_msg:readonly`
   - Gửi / reply tin: `im:message`
   - Đọc lịch sử nhóm làm bối cảnh: `im:message.group_msg`, `im:message:readonly`
   - Reaction: `im:message.reactions:write_only`
   - Lấy tên nhóm: `im:chat:readonly`
3. **Events & Callbacks**: chọn chế độ **long connection** (nhận event qua WebSocket), thêm event `im.message.receive_v1`.
4. **Publish** một version để app có hiệu lực, rồi thêm bot vào các nhóm cần dùng.

## Chạy

```bash
cp .env.example .env     # điền LARK_APP_ID, LARK_APP_SECRET
npm install
npm start                # nên chạy trong 1 workspace cmux riêng để xem log
```

Lần đầu chưa có `OWNER_OPEN_IDS`: DM bot một tin, bot sẽ trả về open_id của anh (open_id **khác nhau theo từng app**). Điền vào `.env` rồi restart. Khi chưa cấu hình allowlist, bot không chạy bất kỳ lệnh nào.

## Dùng trên Lark

- DM bot hoặc `@OneLark <việc cần làm>` trong nhóm. Mention trong thread thì bot đọc cả thread, ngoài thread thì đọc `GROUP_CONTEXT_LIMIT` tin gần nhất.
- `/new`: bắt đầu session mới · `/stop`: dừng lượt đang chạy · `/status`: xem session id và task · `/help`
- Muốn mở session của Brain trong terminal: `cd brain && claude --resume <session_id>` (lấy id qua `/status`). Đừng mở song song lúc bot đang xử lý cùng session đó.

## Bảo mật

Brain chạy `bypassPermissions`: ai ra lệnh được cho Brain là chạy được lệnh trên máy này. Daemon chỉ nhận tin từ `OWNER_OPEN_IDS`. Tin của người khác trong `<context>` được đánh dấu là dữ liệu tham khảo, không phải lệnh.
