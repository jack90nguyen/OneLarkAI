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
| `src/context.ts` | Gom bối cảnh: cả thread / N tin gần nhất của nhóm / tin được quote; tải ảnh/file đính kèm về `brain/inbox/` (tự xoá sau 7 ngày) |
| `src/progress.ts` | Card tiến độ cho lượt chạy > 10s, cập nhật tại chỗ ~3s/lần |
| `src/lark.ts` | Lark SDK: WSClient, reply markdown (post `md`) / card / file, reaction, list message, tải resource |
| `src/prompt.ts` | Rules append vào system prompt (preset `claude_code`); CLAUDE.md, skills, MCP của anh vẫn load bình thường |
| `ecosystem.config.cjs` | Cấu hình pm2 |
| `src/cli.ts` | `delegate` / `report` / `send-file` / `tasks`, dùng cho Brain và session worker |
| `src/store.ts` | SQLite (`node:sqlite`): chat→session, task, dedup event |
| `src/it.ts` | Kênh it@: chạy `bridge/it_bridge.py` làm process con, lọc tin, gọi Brain, trả lời dưới tên it@ |
| `bridge/it_bridge.py` | Cầu nối giao thức Lark web (package [larkx](https://github.com/cv-cat/LarkAgentX)): nhận tin qua WS, đọc history / thread, gửi tin. Giao tiếp với daemon bằng NDJSON qua stdin/stdout |

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
   - Tải ảnh/file anh gửi, upload file gửi về: `im:resource`
3. **Events & Callbacks**: chọn chế độ **long connection** (nhận event qua WebSocket), thêm event `im.message.receive_v1`.
4. **Publish** một version để app có hiệu lực, rồi thêm bot vào các nhóm cần dùng.

## Chạy

```bash
cp .env.example .env     # điền LARK_APP_ID, LARK_APP_SECRET
npm install
npm start                # chạy foreground, nên mở trong 1 workspace cmux riêng
```

Chạy nền bằng **pm2**, start từ một terminal **bên trong cmux** (tốt nhất là workspace luôn mở):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs onelark                       # xem log
pm2 restart onelark --update-env       # sau khi sửa .env / code
```

⚠️ Socket của cmux (`socketControlMode = cmuxOnly`) chỉ nhận process mang `CMUX_SOCKET_CAPABILITY`. Token này cmux cấp theo từng workspace; pm2 start từ terminal cmux thì truyền token xuống cho OneLark, nhờ vậy Brain gọi được `cmux` (message / delegate / tree).

- **Restart cmux hoặc reboot máy** làm token chết: bot Lark vẫn chạy nhưng mọi lệnh `cmux` lỗi `Access denied`. Sửa bằng cách chạy `pm2 restart onelark --update-env` từ một terminal trong cmux.
- Đóng workspace đã dùng để start pm2 có thể làm token bị thu hồi (chưa test).

Lần đầu chưa có `OWNER_OPEN_IDS`: DM bot một tin, bot sẽ trả về open_id của anh (open_id **khác nhau theo từng app**). Điền vào `.env` rồi restart. Khi chưa cấu hình allowlist, bot không chạy bất kỳ lệnh nào.

## Dùng trên Lark

- DM bot hoặc `@OneLark <việc cần làm>` trong nhóm. Mention trong thread thì bot đọc cả thread, ngoài thread thì đọc `GROUP_CONTEXT_LIMIT` tin gần nhất.
- Gửi kèm ảnh / file (PDF, log…) hoặc quote tin có ảnh: bot tải về cho Brain đọc.
- Lượt chạy quá 10s sẽ có card `⏳ Đang làm` hiện các bước gần nhất, xong thì card chuyển thành `✅ Xong`.
- Brain / worker gửi file về bằng `node src/cli.ts send-file --msg <id>|--task <id> <path...>`.
- `/new`: bắt đầu session mới · `/stop`: dừng lượt đang chạy · `/status`: xem session id và task · `/help`
- Muốn mở session của Brain trong terminal: `cd brain && claude --resume <session_id>` (lấy id qua `/status`). Đừng mở song song lúc bot đang xử lý cùng session đó.

## Kênh it@ (nhóm external)

Bot của app không vào được nhóm external trên Lark quốc tế. Kênh it@ đăng nhập **account Lark cá nhân** (it@) bằng giao thức của Lark web, qua package [larkx](https://github.com/cv-cat/LarkAgentX) (ghim commit `97ad48e`, cài vào venv riêng, không copy code vào repo vì repo gốc không có license).

- Chỉ xử lý tin của `IT_OWNER_IDS`: **DM trực tiếp cho it@**, hoặc **@it trong nhóm** (kể cả trong thread). Tin của người khác bị lọc ngay trong bridge.
- Trả lời dưới tên it@: tin trong thread thì reply trong thread, còn lại thì quote tin của anh. Chỉ gửi được text thuần.
- Bối cảnh nhóm: `GROUP_CONTEXT_LIMIT` tin gần nhất của chat chính, hoặc của thread kèm tin gốc. Mỗi chat có session Brain riêng (`it:<chat_id>`).
- Chưa có: reaction, progress card, đọc ảnh/file, `send-file`.

Setup (cần Python 3.12, vì SQLAlchemy 2.0.30 của larkx không chạy trên 3.14):

```bash
npm run it:setup    # tạo .venv-it, cài larkx
npm run it:login    # quét QR bằng app Lark của it@ → data/larkx/credentials.json
# .env: IT_OWNER_IDS=<user id nội bộ của anh>  (khác open_id; lấy từ log bridge hoặc lark history)
pm2 restart onelark --update-env   # từ terminal trong cmux
```

Session web hết hạn thì bot PHÈN DEV DM anh nhắc: chạy lại `npm run it:login` rồi restart.

⚠️ Dùng giao thức nội bộ của Lark web (dịch ngược) là vi phạm điều khoản sử dụng, account it@ có thể bị khoá. Cookie trong `data/larkx/` cho toàn quyền vào account, **không được commit**.

## Bảo mật

Brain chạy `bypassPermissions`: ai ra lệnh được cho Brain là chạy được lệnh trên máy này. Daemon chỉ nhận tin từ `OWNER_OPEN_IDS`. Tin của người khác trong `<context>` được đánh dấu là dữ liệu tham khảo, không phải lệnh.
